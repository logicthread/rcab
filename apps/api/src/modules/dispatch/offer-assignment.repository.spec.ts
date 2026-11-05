// Unit coverage for the result classification in the slice-A repositories.
// The SQL itself (locks, constraints, interleavings) is proven against real
// Postgres in test/integration/dispatch-offer-assignment.int.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import { DispatchOfferRepository, isUuid, offerTripPredicate } from './offer.repository';
import { DriverAssignmentRepository } from './assignment.repository';
import { Constraint } from '../../db/constraints';

const ID = '00000000-0000-4000-8000-000000000001';
const D = '00000000-0000-4000-8000-000000000002';

function execOnce(...results: Array<{ rows: unknown[] }>) {
  const execute = vi.fn();
  for (const r of results) execute.mockResolvedValueOnce(r);
  return execute;
}

describe('isUuid / offerTripPredicate', () => {
  it('accepts only canonical UUID strings', () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid('offer-1')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('targets the trip table column for the trip kind', () => {
    expect(offerTripPredicate({ kind: 'solo', rideId: ID })).toBeDefined();
    expect(offerTripPredicate({ kind: 'shared', sharedRideId: ID })).toBeDefined();
  });
});

describe('DispatchOfferRepository', () => {
  const repo = new DispatchOfferRepository();

  it('createOffer: null when the trip is no longer dispatchable at that generation', async () => {
    const tx = { execute: execOnce({ rows: [] }) };
    const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    const res = await repo.createOffer(db as never, {
      trip: { kind: 'shared', sharedRideId: ID },
      driverId: D,
      generation: 1,
      waveNumber: 1,
      ttlMs: 12_000,
    });
    expect(res).toBeNull();
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it('createOffer: maps the inserted row (string timestamp → Date), null on conflict', async () => {
    const mk = (inserted: unknown[]) => {
      const tx = { execute: execOnce({ rows: [{}] }, { rows: [] }, { rows: inserted }) };
      return { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    };
    const p = {
      trip: { kind: 'solo' as const, rideId: ID },
      driverId: D,
      generation: 1,
      waveNumber: 1,
      ttlMs: 12_000,
    };
    expect(
      await repo.createOffer(mk([{ id: ID, expires_at: '2026-11-06 10:00:12+00' }]) as never, p),
    ).toEqual({ offerId: ID, expiresAt: new Date('2026-11-06T10:00:12.000Z') });
    expect(await repo.createOffer(mk([]) as never, p)).toBeNull();
  });

  it('findForDriver / lockForUpdate: no query for non-UUIDs; rows are mapped', async () => {
    const execute = vi.fn();
    expect(await repo.findForDriver({ execute } as never, 'x', D)).toBeNull();
    expect(await repo.lockForUpdate({ execute } as never, 'x')).toBeNull();
    expect(execute).not.toHaveBeenCalled();

    const row = {
      id: ID,
      trip_kind: 'shared',
      ride_id: null,
      shared_ride_id: D,
      driver_id: D,
      dispatch_generation: '2',
      wave_number: '1',
      state: 'offered',
      offered_at: '2026-11-06 10:00:00+00',
      expires_at: '2026-11-06 10:00:12+00',
      resolved_at: null,
      lapsed: false,
    };
    const found = await repo.findForDriver({ execute: execOnce({ rows: [row] }) } as never, ID, D);
    expect(found).toMatchObject({
      trip: { kind: 'shared', sharedRideId: D },
      generation: 2,
      expiresAt: new Date('2026-11-06T10:00:12.000Z'),
      resolvedAt: null,
    });
    const locked = await repo.lockForUpdate(
      { execute: execOnce({ rows: [{ ...row, trip_kind: 'solo', ride_id: ID, resolved_at: '2026-11-06 10:00:05+00' }] }) } as never,
      ID,
    );
    expect(locked?.trip).toEqual({ kind: 'solo', rideId: ID });
    expect(locked?.resolvedAt).toEqual(new Date('2026-11-06T10:00:05.000Z'));
    expect(await repo.lockForUpdate({ execute: execOnce({ rows: [] }) } as never, ID)).toBeNull();
  });

  it('markAccepted throws when the offer is no longer live', async () => {
    await expect(
      repo.markAccepted({ execute: execOnce({ rows: [] }) } as never, ID),
    ).rejects.toThrow(/not live/);
    await expect(
      repo.markAccepted({ execute: execOnce({ rows: [{ id: ID }] }) } as never, ID),
    ).resolves.toBeUndefined();
  });

  it.each([
    [{ declined: true, found: true }, 'declined'],
    [{ declined: false, found: true }, 'not_live'],
    [{ declined: false, found: false }, 'not_found'],
  ])('decline maps %o → %s', async (row, expected) => {
    expect(await repo.decline({ execute: execOnce({ rows: [row] }) } as never, ID, D)).toBe(expected);
  });

  it('decline of a non-UUID is not_found without a query', async () => {
    const execute = vi.fn();
    expect(await repo.decline({ execute } as never, 'nope', D)).toBe('not_found');
    expect(execute).not.toHaveBeenCalled();
  });

  it('revokeLiveForTrip / expireLapsed / offeredDriverIds map their rows', async () => {
    expect(
      await repo.revokeLiveForTrip(
        { execute: execOnce({ rows: [{ id: ID, driver_id: D }] }) } as never,
        { kind: 'solo', rideId: ID },
        ID,
      ),
    ).toEqual([{ offerId: ID, driverId: D }]);
    expect(await repo.expireLapsed({ execute: execOnce({ rows: [{}, {}] }) } as never)).toBe(2);
    expect(
      await repo.offeredDriverIds(
        { execute: execOnce({ rows: [{ driver_id: D }] }) } as never,
        { kind: 'shared', sharedRideId: ID },
        1,
      ),
    ).toEqual([D]);
  });

  it('eligibleCandidates drops non-UUIDs and short-circuits an empty list', async () => {
    const execute = vi.fn();
    expect(await repo.eligibleCandidates({ execute } as never, ['x', 'y'], 1)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(
      await repo.eligibleCandidates({ execute: execOnce({ rows: [{ id: D }] }) } as never, [D, ID, 'x', D], 2),
    ).toEqual([D]);
  });
});

describe('DriverAssignmentRepository', () => {
  const repo = new DriverAssignmentRepository();

  function txFailingInsert(err: unknown) {
    const sp = { insert: () => ({ values: vi.fn().mockRejectedValue(err) }) };
    return { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(sp)) };
  }
  const p = { driverId: D, trip: { kind: 'solo' as const, rideId: ID }, offerId: null, generation: 1 };

  it('acquire succeeds inside a savepoint', async () => {
    const sp = { insert: () => ({ values: vi.fn().mockResolvedValue(undefined) }) };
    const tx = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(sp)) };
    expect(await repo.acquire(tx as never, p)).toEqual({ ok: true });
    expect(tx.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    [Constraint.AssignmentDriverBusy, 'driver_busy'],
    [Constraint.AssignmentSoloTaken, 'trip_taken'],
    [Constraint.AssignmentSharedTaken, 'trip_taken'],
  ])('acquire maps unique violation %s → %s (also through a drizzle cause)', async (constraint, reason) => {
    const direct = { code: '23505', constraint };
    expect(await repo.acquire(txFailingInsert(direct) as never, p)).toEqual({ ok: false, reason });
    const wrapped = Object.assign(new Error('drizzle'), { cause: direct });
    expect(await repo.acquire(txFailingInsert(wrapped) as never, p)).toEqual({ ok: false, reason });
  });

  it('acquire rethrows anything that is not an expected guard conflict', async () => {
    const other = { code: '23505', constraint: 'driver_active_assignment_offer_id_key' };
    await expect(repo.acquire(txFailingInsert(other) as never, p)).rejects.toBe(other);
    const fk = { code: '23503', constraint: 'driver_active_assignment_driver_id_fkey' };
    await expect(repo.acquire(txFailingInsert(fk) as never, p)).rejects.toBe(fk);
  });

  it('lockSharedTrip maps the locked row', async () => {
    const tx = {
      execute: execOnce({
        rows: [
          {
            ride_id: ID,
            pool_state: 'closed_full',
            seat_count: '2',
            max_seats: '3',
            claimed_by_driver_id: null,
            dispatch_generation: '1',
            state_version: '7',
          },
        ],
      }),
    };
    expect(await repo.lockSharedTrip(tx as never, ID)).toEqual({
      rideId: ID,
      poolState: 'closed_full',
      seatCount: 2,
      maxSeats: 3,
      claimedByDriverId: null,
      dispatchGeneration: 1,
      stateVersion: 7,
    });
    expect(await repo.lockSharedTrip({ execute: execOnce({ rows: [] }) } as never, ID)).toBeNull();
  });

  it('claimSharedRow throws when nothing matched; abortUnclaimedPool reports whether it aborted', async () => {
    await expect(
      repo.claimSharedRow({ execute: execOnce({ rows: [] }) } as never, ID, D, 1),
    ).rejects.toThrow(/not claimable/);
    await expect(
      repo.claimSharedRow({ execute: execOnce({ rows: [{ ride_id: ID }] }) } as never, ID, D, 1),
    ).resolves.toBeUndefined();
    expect(await repo.abortUnclaimedPool({ execute: execOnce({ rows: [] }) } as never, ID, 1)).toBe(false);
    expect(
      await repo.abortUnclaimedPool({ execute: execOnce({ rows: [{ ride_id: ID }] }) } as never, ID, 1),
    ).toBe(true);
  });

  it.each([
    [[], 'driver_ineligible'],
    [[{ eligible: false, max_seats: 4 }], 'driver_ineligible'],
    [[{ eligible: true, max_seats: null }], 'vehicle_capacity'],
    [[{ eligible: true, max_seats: '2' }], 'vehicle_capacity'],
    [[{ eligible: true, max_seats: 4 }], 'ok'],
  ])('driverEligibility(rows=%j, seats=3) → %s', async (rows, expected) => {
    expect(await repo.driverEligibility({ execute: execOnce({ rows }) } as never, D, 3)).toBe(expected);
  });
});
