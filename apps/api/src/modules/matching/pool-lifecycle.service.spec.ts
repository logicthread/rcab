import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  PoolLifecycleService,
  PoolOpenRejectedError,
  POOL_UPDATE_EVENT,
  type SeatIdempotency,
} from './pool-lifecycle.service';
import type { PoolLockRow } from './pool-membership.repository';
import type { SharedRideMember, SharedRideRow } from './shared-ride.repository';

const enqueueOutbox = vi.hoisted(() => vi.fn());
vi.mock('../outbox/outbox.writer', () => ({ enqueueOutbox }));

function member(overrides: Partial<SharedRideMember> = {}): SharedRideMember {
  return {
    passenger_id: 'p-opener',
    origin_lat: 22.5727,
    origin_lng: 88.364,
    dest_lat: 22.5801,
    dest_lng: 88.3701,
    joined_at: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

function row(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId: 'pool-1',
    seatCount: 1,
    maxSeats: 3,
    poolState: 'open',
    poolClosedAt: null,
    detourBudgetM: 800,
    originLat: 22.5727,
    originLng: 88.364,
    destLat: 22.5801,
    destLng: 88.3701,
    members: [member()],
    claimedByDriverId: null,
    claimedAt: null,
    dispatchGeneration: 0,
    stateVersion: 1,
    ...overrides,
  };
}

function lockRow(overrides: Partial<PoolLockRow> = {}): PoolLockRow {
  return {
    poolId: 'pool-1',
    poolState: 'open',
    seatCount: 1,
    maxSeats: 3,
    dispatchGeneration: 0,
    stateVersion: 1,
    claimedByDriverId: null,
    originLat: 22.5727,
    originLng: 88.364,
    destLat: 22.5801,
    destLng: 88.3701,
    ...overrides,
  };
}

const QUOTE = {
  perSeatPrice: { amount: 9_000, currency: 'INR' as const },
  seatMultiplier: 0.7,
  detourFactor: 1.1,
  policy: 'fixed_at_join' as const,
};
const quoteFare = vi.fn();

const JOINER = member({ passenger_id: 'p-joiner', origin_lat: 22.573, dest_lat: 22.581 });
const TX = { tx: true };

function pgError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function makeService(opts: { config?: Record<string, unknown> } = {}) {
  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(TX)),
    execute: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  };
  const repo = {
    insertOpenPool: vi.fn().mockResolvedValue({ poolClosedAt: new Date('2026-11-06T10:01:00Z') }),
    closeOpen: vi.fn().mockResolvedValue({ generation: 1 }),
    abortEmptyOpen: vi.fn().mockResolvedValue(true),
    findById: vi.fn().mockResolvedValue(row()),
  };
  const members = {
    lockPool: vi.fn().mockResolvedValue(lockRow()),
    insertMember: vi.fn().mockResolvedValue({ ok: true, seatCount: 1 }),
    listMembers: vi.fn().mockResolvedValue([member(), JOINER]),
    insertItinerary: vi.fn().mockResolvedValue(undefined),
  };
  const projection = { write: vi.fn().mockResolvedValue(true) };
  const idempotency = { completeIn: vi.fn().mockResolvedValue(undefined) };
  const relay = { kick: vi.fn() };
  const bus = { toPool: vi.fn(), joinPool: vi.fn().mockResolvedValue(undefined) };
  const config = { get: vi.fn((key: string) => (opts.config ?? {})[key] ?? undefined) };
  const svc = new PoolLifecycleService(
    db as never,
    repo as never,
    members as never,
    projection as never,
    idempotency as never,
    relay as never,
    bus as never,
    config as never,
  );
  return { svc, db, repo, members, projection, idempotency, relay, bus };
}

const OPEN = {
  passengerId: 'p-opener',
  originLat: 22.5727,
  originLng: 88.364,
  destLat: 22.5801,
  destLng: 88.3701,
  maxSeats: 3,
  detourBudgetM: 800,
  quoteFare: (ctx: Parameters<typeof quoteFare>[0]) => quoteFare(ctx),
};

const SCOPE = { principalId: 'p-x', operation: 'ride.create.shared' as const, key: 'k-1' };

beforeEach(() => {
  enqueueOutbox.mockReset().mockResolvedValue(true);
  quoteFare.mockReset().mockResolvedValue(QUOTE);
});

describe('PoolLifecycleService.openPool', () => {
  it('inserts pool + opener + expiry intent + idempotency completion in ONE transaction', async () => {
    const { svc, db, repo, members, idempotency } = makeService({
      config: { MATCHING_POOL_TIMEOUT_MS: '45000' },
    });
    repo.findById.mockResolvedValueOnce(row({ rideId: 'pool-new' }));
    const response = vi.fn().mockReturnValue({ stored: 1 });
    const idem: SeatIdempotency = { scope: SCOPE, response };

    const res = await svc.openPool({ ...OPEN, poolId: 'pool-new', idempotency: idem });

    expect(res).toMatchObject({ rideId: 'pool-new', seatCount: 1, poolState: 'open' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(repo.insertOpenPool).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        rideId: 'pool-new',
        maxSeats: 3,
        detourBudgetM: 800,
        timeoutMs: 45_000,
      }),
    );
    expect(members.insertMember).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        poolId: 'pool-new',
        passengerId: 'p-opener',
        agreedFareCents: 9_000,
        idempotencyKey: 'k-1',
      }),
    );
    expect(enqueueOutbox).toHaveBeenCalledWith(TX, {
      topic: 'pool.expire.schedule',
      aggregateType: 'shared_ride',
      aggregateId: 'pool-new',
      generation: 0,
      payload: { expireAt: '2026-11-06T10:01:00.000Z' },
    });
    expect(response).toHaveBeenCalledWith({
      sharedRideId: 'pool-new',
      mode: 'opened',
      poolStatus: 'open',
      seatCount: 1,
      quote: QUOTE,
    });
    expect(idempotency.completeIn).toHaveBeenCalledWith(TX, SCOPE, 'pool-new', { stored: 1 });
  });

  it('prices the opener inside the txn (seat 1, two-stop itinerary) and a pricing failure rolls the pool back', async () => {
    const { svc, repo, members, projection } = makeService();
    await svc.openPool({ ...OPEN, poolId: 'pool-new' });
    expect(quoteFare).toHaveBeenCalledWith(
      expect.objectContaining({ poolId: 'pool-new', passengerId: 'p-opener', seatCount: 1 }),
    );
    const ctx = quoteFare.mock.calls[0][0] as { stops: Array<{ type: string }> };
    expect(ctx.stops.map((st) => st.type)).toEqual(['pickup', 'dropoff']);
    expect(repo.insertOpenPool.mock.invocationCallOrder[0]).toBeLessThan(
      quoteFare.mock.invocationCallOrder[0],
    );

    members.insertMember.mockClear();
    enqueueOutbox.mockClear();
    quoteFare.mockRejectedValueOnce(new Error('routing_unavailable'));
    await expect(svc.openPool({ ...OPEN, poolId: 'pool-fail' })).rejects.toThrow(
      'routing_unavailable',
    );
    expect(members.insertMember).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(projection.write).toHaveBeenCalledTimes(1); // only the first, successful open
  });

  it('generates an id when none is given and stores a null key without idempotency', async () => {
    const { svc, members, idempotency, repo } = makeService();
    repo.findById.mockImplementationOnce(async (id: string) => row({ rideId: id }));
    const res = await svc.openPool(OPEN);
    expect(res.rideId).toMatch(/^[0-9a-f-]{36}$/);
    expect(members.insertMember).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ idempotencyKey: null }),
    );
    expect(idempotency.completeIn).not.toHaveBeenCalled();
  });

  it.each(['passenger_has_active_pool', 'idempotent_replay'] as const)(
    'rolls the whole pool back and throws a typed %s rejection',
    async (reason) => {
      const { svc, members, projection, bus } = makeService();
      members.insertMember.mockResolvedValueOnce({ ok: false, reason, existingPoolId: 'p-old' });

      const err = await svc.openPool(OPEN).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PoolOpenRejectedError);
      expect(err).toMatchObject({ reason, existingPoolId: 'p-old' });
      expect(enqueueOutbox).not.toHaveBeenCalled();
      expect(projection.write).not.toHaveBeenCalled();
      expect(bus.joinPool).not.toHaveBeenCalled();
    },
  );

  it('treats an impossible opener rejection as a bug (throws)', async () => {
    const { svc, members } = makeService();
    members.insertMember.mockResolvedValueOnce({ ok: false, reason: 'pool_full' });
    await expect(svc.openPool(OPEN)).rejects.toThrow(/unexpected opener rejection pool_full/);
  });

  it('after commit: projects the committed row, joins the opener room, emits pool:update', async () => {
    const { svc, projection, bus, repo } = makeService();
    const committed = row({ rideId: 'pool-new', seatCount: 1 });
    repo.findById.mockResolvedValueOnce(committed);

    await svc.openPool({ ...OPEN, poolId: 'pool-new' });

    expect(repo.findById).toHaveBeenCalledWith('pool-new');
    expect(projection.write).toHaveBeenCalledWith(committed);
    expect(bus.joinPool).toHaveBeenCalledWith('p-opener', 'pool-new');
    expect(bus.toPool).toHaveBeenCalledWith('pool-new', POOL_UPDATE_EVENT, {
      sharedRideId: 'pool-new',
      seatCount: 1,
      poolStatus: 'open',
    });
  });

  it('post-commit failures never fail a committed open (row described from the txn)', async () => {
    const { svc, repo, bus } = makeService();
    repo.findById.mockRejectedValueOnce(new Error('db blip'));
    bus.joinPool.mockRejectedValueOnce(new Error('ws down'));

    const res = await svc.openPool({ ...OPEN, poolId: 'pool-new' });
    expect(res).toMatchObject({
      rideId: 'pool-new',
      seatCount: 1,
      poolState: 'open',
      poolClosedAt: new Date('2026-11-06T10:01:00Z'),
      dispatchGeneration: 0,
      members: [expect.objectContaining({ passenger_id: 'p-opener' })],
    });
    expect(bus.toPool).not.toHaveBeenCalled();
  });

  it('a failed Redis projection write is swallowed', async () => {
    const { svc, projection, bus } = makeService();
    projection.write.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.openPool(OPEN)).resolves.toMatchObject({ poolState: 'open' });
    expect(bus.toPool).toHaveBeenCalled();
  });

  it('retries a deadlocked transaction at most twice, then throws a typed conflict', async () => {
    const { svc, db } = makeService();
    db.transaction.mockRejectedValue(pgError('40P01'));
    await expect(svc.openPool(OPEN)).rejects.toMatchObject({ reason: 'conflict' });
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });

  it('a retried serialization failure that then succeeds commits once', async () => {
    const { svc, db } = makeService();
    db.transaction.mockRejectedValueOnce({ cause: pgError('40001') });
    await expect(svc.openPool(OPEN)).resolves.toMatchObject({ poolState: 'open' });
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('non-retryable database errors propagate', async () => {
    const { svc, db } = makeService();
    db.transaction.mockRejectedValueOnce(pgError('23503'));
    await expect(svc.openPool(OPEN)).rejects.toMatchObject({ code: '23503' });
  });
});

describe('PoolLifecycleService.joinPool', () => {
  it('locks, re-validates, inserts the member and commits with the idempotency record', async () => {
    const { svc, members, idempotency, repo } = makeService();
    members.insertMember.mockResolvedValueOnce({ ok: true, seatCount: 2 });
    const response = vi.fn().mockReturnValue('stored');

    const res = await svc.joinPool({
      poolId: 'pool-1',
      joiner: JOINER,
      quoteFare,
      idempotency: { scope: SCOPE, response },
    });

    expect(res).toEqual({ joined: true, closedFull: false, seatCount: 2, quote: QUOTE });
    expect(members.lockPool).toHaveBeenCalledWith(TX, 'pool-1');
    expect(members.insertMember).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        poolId: 'pool-1',
        passengerId: 'p-joiner',
        agreedFareCents: 9_000,
        idempotencyKey: 'k-1',
      }),
    );
    expect(repo.closeOpen).not.toHaveBeenCalled();
    expect(response).toHaveBeenCalledWith({
      sharedRideId: 'pool-1',
      mode: 'slotted',
      poolStatus: 'open',
      seatCount: 2,
      quote: QUOTE,
    });
    expect(idempotency.completeIn).toHaveBeenCalledWith(TX, SCOPE, 'pool-1', 'stored');
  });

  it('prices the seat INSIDE the txn from the locked pool state: seat count after join, itinerary incl. joiner', async () => {
    const { svc, members } = makeService();
    members.listMembers.mockResolvedValueOnce([member(), member({ passenger_id: 'p-second' })]);
    const order: string[] = [];
    members.lockPool.mockImplementationOnce(async () => {
      order.push('lock');
      return lockRow({ seatCount: 2, maxSeats: 3 });
    });
    quoteFare.mockImplementationOnce(async () => {
      order.push('quote');
      return QUOTE;
    });
    members.insertMember.mockImplementationOnce(async () => {
      order.push('insert');
      return { ok: true, seatCount: 3 };
    });

    await svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare });

    expect(order).toEqual(['lock', 'quote', 'insert']);
    const ctx = quoteFare.mock.calls[0][0] as {
      poolId: string;
      passengerId: string;
      seatCount: number;
      directRoute: unknown;
      stops: Array<{ type: string; passengerId: string }>;
    };
    expect(ctx).toMatchObject({ poolId: 'pool-1', passengerId: 'p-joiner', seatCount: 3 });
    expect(ctx.directRoute).toEqual({
      originLat: JOINER.origin_lat,
      originLng: JOINER.origin_lng,
      destLat: JOINER.dest_lat,
      destLng: JOINER.dest_lng,
    });
    // 3 members -> 6 stops, every pickup before every dropoff.
    expect(ctx.stops).toHaveLength(6);
    expect(ctx.stops.slice(0, 3).every((st) => st.type === 'pickup')).toBe(true);
    expect(ctx.stops.map((st) => st.passengerId)).toContain('p-joiner');
  });

  it('earlier members are never repriced: a join writes exactly one member row', async () => {
    const { svc, members, db } = makeService();
    members.insertMember.mockResolvedValueOnce({ ok: true, seatCount: 2 });
    await svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare });
    expect(members.insertMember).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a pricing failure fails the join cleanly: nothing inserted, no completion, no post-commit work', async () => {
    const { svc, members, idempotency, projection, bus, relay } = makeService();
    quoteFare.mockRejectedValueOnce(new Error('routing_unavailable'));

    await expect(
      svc.joinPool({
        poolId: 'pool-1',
        joiner: JOINER,
        quoteFare,
        idempotency: { scope: SCOPE, response: () => 'x' },
      }),
    ).rejects.toThrow('routing_unavailable');

    expect(members.insertMember).not.toHaveBeenCalled();
    expect(idempotency.completeIn).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(projection.write).not.toHaveBeenCalled();
    expect(bus.toPool).not.toHaveBeenCalled();
    expect(relay.kick).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', null],
    ['pool_closed', lockRow({ poolState: 'closed_timeout' })],
    ['pool_full', lockRow({ seatCount: 3 })],
  ] as const)('fast-fails with %s under the lock without inserting', async (reason, lock) => {
    const { svc, members, projection } = makeService();
    members.lockPool.mockResolvedValueOnce(lock);

    const res = await svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare });

    expect(res).toEqual({ joined: false, reason });
    expect(members.insertMember).not.toHaveBeenCalled();
    expect(quoteFare).not.toHaveBeenCalled(); // no routing call for a doomed join
    expect(projection.write).not.toHaveBeenCalled();
  });

  it('passes typed insert rejections through and writes nothing else', async () => {
    const { svc, members, idempotency } = makeService();
    members.insertMember.mockResolvedValueOnce({
      ok: false,
      reason: 'passenger_has_active_pool',
      existingPoolId: 'p-other',
    });

    const res = await svc.joinPool({
      poolId: 'pool-1',
      joiner: JOINER,
      quoteFare,
      idempotency: { scope: SCOPE, response: () => 'x' },
    });

    expect(res).toEqual({
      joined: false,
      reason: 'passenger_has_active_pool',
      existingPoolId: 'p-other',
    });
    expect(idempotency.completeIn).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('the seat that fills the pool closes it in the SAME txn: generation, itinerary, dispatch intent', async () => {
    const { svc, members, repo, bus, relay } = makeService();
    members.lockPool.mockResolvedValueOnce(lockRow({ seatCount: 1, maxSeats: 2 }));
    members.insertMember.mockResolvedValueOnce({ ok: true, seatCount: 2 });
    repo.closeOpen.mockResolvedValueOnce({ generation: 1 });
    repo.findById.mockResolvedValueOnce(
      row({ poolState: 'closed_full', seatCount: 2, maxSeats: 2 }),
    );

    const res = await svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare });

    expect(res).toEqual({ joined: true, closedFull: true, seatCount: 2, quote: QUOTE });
    expect(repo.closeOpen).toHaveBeenCalledWith(TX, 'pool-1', 'closed_full');
    expect(members.listMembers).toHaveBeenCalledWith(TX, 'pool-1');
    const stops = members.insertItinerary.mock.calls[0][2] as Array<{
      type: string;
      passengerId: string;
    }>;
    expect(stops).toHaveLength(4);
    expect(
      stops
        .filter((s) => s.type === 'pickup')
        .map((s) => s.passengerId)
        .sort(),
    ).toEqual(['p-joiner', 'p-opener']);
    expect(enqueueOutbox).toHaveBeenCalledWith(TX, {
      topic: 'pool.dispatch.requested',
      aggregateType: 'shared_ride',
      aggregateId: 'pool-1',
      generation: 1,
      payload: { poolId: 'pool-1', reason: 'closed_full' },
    });
    expect(bus.toPool).toHaveBeenCalledWith('pool-1', POOL_UPDATE_EVENT, {
      sharedRideId: 'pool-1',
      seatCount: 2,
      poolStatus: 'closed_full',
    });
    expect(relay.kick).toHaveBeenCalled();
  });

  it('a non-filling join emits pool:update {open} and no close nudge', async () => {
    const { svc, members, bus, relay, repo } = makeService();
    members.insertMember.mockResolvedValueOnce({ ok: true, seatCount: 2 });
    repo.findById.mockResolvedValueOnce(row({ seatCount: 2 }));

    await svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare });

    expect(bus.joinPool).toHaveBeenCalledWith('p-joiner', 'pool-1');
    expect(bus.toPool).toHaveBeenCalledWith('pool-1', POOL_UPDATE_EVENT, {
      sharedRideId: 'pool-1',
      seatCount: 2,
      poolStatus: 'open',
    });
    expect(relay.kick).not.toHaveBeenCalled();
  });

  it('reports conflict after bounded deadlock retries', async () => {
    const { svc, db } = makeService();
    db.transaction.mockRejectedValue(pgError('40P01'));
    await expect(
      svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare }),
    ).resolves.toEqual({ joined: false, reason: 'conflict' });
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });

  it('does not emit pool:update for a committed row that is no longer joinable-visible', async () => {
    const { svc, bus, relay, repo } = makeService();
    repo.findById.mockResolvedValueOnce(row({ poolState: 'closed_started' }));
    relay.kick.mockImplementation(() => {
      throw new Error('relay blew up');
    });
    await svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare });
    expect(bus.toPool).not.toHaveBeenCalled();
  });

  it('a throwing socket emit never fails a committed join', async () => {
    const { svc, bus } = makeService();
    bus.toPool.mockImplementation(() => {
      throw new Error('io down');
    });
    await expect(
      svc.joinPool({ poolId: 'pool-1', joiner: JOINER, quoteFare }),
    ).resolves.toMatchObject({ joined: true });
  });
});

describe('PoolLifecycleService.closeIfOpen', () => {
  it('closes an open pool (closed_timeout) with itinerary + dispatch intent', async () => {
    const { svc, repo, relay, bus } = makeService();
    repo.closeOpen.mockResolvedValueOnce({ generation: 1 });
    repo.findById.mockResolvedValueOnce(row({ poolState: 'closed_timeout', seatCount: 1 }));

    await expect(svc.closeIfOpen('pool-1', 'closed_timeout')).resolves.toBe('closed');

    expect(repo.closeOpen).toHaveBeenCalledWith(TX, 'pool-1', 'closed_timeout');
    expect(enqueueOutbox).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        topic: 'pool.dispatch.requested',
        generation: 1,
        payload: { poolId: 'pool-1', reason: 'closed_timeout' },
      }),
    );
    expect(bus.toPool).toHaveBeenCalledWith('pool-1', POOL_UPDATE_EVENT, {
      sharedRideId: 'pool-1',
      seatCount: 1,
      poolStatus: 'closed_timeout',
    });
    expect(relay.kick).toHaveBeenCalled();
    expect(bus.joinPool).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['closed_full', lockRow({ poolState: 'closed_full' })],
    ['closed_started', lockRow({ poolState: 'closed_started' })],
    ['completed', lockRow({ poolState: 'completed' })],
  ] as const)('a stale timeout on a %s pool is a no-op', async (_label, lock) => {
    const { svc, members, repo, projection } = makeService();
    members.lockPool.mockResolvedValueOnce(lock);
    await expect(svc.closeIfOpen('pool-1', 'closed_timeout')).resolves.toBe('not_open');
    expect(repo.closeOpen).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(projection.write).not.toHaveBeenCalled();
  });

  it('a lost guarded UPDATE is not_open and records nothing', async () => {
    const { svc, repo, members } = makeService();
    repo.closeOpen.mockResolvedValueOnce(null);
    await expect(svc.closeIfOpen('pool-1', 'closed_timeout')).resolves.toBe('not_open');
    expect(members.insertItinerary).not.toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('an EMPTY open pool (legacy data) is aborted instead of dispatched', async () => {
    const { svc, members, repo, relay } = makeService();
    members.lockPool.mockResolvedValueOnce(lockRow({ seatCount: 0 }));
    await expect(svc.closeIfOpen('pool-1', 'closed_timeout')).resolves.toBe('aborted_empty');
    expect(repo.abortEmptyOpen).toHaveBeenCalledWith(TX, 'pool-1');
    expect(repo.closeOpen).not.toHaveBeenCalled();
    expect(repo.findById).toHaveBeenCalledWith('pool-1');
    expect(relay.kick).not.toHaveBeenCalled();

    members.lockPool.mockResolvedValueOnce(lockRow({ seatCount: 0 }));
    repo.abortEmptyOpen.mockResolvedValueOnce(false);
    await expect(svc.closeIfOpen('pool-1', 'closed_timeout')).resolves.toBe('not_open');
  });

  it('a throwing relay kick never fails a committed close (the outbox row is durable)', async () => {
    const { svc, repo, relay } = makeService();
    repo.closeOpen.mockResolvedValueOnce({ generation: 1 });
    relay.kick.mockImplementation(() => {
      throw new Error('relay blew up');
    });
    await expect(svc.closeIfOpen('pool-1', 'closed_timeout')).resolves.toBe('closed');
    expect(relay.kick).toHaveBeenCalledTimes(1);
  });

  it('throws (so the job retries) when deadlock retries are exhausted', async () => {
    const { svc, db } = makeService();
    db.transaction.mockRejectedValue(pgError('40P01'));
    await expect(svc.closeIfOpen('pool-1', 'closed_timeout')).rejects.toThrow(/retries exhausted/);
  });
});

