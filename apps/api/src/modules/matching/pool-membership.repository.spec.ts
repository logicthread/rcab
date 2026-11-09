import { describe, it, expect, vi } from 'vitest';
import { Constraint } from '../../db/constraints';
import { PoolMembershipRepository, type NewPoolMember } from './pool-membership.repository';

const M: NewPoolMember = {
  poolId: 'pool-1',
  passengerId: 'p-1',
  originLat: 1,
  originLng: 2,
  destLat: 3,
  destLng: 4,
  agreedFareCents: 5_000,
  idempotencyKey: 'k-1',
};

function violation(constraint: string, code = '23505'): Error {
  // drizzle wraps driver errors: the pg fields live on `cause`.
  return Object.assign(new Error('Failed query'), { cause: { code, constraint } });
}

/** A tx whose savepoint INSERT throws `insertError` (or succeeds), then answers SELECTs in order. */
function makeTx(opts: { insertError?: unknown; selects?: unknown[][] } = {}) {
  const values = vi.fn(async () => {
    if (opts.insertError) throw opts.insertError;
  });
  const selects = [...(opts.selects ?? [])];
  const tx = {
    transaction: vi.fn(async (fn: (sp: unknown) => Promise<unknown>) =>
      fn({ insert: vi.fn(() => ({ values })) }),
    ),
    insert: vi.fn(() => ({ values })),
    execute: vi.fn(async () => ({ rows: selects.shift() ?? [] })),
  };
  return { tx, values };
}

const repo = new PoolMembershipRepository();

describe('PoolMembershipRepository.insertMember', () => {
  it('inserts one seat in a savepoint and returns the post-trigger seat_count', async () => {
    const { tx, values } = makeTx({ selects: [[{ seat_count: '2' }]] });
    await expect(repo.insertMember(tx as never, M)).resolves.toEqual({ ok: true, seatCount: 2 });
    expect(tx.transaction).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        poolId: 'pool-1',
        passengerId: 'p-1',
        seats: 1,
        agreedFareCents: 5_000,
        idempotencyKey: 'k-1',
      }),
    );
  });

  it.each([null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses to seat a passenger with an invalid agreed fare (%s)',
    async (bad) => {
      const { tx, values } = makeTx();
      await expect(
        repo.insertMember(tx as never, { ...M, agreedFareCents: bad as unknown as number }),
      ).rejects.toThrow(/invalid agreed fare/);
      expect(values).not.toHaveBeenCalled();
    },
  );

  it.each([
    [Constraint.PoolNotOpen, 'pool_closed'],
    [Constraint.PoolCapacity, 'pool_full'],
  ])('maps %s (23514) to %s', async (constraint, reason) => {
    const { tx } = makeTx({ insertError: violation(constraint, '23514') });
    await expect(repo.insertMember(tx as never, M)).resolves.toEqual({ ok: false, reason });
  });

  it('rethrows unexpected errors and unrelated constraints', async () => {
    const boom = new Error('connection reset');
    await expect(repo.insertMember(makeTx({ insertError: boom }).tx as never, M)).rejects.toBe(
      boom,
    );
    const fk = violation('pool_member_passenger_id_fkey', '23503');
    await expect(repo.insertMember(makeTx({ insertError: fk }).tx as never, M)).rejects.toBe(fk);
  });

  describe('duplicate classification (committed rows decide, constraint is the fallback)', () => {
    it('same idempotency key → idempotent_replay with that seat’s pool', async () => {
      const { tx } = makeTx({
        insertError: violation(Constraint.PoolMemberOneActivePool),
        selects: [[{ pool_id: 'pool-0', idempotency_key: 'k-1', active: true }]],
      });
      await expect(repo.insertMember(tx as never, M)).resolves.toEqual({
        ok: false,
        reason: 'idempotent_replay',
        existingPoolId: 'pool-0',
      });
    });

    it('keyless duplicate in the same pool → already_member', async () => {
      const { tx } = makeTx({
        insertError: violation(Constraint.PoolMemberDuplicate),
        selects: [[{ pool_id: 'pool-1', idempotency_key: null, active: true }]],
      });
      await expect(repo.insertMember(tx as never, { ...M, idempotencyKey: null })).resolves.toEqual(
        {
          ok: false,
          reason: 'already_member',
          existingPoolId: 'pool-1',
        },
      );
    });

    it('a DIFFERENT key for a live seat in the same pool → passenger_has_active_pool (T29)', async () => {
      const { tx } = makeTx({
        insertError: violation(Constraint.PoolMemberDuplicate),
        selects: [[{ pool_id: 'pool-1', idempotency_key: 'k-other', active: true }]],
      });
      await expect(repo.insertMember(tx as never, M)).resolves.toEqual({
        ok: false,
        reason: 'passenger_has_active_pool',
        existingPoolId: 'pool-1',
      });
    });

    it('active seat in another pool → passenger_has_active_pool', async () => {
      const { tx } = makeTx({
        insertError: violation(Constraint.PoolMemberOneActivePool),
        selects: [[{ pool_id: 'pool-9', idempotency_key: null, active: true }]],
      });
      await expect(repo.insertMember(tx as never, M)).resolves.toEqual({
        ok: false,
        reason: 'passenger_has_active_pool',
        existingPoolId: 'pool-9',
      });
    });

    it.each([
      [Constraint.PoolMemberIdempotency, 'k-1', { ok: false, reason: 'idempotent_replay' }],
      [
        Constraint.PoolMemberDuplicate,
        null,
        { ok: false, reason: 'already_member', existingPoolId: 'pool-1' },
      ],
      [Constraint.PoolMemberDuplicate, 'k-1', { ok: false, reason: 'passenger_has_active_pool' }],
      [
        Constraint.PoolMemberOneActivePool,
        null,
        { ok: false, reason: 'passenger_has_active_pool' },
      ],
    ])(
      'falls back to the constraint name (%s, key %s) when no row is visible',
      async (c, key, out) => {
        const { tx } = makeTx({ insertError: violation(c), selects: [[]] });
        await expect(
          repo.insertMember(tx as never, { ...M, idempotencyKey: key }),
        ).resolves.toEqual(out);
      },
    );
  });
});

describe('PoolMembershipRepository reads', () => {
  it('lockPool maps the locked row (and null when missing)', async () => {
    const { tx } = makeTx({
      selects: [
        [
          {
            ride_id: 'pool-1',
            pool_state: 'open',
            seat_count: '1',
            max_seats: '3',
            dispatch_generation: '0',
            state_version: '4',
            claimed_by_driver_id: null,
            origin_lat: '1.5',
            origin_lng: '2.5',
            dest_lat: '3.5',
            dest_lng: '4.5',
          },
        ],
        [],
      ],
    });
    await expect(repo.lockPool(tx as never, 'pool-1')).resolves.toEqual({
      poolId: 'pool-1',
      poolState: 'open',
      seatCount: 1,
      maxSeats: 3,
      dispatchGeneration: 0,
      stateVersion: 4,
      claimedByDriverId: null,
      originLat: 1.5,
      originLng: 2.5,
      destLat: 3.5,
      destLng: 4.5,
    });
    await expect(repo.lockPool(tx as never, 'nope')).resolves.toBeNull();
  });

  it('snapshotPool reads the pool row THEN its members, with no FOR UPDATE (null when missing)', async () => {
    const { tx } = makeTx({
      selects: [
        [
          {
            ride_id: 'pool-1',
            pool_state: 'open',
            seat_count: '1',
            max_seats: '3',
            dispatch_generation: '0',
            state_version: '7',
            claimed_by_driver_id: null,
            origin_lat: '1',
            origin_lng: '2',
            dest_lat: '3',
            dest_lng: '4',
          },
        ],
        [
          {
            passenger_id: 'p-1',
            origin_lat: '1',
            origin_lng: '2',
            dest_lat: '3',
            dest_lng: '4',
            joined_at: new Date('2026-11-06T10:00:00Z'),
          },
        ],
        [],
      ],
    });
    const snap = await repo.snapshotPool(tx as never, 'pool-1');
    expect(snap?.pool).toMatchObject({ poolId: 'pool-1', stateVersion: 7, seatCount: 1 });
    expect(snap?.members.map((m) => m.passenger_id)).toEqual(['p-1']);
    expect(tx.execute).toHaveBeenCalledTimes(2);
    const firstSql = JSON.stringify(tx.execute.mock.calls[0]);
    expect(firstSql).not.toMatch(/FOR UPDATE/i);
    await expect(repo.snapshotPool(tx as never, 'nope')).resolves.toBeNull();
    expect(tx.execute).toHaveBeenCalledTimes(3); // no member read for a missing pool
  });

  it('listMembers maps rows to the SharedRideMember shape', async () => {
    const { tx } = makeTx({
      selects: [
        [
          {
            passenger_id: 'p-1',
            origin_lat: '1',
            origin_lng: '2',
            dest_lat: '3',
            dest_lng: '4',
            joined_at: new Date('2026-11-06T10:00:00Z'),
          },
        ],
      ],
    });
    await expect(repo.listMembers(tx as never, 'pool-1')).resolves.toEqual([
      {
        passenger_id: 'p-1',
        origin_lat: 1,
        origin_lng: 2,
        dest_lat: 3,
        dest_lng: 4,
        joined_at: '2026-11-06T10:00:00.000Z',
      },
    ]);
  });

  it('seat lookups map the seat and return null when absent', async () => {
    const seat = { pool_id: 'pool-1', pool_state: 'open', opened: true, agreed_fare_cents: '700' };
    const { tx } = makeTx({
      selects: [
        [seat],
        [],
        [{ ...seat, opened: false, agreed_fare_cents: null }],
        [],
        [{ pool_id: 'pool-1', pool_state: 'closed_full' }],
        [],
      ],
    });
    await expect(repo.findByIdempotencyKey(tx as never, 'p-1', 'k')).resolves.toEqual({
      poolId: 'pool-1',
      poolState: 'open',
      opened: true,
      agreedFareCents: 700,
    });
    await expect(repo.findByIdempotencyKey(tx as never, 'p-1', 'k')).resolves.toBeNull();
    await expect(repo.findSeat(tx as never, 'pool-1', 'p-1')).resolves.toEqual({
      poolId: 'pool-1',
      poolState: 'open',
      opened: false,
      agreedFareCents: null,
    });
    await expect(repo.findSeat(tx as never, 'pool-1', 'p-1')).resolves.toBeNull();
    await expect(repo.findActiveForPassenger(tx as never, 'p-1')).resolves.toEqual({
      poolId: 'pool-1',
      poolState: 'closed_full',
    });
    await expect(repo.findActiveForPassenger(tx as never, 'p-1')).resolves.toBeNull();
  });

  it('insertItinerary writes every stop and skips an empty itinerary', async () => {
    const { tx, values } = makeTx();
    await repo.insertItinerary(tx as never, 'pool-1', []);
    expect(tx.insert).not.toHaveBeenCalled();
    await repo.insertItinerary(tx as never, 'pool-1', [
      { type: 'pickup', lat: 1, lng: 2, passengerId: 'p-1', sequenceIndex: 0 },
      { type: 'dropoff', lat: 3, lng: 4, passengerId: 'p-1', sequenceIndex: 1 },
    ]);
    expect(values).toHaveBeenCalledWith([
      { rideId: 'pool-1', sequenceIndex: 0, passengerId: 'p-1', type: 'pickup', lat: 1, lng: 2 },
      { rideId: 'pool-1', sequenceIndex: 1, passengerId: 'p-1', type: 'dropoff', lat: 3, lng: 4 },
    ]);
  });
});
