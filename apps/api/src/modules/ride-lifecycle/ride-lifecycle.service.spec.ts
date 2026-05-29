import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RideLifecycleService,
  STOP_PICKUP_EVENT,
  STOP_DROP_EVENT,
  RIDE_COMPLETED_EVENT,
} from './ride-lifecycle.service';
import type { RideStopRow } from '../matching/ride-stop.repository';
import type { SharedRideRow } from '../matching/shared-ride.repository';

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

function shared(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId: 'r-1',
    seatCount: 2,
    maxSeats: 3,
    poolState: 'closed_full',
    poolClosedAt: new Date(),
    detourBudgetM: 800,
    originLat: 0,
    originLng: 0,
    destLat: 0,
    destLng: 0,
    members: [],
    claimedByDriverId: 'd-1',
    claimedAt: new Date(),
    ...overrides,
  };
}

interface MakeOpts {
  ride?: SharedRideRow | null;
  stopsByRide?: RideStopRow[];
  pendingAfter?: number[];
  confirmResult?: RideStopRow | null;
}

function make(opts: MakeOpts = {}) {
  const sharedRepo = {
    findById: vi.fn().mockResolvedValue(opts.ride === undefined ? shared() : opts.ride),
  };
  let pendingCalls = 0;
  const stopsRepo = {
    seed: vi.fn(),
    findByRideId: vi.fn().mockResolvedValue(opts.stopsByRide ?? []),
    confirm: vi
      .fn()
      .mockImplementation(
        async (_rideId: string, idx: number, at: Date): Promise<RideStopRow | null> => {
          if (opts.confirmResult !== undefined) return opts.confirmResult;
          const existing = (opts.stopsByRide ?? []).find((s) => s.sequenceIndex === idx);
          return existing ? { ...existing, confirmedAt: at } : null;
        },
      ),
    countPending: vi.fn().mockImplementation(async () => {
      const seq = opts.pendingAfter ?? [];
      const next = seq[pendingCalls] ?? 0;
      pendingCalls += 1;
      return next;
    }),
    markRideCompleted: vi.fn().mockResolvedValue(undefined),
    markRideStarted: vi.fn().mockResolvedValue(undefined),
  };
  const bus = {
    toUser: vi.fn(),
    toDriver: vi.fn(),
    toRide: vi.fn(),
    toPool: vi.fn(),
    joinPool: vi.fn(),
    broadcast: vi.fn(),
  };
  const redis = { hdel: vi.fn().mockResolvedValue(1) };

  const svc = new RideLifecycleService(
    sharedRepo as never,
    stopsRepo as never,
    bus as never,
    redis as never,
  );
  return { svc, sharedRepo, stopsRepo, bus, redis };
}

describe('RideLifecycleService.confirmStop', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects when ride not found', async () => {
    const { svc } = make({ ride: null });
    const result = await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 0,
      type: 'pickup',
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects when caller is not the claimed driver', async () => {
    const { svc, bus } = make({ ride: shared({ claimedByDriverId: 'd-other' }) });
    const result = await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 0,
      type: 'pickup',
    });
    expect(result).toEqual({ ok: false, reason: 'not_owner' });
    expect(bus.toDriver).not.toHaveBeenCalled();
  });

  it('rejects when sequenceIndex is not the next pending stop', async () => {
    const stops = [
      stop({ sequenceIndex: 0, type: 'pickup' }),
      stop({ sequenceIndex: 1, type: 'dropoff' }),
    ];
    const { svc } = make({ stopsByRide: stops });
    const result = await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 1,
      type: 'dropoff',
    });
    expect(result).toEqual({ ok: false, reason: 'out_of_order' });
  });

  it('rejects when type mismatches the stop record', async () => {
    const stops = [stop({ sequenceIndex: 0, type: 'pickup' })];
    const { svc } = make({ stopsByRide: stops });
    const result = await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 0,
      type: 'dropoff',
    });
    expect(result).toEqual({ ok: false, reason: 'wrong_type' });
  });

  it('rejects already-confirmed stop', async () => {
    const stops = [stop({ sequenceIndex: 0, type: 'pickup', confirmedAt: new Date() })];
    const { svc } = make({ stopsByRide: stops });
    const result = await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 0,
      type: 'pickup',
    });
    expect(result).toEqual({ ok: false, reason: 'already_confirmed' });
  });

  it('confirms first pickup → marks ride started, emits echo, does not complete', async () => {
    const stops = [
      stop({ sequenceIndex: 0, type: 'pickup' }),
      stop({ sequenceIndex: 1, type: 'pickup' }),
      stop({ sequenceIndex: 2, type: 'dropoff' }),
      stop({ sequenceIndex: 3, type: 'dropoff' }),
    ];
    const { svc, stopsRepo, bus } = make({ stopsByRide: stops, pendingAfter: [3] });

    const result = await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 0,
      type: 'pickup',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rideCompleted).toBe(false);
    expect(result.pendingAfter).toBe(3);
    expect(stopsRepo.markRideStarted).toHaveBeenCalledWith('r-1');
    expect(stopsRepo.markRideCompleted).not.toHaveBeenCalled();
    expect(bus.toDriver).toHaveBeenCalledWith(
      'd-1',
      STOP_PICKUP_EVENT,
      expect.objectContaining({
        rideId: 'r-1',
        sequenceIndex: 0,
        type: 'pickup',
        rideCompleted: false,
      }),
    );
  });

  it('confirms last drop → marks ride completed, clears driver:state, emits ride:completed', async () => {
    const stops = [
      stop({ sequenceIndex: 0, type: 'pickup', confirmedAt: new Date() }),
      stop({ sequenceIndex: 1, type: 'dropoff' }),
    ];
    const { svc, stopsRepo, bus, redis } = make({ stopsByRide: stops, pendingAfter: [0] });

    const result = await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 1,
      type: 'dropoff',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rideCompleted).toBe(true);
    expect(stopsRepo.markRideCompleted).toHaveBeenCalledWith('r-1', expect.any(Date));
    expect(redis.hdel).toHaveBeenCalledWith('driver:state:d-1', 'current_ride_id');
    expect(bus.toRide).toHaveBeenCalledWith(
      'r-1',
      RIDE_COMPLETED_EVENT,
      expect.objectContaining({
        rideId: 'r-1',
      }),
    );
    expect(bus.toDriver).toHaveBeenCalledWith(
      'd-1',
      STOP_DROP_EVENT,
      expect.objectContaining({
        rideCompleted: true,
      }),
    );
  });

  it('does NOT call markRideStarted when there was already a confirmed stop', async () => {
    const stops = [
      stop({ sequenceIndex: 0, type: 'pickup', confirmedAt: new Date() }),
      stop({ sequenceIndex: 1, type: 'pickup' }),
      stop({ sequenceIndex: 2, type: 'dropoff' }),
    ];
    const { svc, stopsRepo } = make({ stopsByRide: stops, pendingAfter: [1] });
    await svc.confirmStop({
      rideId: 'r-1',
      driverId: 'd-1',
      sequenceIndex: 1,
      type: 'pickup',
    });
    expect(stopsRepo.markRideStarted).not.toHaveBeenCalled();
  });
});
