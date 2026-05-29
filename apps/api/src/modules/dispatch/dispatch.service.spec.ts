import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DispatchService, computeStops, HARD_FAIL_JOB, WAVE_TIMEOUT_JOB } from './dispatch.service';
import type { Job } from 'bullmq';
import type { SharedRideMember, SharedRideRow } from '../matching/shared-ride.repository';

function member(overrides: Partial<SharedRideMember> = {}): SharedRideMember {
  return {
    passenger_id: 'p-1',
    origin_lat: 22.5727,
    origin_lng: 88.364,
    dest_lat: 22.5801,
    dest_lng: 88.3701,
    joined_at: '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

function pool(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId: 'pool-1',
    seatCount: 2,
    maxSeats: 3,
    poolState: 'closed_full',
    poolClosedAt: new Date('2026-05-29T00:01:00.000Z'),
    detourBudgetM: 800,
    originLat: 22.5727,
    originLng: 88.364,
    destLat: 22.5801,
    destLng: 88.3701,
    members: [member()],
    claimedByDriverId: null,
    claimedAt: null,
    ...overrides,
  };
}

function buildRepo(opts: { byId?: SharedRideRow | null } = {}) {
  return {
    findCandidates: vi.fn(),
    findById: vi.fn().mockResolvedValue(opts.byId ?? null),
    create: vi.fn(),
    incrementSeats: vi.fn(),
    appendMember: vi.fn(),
    closePool: vi.fn(),
    setClaimed: vi.fn().mockResolvedValue(undefined),
  };
}

function buildStops() {
  return {
    seed: vi.fn().mockResolvedValue(undefined),
    findByRideId: vi.fn().mockResolvedValue([]),
    confirm: vi.fn().mockResolvedValue(null),
    countPending: vi.fn().mockResolvedValue(0),
    markRideCompleted: vi.fn().mockResolvedValue(undefined),
    markRideStarted: vi.fn().mockResolvedValue(undefined),
  };
}

function buildLifecycle() {
  return { closePool: vi.fn().mockResolvedValue(undefined) };
}

function buildBus() {
  return { toDriver: vi.fn(), toUser: vi.fn(), toRide: vi.fn(), broadcast: vi.fn() };
}

function buildQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job' }),
    remove: vi.fn().mockResolvedValue(1),
  };
}

function buildRedis(
  opts: {
    geoCandidates?: string[];
    alreadyOffered?: string[];
    setNxResult?: string | null;
    evalResult?: number;
    offerListIds?: string[];
    offerOwners?: Record<string, string>;
    stopsCache?: string | null;
    metaResult?: string | null;
  } = {},
) {
  const setNxResult = opts.setNxResult === undefined ? 'OK' : opts.setNxResult;
  return {
    smembers: vi.fn().mockImplementation(async (key: string) => {
      if (key.endsWith(':offered')) return opts.alreadyOffered ?? [];
      if (key.startsWith('offer:list:')) return opts.offerListIds ?? [];
      return [];
    }),
    georadius: vi.fn().mockResolvedValue(opts.geoCandidates ?? []),
    set: vi
      .fn()
      .mockImplementation(async (_k: string, _v: string, ..._rest: unknown[]) => setNxResult),
    sadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    hset: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'pool:pool-1:stops') return opts.stopsCache ?? null;
      if (key.startsWith('offer:meta:')) return opts.metaResult ?? null;
      if (key.startsWith('offer:')) return opts.offerOwners?.[key.replace('offer:', '')] ?? null;
      return null;
    }),
    eval: vi.fn().mockResolvedValue(opts.evalResult ?? 1),
  };
}

function buildEvents() {
  return { emit: vi.fn() };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return { get: vi.fn((key: string) => overrides[key]) };
}

interface ServiceOpts {
  byId?: SharedRideRow | null;
  geo?: string[];
  alreadyOffered?: string[];
  setNx?: string | null;
  evalResult?: number;
  offerListIds?: string[];
  offerOwners?: Record<string, string>;
  stopsCache?: string | null;
  metaResult?: string | null;
  config?: Record<string, unknown>;
}

function makeService(opts: ServiceOpts = {}) {
  const repo = buildRepo({ byId: opts.byId });
  const stops = buildStops();
  const lifecycle = buildLifecycle();
  const bus = buildBus();
  const queue = buildQueue();
  const redis = buildRedis({
    geoCandidates: opts.geo,
    alreadyOffered: opts.alreadyOffered,
    setNxResult: opts.setNx,
    evalResult: opts.evalResult,
    offerListIds: opts.offerListIds,
    offerOwners: opts.offerOwners,
    stopsCache: opts.stopsCache,
    metaResult: opts.metaResult,
  });
  const events = buildEvents();
  const config = buildConfig(opts.config ?? {});

  const svc = new DispatchService(
    repo as never,
    stops as never,
    lifecycle as never,
    bus as never,
    queue as never,
    redis as never,
    events as never,
    config as never,
  );
  return { svc, repo, stops, lifecycle, bus, queue, redis, events };
}

// ── computeStops ─────────────────────────────────────────────────────────────

describe('computeStops', () => {
  it('emits 2 stops per member (pickup + dropoff) with contiguous sequenceIndex', () => {
    const p = pool({
      members: [
        member({ passenger_id: 'a' }),
        member({
          passenger_id: 'b',
          origin_lat: 22.6,
          origin_lng: 88.4,
          dest_lat: 22.61,
          dest_lng: 88.41,
        }),
      ],
    });
    const stops = computeStops(p);

    expect(stops).toHaveLength(4);
    expect(stops.map((s) => s.sequenceIndex)).toEqual([0, 1, 2, 3]);
    expect(stops.filter((s) => s.type === 'pickup')).toHaveLength(2);
    expect(stops.filter((s) => s.type === 'dropoff')).toHaveLength(2);
  });

  it('sorts pickups by proximity to pool origin_centroid', () => {
    const p = pool({
      originLat: 22.5727,
      originLng: 88.364,
      members: [
        member({ passenger_id: 'far', origin_lat: 22.6, origin_lng: 88.4 }),
        member({ passenger_id: 'near', origin_lat: 22.5728, origin_lng: 88.3641 }),
      ],
    });
    const stops = computeStops(p);

    const pickups = stops.filter((s) => s.type === 'pickup');
    expect(pickups[0].passengerId).toBe('near');
    expect(pickups[1].passengerId).toBe('far');
  });
});

// ── dispatchPool / runWave ───────────────────────────────────────────────────

describe('DispatchService.dispatchPool', () => {
  it('skips when pool not found', async () => {
    const { svc, bus } = makeService({ byId: null });
    await svc.dispatchPool('missing');
    expect(bus.toDriver).not.toHaveBeenCalled();
  });

  it('skips when pool already claimed', async () => {
    const { svc, bus, queue } = makeService({
      byId: pool({ claimedByDriverId: 'd-other' }),
    });
    await svc.dispatchPool('pool-1');
    expect(bus.toDriver).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('wave 1: fans out ride_offer to K1 drivers with stops payload + schedules wave-2 + hard-fail', async () => {
    const { svc, bus, queue, redis } = makeService({
      byId: pool(),
      geo: ['d-1', 'd-2', 'd-3'],
    });

    await svc.dispatchPool('pool-1');

    // Each driver gets a ride_offer with stops + waveNumber=1
    expect(bus.toDriver).toHaveBeenCalledTimes(3);
    for (const call of bus.toDriver.mock.calls) {
      const [driverId, event, payload] = call as [
        string,
        string,
        { stops: unknown; waveNumber: number; sharedRideId: string },
      ];
      expect(['d-1', 'd-2', 'd-3']).toContain(driverId);
      expect(event).toBe('ride_offer');
      expect(payload.sharedRideId).toBe('pool-1');
      expect(payload.waveNumber).toBe(1);
      expect(Array.isArray(payload.stops)).toBe(true);
    }

    // K1 default = 5; we have 3 candidates so all 3 reserved (each candidate:
    // offer:<id> SET NX EX + offer:meta:<id> SET EX) plus one pool:<id>:stops cache write.
    const offerLockCalls = redis.set.mock.calls.filter(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).startsWith('offer:') &&
        !(c[0] as string).startsWith('offer:meta:'),
    );
    expect(offerLockCalls).toHaveLength(3);

    // Wave-2 + hard-fail scheduled
    const jobNames = queue.add.mock.calls.map((c) => c[0]);
    expect(jobNames).toContain(WAVE_TIMEOUT_JOB);
    expect(jobNames).toContain(HARD_FAIL_JOB);
  });

  it('wave 1: excludes drivers already in pool:<id>:offered', async () => {
    const { svc, bus } = makeService({
      byId: pool(),
      geo: ['d-1', 'd-2'],
      alreadyOffered: ['d-1'],
    });

    await svc.dispatchPool('pool-1');

    expect(bus.toDriver).toHaveBeenCalledTimes(1);
    expect(bus.toDriver.mock.calls[0][0]).toBe('d-2');
  });

  it('wave 1: skips a candidate whose offer:<id> SET NX returns null (race)', async () => {
    const { svc, bus } = makeService({
      byId: pool(),
      geo: ['d-1'],
      setNx: null,
    });
    await svc.dispatchPool('pool-1');
    expect(bus.toDriver).not.toHaveBeenCalled();
  });
});

// ── handleHardFail ───────────────────────────────────────────────────────────

describe('DispatchService.handleHardFail', () => {
  it('closes pool as aborted, revokes outstanding offers', async () => {
    const { svc, lifecycle, redis, bus } = makeService({
      byId: pool(),
      offerListIds: ['offer-1', 'offer-2'],
      offerOwners: { 'offer-1': 'd-1', 'offer-2': 'd-2' },
    });

    const job = { data: { rideId: 'pool-1' } } as Job<{ rideId: string }>;
    await svc.handleHardFail(job);

    expect(lifecycle.closePool).toHaveBeenCalledWith('pool-1', 'aborted');
    expect(redis.del).toHaveBeenCalledWith('offer:offer-1');
    expect(redis.del).toHaveBeenCalledWith('offer:offer-2');
    expect(bus.toDriver).toHaveBeenCalledWith('d-1', 'ride_offer_revoked', expect.any(Object));
    expect(bus.toDriver).toHaveBeenCalledWith('d-2', 'ride_offer_revoked', expect.any(Object));
  });

  it('skips abort when pool was already claimed', async () => {
    const { svc, lifecycle } = makeService({
      byId: pool({ claimedByDriverId: 'd-1' }),
    });
    const job = { data: { rideId: 'pool-1' } } as Job<{ rideId: string }>;
    await svc.handleHardFail(job);
    expect(lifecycle.closePool).not.toHaveBeenCalled();
  });
});

// ── claimPool ────────────────────────────────────────────────────────────────

describe('DispatchService.claimPool', () => {
  it('ok=true on Lua return 1: sets DB claimed_by, revokes offers, removes timers', async () => {
    const { svc, repo, queue } = makeService({
      evalResult: 1,
      offerListIds: [],
    });

    const result = await svc.claimPool('pool-1', 'd-1');
    expect(result).toEqual({ ok: true, reason: 'claimed' });
    expect(repo.setClaimed).toHaveBeenCalledWith('pool-1', 'd-1', expect.any(Date));
    expect(queue.remove).toHaveBeenCalledWith('dispatch:wave2-timeout:pool-1');
    expect(queue.remove).toHaveBeenCalledWith('dispatch:hard-fail:pool-1');
  });

  it('writes driver:state.current_ride_id on successful claim', async () => {
    const { svc, redis } = makeService({ evalResult: 1 });
    await svc.claimPool('pool-1', 'd-1');
    expect(redis.hset).toHaveBeenCalledWith('driver:state:d-1', 'current_ride_id', 'pool-1');
  });

  it('seeds ride_stops from pool:<id>:stops cache after successful claim', async () => {
    const cached = JSON.stringify([
      { type: 'pickup', lat: 22.5727, lng: 88.364, passengerId: 'p-1', sequenceIndex: 0 },
      { type: 'dropoff', lat: 22.5801, lng: 88.3701, passengerId: 'p-1', sequenceIndex: 1 },
    ]);
    const { svc, stops } = makeService({ evalResult: 1, stopsCache: cached });

    await svc.claimPool('pool-1', 'd-1');

    expect(stops.seed).toHaveBeenCalledTimes(1);
    expect(stops.seed).toHaveBeenCalledWith('pool-1', [
      { sequenceIndex: 0, passengerId: 'p-1', type: 'pickup', lat: 22.5727, lng: 88.364 },
      { sequenceIndex: 1, passengerId: 'p-1', type: 'dropoff', lat: 22.5801, lng: 88.3701 },
    ]);
  });

  it('skips ride_stops seed when cache is empty (logs warning, no throw)', async () => {
    const { svc, stops } = makeService({ evalResult: 1, stopsCache: null });
    const result = await svc.claimPool('pool-1', 'd-1');
    expect(result.ok).toBe(true);
    expect(stops.seed).not.toHaveBeenCalled();
  });

  it('does not seed ride_stops when Lua claim fails', async () => {
    const cached = JSON.stringify([
      { type: 'pickup', lat: 0, lng: 0, passengerId: 'p-1', sequenceIndex: 0 },
    ]);
    const { svc, stops } = makeService({ evalResult: 0, stopsCache: cached });
    await svc.claimPool('pool-1', 'd-1');
    expect(stops.seed).not.toHaveBeenCalled();
  });

  it('returns already_taken on Lua return 0', async () => {
    const { svc, repo } = makeService({ evalResult: 0 });
    const result = await svc.claimPool('pool-1', 'd-1');
    expect(result).toEqual({ ok: false, reason: 'already_taken' });
    expect(repo.setClaimed).not.toHaveBeenCalled();
  });

  it('returns not_closed on Lua return -1', async () => {
    const { svc } = makeService({ evalResult: -1 });
    const result = await svc.claimPool('pool-1', 'd-1');
    expect(result).toEqual({ ok: false, reason: 'not_closed' });
  });

  it('returns not_found on Lua return -2', async () => {
    const { svc } = makeService({ evalResult: -2 });
    const result = await svc.claimPool('pool-1', 'd-1');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

// ── onRideOfferResponse ──────────────────────────────────────────────────────

describe('DispatchService.onRideOfferResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decline: deletes offer lock; no claim attempt', async () => {
    const { svc, redis, repo } = makeService();
    await svc.onRideOfferResponse({
      driverId: 'd-1',
      offerId: 'o-1',
      sharedRideId: 'pool-1',
      accept: false,
    });
    expect(redis.del).toHaveBeenCalledWith('offer:o-1');
    expect(repo.setClaimed).not.toHaveBeenCalled();
  });

  it('accept w/ sharedRideId: calls claimPool', async () => {
    const { svc, repo } = makeService({ evalResult: 1 });
    await svc.onRideOfferResponse({
      driverId: 'd-1',
      offerId: 'o-1',
      sharedRideId: 'pool-1',
      accept: true,
    });
    expect(repo.setClaimed).toHaveBeenCalledWith('pool-1', 'd-1', expect.any(Date));
  });

  it('accept w/o sharedRideId: resolves rideId via offer:meta:<offerId>', async () => {
    const { svc, repo } = makeService({
      evalResult: 1,
      metaResult: 'pool-from-meta',
    });
    await svc.onRideOfferResponse({
      driverId: 'd-1',
      offerId: 'o-1',
      accept: true,
    });
    expect(repo.setClaimed).toHaveBeenCalledWith('pool-from-meta', 'd-1', expect.any(Date));
  });

  it('accept w/o resolvable rideId: ignores (logs TODO solo path)', async () => {
    const { svc, repo } = makeService({
      evalResult: 1,
      metaResult: null,
    });
    await svc.onRideOfferResponse({
      driverId: 'd-1',
      offerId: 'o-1',
      accept: true,
    });
    expect(repo.setClaimed).not.toHaveBeenCalled();
  });
});
