import { describe, it, expect, vi } from 'vitest';
import {
  RideLifecycleService,
  STOP_PICKUP_EVENT,
  STOP_DROP_EVENT,
  RIDE_COMPLETED_EVENT,
} from './ride-lifecycle.service';
import { STOP_CONFIRM_REQUEST_EVENT } from '../realtime/realtime.gateway';
import type { RideStopRow } from '../matching/ride-stop.repository';
import type { SharedTripLockRow } from '../dispatch/assignment.repository';

const T0 = new Date('2026-11-06T10:00:00.000Z');

function stop(overrides: Partial<RideStopRow> = {}): RideStopRow {
  return {
    rideId: 'r-1',
    sequenceIndex: 0,
    passengerId: 'p-1',
    type: 'pickup',
    lat: 0,
    lng: 0,
    confirmedAt: null,
    ...overrides,
  };
}

function lock(overrides: Partial<SharedTripLockRow> = {}): SharedTripLockRow {
  return {
    rideId: 'r-1',
    poolState: 'closed_full',
    seatCount: 1,
    maxSeats: 3,
    claimedByDriverId: 'd-1',
    dispatchGeneration: 1,
    stateVersion: 0,
    ...overrides,
  };
}

interface MakeOpts {
  pool?: SharedTripLockRow | null;
  stops?: RideStopRow[];
  confirmResult?: RideStopRow | null;
  completedAt?: Date | null;
}

function make(opts: MakeOpts = {}) {
  const tx = { tx: true };
  const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const stops = opts.stops ?? [];
  const stopsRepo = {
    findByRideId: vi.fn().mockResolvedValue(stops),
    confirm: vi.fn().mockImplementation(async (_r: string, idx: number) => {
      if (opts.confirmResult !== undefined) return opts.confirmResult;
      const existing = stops.find((s) => s.sequenceIndex === idx);
      return existing ? { ...existing, confirmedAt: T0 } : null;
    }),
    markRideCompleted: vi
      .fn()
      .mockResolvedValue(opts.completedAt === undefined ? T0 : opts.completedAt),
    markRideStarted: vi.fn().mockResolvedValue(undefined),
  };
  const assignments = {
    lockSharedTrip: vi.fn().mockResolvedValue(opts.pool === undefined ? lock() : opts.pool),
    release: vi.fn().mockResolvedValue(true),
  };
  const bus = { toDriver: vi.fn(), toRide: vi.fn() };
  const redis = { eval: vi.fn().mockResolvedValue(1) };
  const poolProjection = { project: vi.fn().mockResolvedValue(null) };
  const svc = new RideLifecycleService(
    stopsRepo as never,
    assignments as never,
    bus as never,
    redis as never,
    db as never,
    poolProjection as never,
  );
  return { svc, tx, db, stopsRepo, assignments, bus, redis, poolProjection };
}

const input = (sequenceIndex: number, type: 'pickup' | 'dropoff' = 'pickup') => ({
  rideId: 'r-1',
  driverId: 'd-1',
  sequenceIndex,
  type,
});

describe('RideLifecycleService.confirmStop', () => {
  it('rejects when the pool is not found', async () => {
    const { svc } = make({ pool: null });
    expect(await svc.confirmStop(input(0))).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects when the caller does not hold the committed claim', async () => {
    const { svc, stopsRepo } = make({ pool: lock({ claimedByDriverId: 'someone-else' }) });
    expect(await svc.confirmStop(input(0))).toEqual({ ok: false, reason: 'not_owner' });
    expect(stopsRepo.confirm).not.toHaveBeenCalled();
  });

  it('rejects an unknown stop, a type mismatch and an out-of-order stop', async () => {
    const stops = [stop({ sequenceIndex: 0 }), stop({ sequenceIndex: 1, type: 'dropoff' })];
    const { svc, stopsRepo } = make({ stops });
    expect(await svc.confirmStop(input(7))).toEqual({ ok: false, reason: 'not_found' });
    expect(await svc.confirmStop(input(0, 'dropoff'))).toEqual({ ok: false, reason: 'wrong_type' });
    expect(await svc.confirmStop(input(1, 'dropoff'))).toEqual({ ok: false, reason: 'out_of_order' });
    expect(stopsRepo.confirm).not.toHaveBeenCalled();
  });

  it('first pickup: stamps it in the pool-locked transaction, marks started, echoes', async () => {
    const stops = [stop({ sequenceIndex: 0 }), stop({ sequenceIndex: 1, type: 'dropoff' })];
    const { svc, tx, stopsRepo, assignments, bus, redis, poolProjection } = make({ stops });
    const result = await svc.confirmStop(input(0));
    expect(poolProjection.project).toHaveBeenCalledWith('r-1');

    expect(result).toMatchObject({ ok: true, pendingAfter: 1, rideCompleted: false, duplicate: false });
    expect(assignments.lockSharedTrip).toHaveBeenCalledWith(tx, 'r-1');
    expect(stopsRepo.confirm).toHaveBeenCalledWith('r-1', 0, tx);
    expect(stopsRepo.markRideStarted).toHaveBeenCalledWith('r-1', tx);
    expect(stopsRepo.markRideCompleted).not.toHaveBeenCalled();
    expect(assignments.release).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(bus.toDriver).toHaveBeenCalledWith('d-1', STOP_PICKUP_EVENT, {
      rideId: 'r-1',
      sequenceIndex: 0,
      passengerId: 'p-1',
      type: 'pickup',
      confirmedAt: T0.toISOString(),
      rideCompleted: false,
    });
  });

  it('final drop: completes the pool and releases the guard in the same transaction', async () => {
    const stops = [
      stop({ sequenceIndex: 0, confirmedAt: T0 }),
      stop({ sequenceIndex: 1, type: 'dropoff' }),
    ];
    const { svc, tx, stopsRepo, assignments, bus, redis, poolProjection } = make({ stops });
    const result = await svc.confirmStop(input(1, 'dropoff'));
    expect(poolProjection.project).toHaveBeenCalledWith('r-1');

    expect(result).toMatchObject({ ok: true, pendingAfter: 0, rideCompleted: true });
    expect(stopsRepo.markRideStarted).not.toHaveBeenCalled();
    expect(stopsRepo.markRideCompleted).toHaveBeenCalledWith('r-1', tx);
    expect(assignments.release).toHaveBeenCalledWith(tx, {
      driverId: 'd-1',
      trip: { kind: 'shared', sharedRideId: 'r-1' },
    });
    // Projection clear is compare-and-delete on this pool only.
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'driver:state:d-1',
      'current_ride_id',
      'r-1',
    );
    expect(bus.toRide).toHaveBeenCalledWith('r-1', RIDE_COMPLETED_EVENT, {
      rideId: 'r-1',
      completedAt: T0.toISOString(),
    });
    expect(bus.toDriver).toHaveBeenCalledWith(
      'd-1',
      STOP_DROP_EVENT,
      expect.objectContaining({ rideCompleted: true }),
    );
  });

  it('a duplicate confirmation returns the authoritative state, not an error (T32)', async () => {
    const stops = [
      stop({ sequenceIndex: 0, confirmedAt: T0 }),
      stop({ sequenceIndex: 1, type: 'dropoff', confirmedAt: T0 }),
    ];
    const { svc, stopsRepo, assignments, bus, poolProjection } = make({
      stops,
      pool: lock({ poolState: 'completed' }),
    });
    const result = await svc.confirmStop(input(1, 'dropoff'));
    expect(poolProjection.project).not.toHaveBeenCalled();

    expect(result).toMatchObject({ ok: true, duplicate: true, pendingAfter: 0, rideCompleted: true });
    expect(stopsRepo.confirm).not.toHaveBeenCalled();
    expect(assignments.release).not.toHaveBeenCalled();
    expect(bus.toDriver).toHaveBeenCalledWith(
      'd-1',
      STOP_DROP_EVENT,
      expect.objectContaining({ rideCompleted: true, confirmedAt: T0.toISOString() }),
    );
  });

  it('a stop that changed under the lock, or a pool that cannot complete, aborts the transaction', async () => {
    const stops = [stop({ sequenceIndex: 0 })];
    await expect(make({ stops, confirmResult: null }).svc.confirmStop(input(0))).rejects.toThrow(
      /changed under the pool lock/,
    );
    const last = [stop({ sequenceIndex: 0, type: 'dropoff' })];
    await expect(
      make({ stops: last, completedAt: null }).svc.confirmStop(input(0, 'dropoff')),
    ).rejects.toThrow(/could not be completed/);
  });

  it('post-commit failures (projection, socket) never fail the confirmation', async () => {
    const stops = [stop({ sequenceIndex: 0, type: 'dropoff' })];
    const m = make({ stops });
    m.redis.eval.mockRejectedValue(new Error('redis down'));
    m.poolProjection.project.mockRejectedValue(new Error('redis down'));
    m.bus.toRide.mockImplementation(() => {
      throw new Error('socket down');
    });
    m.bus.toDriver.mockImplementation(() => {
      throw new Error('socket down');
    });
    expect(await m.svc.confirmStop(input(0, 'dropoff'))).toMatchObject({ ok: true, rideCompleted: true });
  });
});

describe('RideLifecycleService.onStopConfirmRequest', () => {
  it('delegates the WS request and swallows a rejection into a log line', async () => {
    const { svc } = make({ pool: null });
    const spy = vi.spyOn(svc, 'confirmStop');
    await svc.onStopConfirmRequest({ ...input(0), driverId: 'd-1' });
    expect(spy).toHaveBeenCalledWith(input(0));
    expect(STOP_CONFIRM_REQUEST_EVENT).toBeTypeOf('string');
  });
});
