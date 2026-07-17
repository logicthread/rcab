import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DispatchService,
  computeStops,
  HARD_FAIL_JOB,
  WAVE_TIMEOUT_JOB,
  type HardFailJob,
  type WaveTimeoutJob,
} from './dispatch.service';
import type { Job } from 'bullmq';
import type { SharedRideMember, SharedRideRow } from '../matching/shared-ride.repository';
import type { RideRow } from '../rides/rides.repository';

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

function soloRide(overrides: Partial<RideRow> = {}): RideRow {
  return {
    id: 'ride-1',
    passengerId: 'c-1',
    originLat: 26.1445,
    originLng: 91.7362,
    destLat: 26.1758,
    destLng: 91.7898,
    fareCents: 18500,
    status: 'requested',
    type: 'normal',
    scheduledFor: null,
    idempotencyKey: 'idem-1',
    driverId: null,
    acceptedAt: null,
    enRouteAt: null,
    arrivedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    ...overrides,
  };
}

function buildRidesRepo(
  opts: {
    byId?: RideRow | null;
    claimResult?: RideRow | null;
    noDriverResult?: RideRow | null;
  } = {},
) {
  return {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(opts.byId === undefined ? soloRide() : opts.byId),
    findByIdempotencyKey: vi.fn(),
    claimSolo: vi
      .fn()
      .mockResolvedValue(
        opts.claimResult === undefined
          ? soloRide({ status: 'accepted', driverId: 'd-1', acceptedAt: new Date() })
          : opts.claimResult,
      ),
    markNoDriver: vi
      .fn()
      .mockResolvedValue(
        opts.noDriverResult === undefined ? soloRide({ status: 'no_driver' }) : opts.noDriverResult,
      ),
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
    offerType?: string | null;
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
      if (key.startsWith('offer:type:')) return opts.offerType ?? null;
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
  soloRide?: RideRow | null;
  soloClaimResult?: RideRow | null;
  soloNoDriverResult?: RideRow | null;
  geo?: string[];
  alreadyOffered?: string[];
  setNx?: string | null;
  evalResult?: number;
  offerListIds?: string[];
  offerOwners?: Record<string, string>;
  stopsCache?: string | null;
  metaResult?: string | null;
  offerType?: string | null;
  config?: Record<string, unknown>;
}

function makeService(opts: ServiceOpts = {}) {
  const repo = buildRepo({ byId: opts.byId });
  const ridesRepo = buildRidesRepo({
    byId: opts.soloRide,
    claimResult: opts.soloClaimResult,
    noDriverResult: opts.soloNoDriverResult,
  });
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
    offerType: opts.offerType,
  });
  const events = buildEvents();
  const config = buildConfig(opts.config ?? {});

  const svc = new DispatchService(
    repo as never,
    ridesRepo as never,
    stops as never,
    lifecycle as never,
    bus as never,
    queue as never,
    redis as never,
    events as never,
    config as never,
  );
  return { svc, repo, ridesRepo, stops, lifecycle, bus, queue, redis, events };
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

  it('accept w/o resolvable rideId: ignores', async () => {
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

  it('accept on a solo offer (winner): claims the rides row, never claimPool, confirms the driver', async () => {
    const { svc, repo, ridesRepo, bus } = makeService({
      metaResult: 'ride-1',
      offerType: 'solo',
    });
    await svc.onRideOfferResponse({ driverId: 'd-1', offerId: 'o-1', accept: true });

    expect(ridesRepo.claimSolo).toHaveBeenCalledWith('ride-1', 'd-1', expect.any(Date));
    expect(repo.setClaimed).not.toHaveBeenCalled(); // pool Lua untouched
    expect(bus.toDriver).toHaveBeenCalledWith('d-1', 'ride_offer_accepted', {
      offerId: 'o-1',
      rideId: 'ride-1',
    });
    // Booking client (already in ride:<id>) is told a driver was assigned so its
    // live-tracking view activates immediately (RCAB-E4.S7).
    expect(bus.toRide).toHaveBeenCalledWith('ride-1', 'ride_state_changed', {
      rideId: 'ride-1',
      state: 'accepted',
      by: 'driver',
    });
  });

  it('accept on a solo offer (lost the race): tells the driver the ride is taken', async () => {
    const { svc, ridesRepo, bus } = makeService({
      metaResult: 'ride-1',
      offerType: 'solo',
      setNx: null, // claim:ride SET NX fails → already claimed by someone
    });
    await svc.onRideOfferResponse({ driverId: 'd-2', offerId: 'o-2', accept: true });

    expect(ridesRepo.claimSolo).not.toHaveBeenCalled();
    expect(bus.toDriver).toHaveBeenCalledWith('d-2', 'ride_offer_revoked', {
      offerId: 'o-2',
      rideId: 'ride-1',
      reason: 'taken',
    });
  });
});

// ── dispatchSolo / runSoloWave (RCAB-E4.S3) ──────────────────────────────────

describe('DispatchService.dispatchSolo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips when the ride is not found', async () => {
    const { svc, bus } = makeService({ soloRide: null });
    await svc.dispatchSolo('missing');
    expect(bus.toDriver).not.toHaveBeenCalled();
  });

  it('skips when the ride is not in requested state', async () => {
    const { svc, bus, queue } = makeService({ soloRide: soloRide({ status: 'accepted' }) });
    await svc.dispatchSolo('ride-1');
    expect(bus.toDriver).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('wave 1: fans out a solo ride_offer to candidates + schedules wave-2 + hard-fail', async () => {
    const { svc, bus, queue } = makeService({ soloRide: soloRide(), geo: ['d-1', 'd-2'] });
    await svc.dispatchSolo('ride-1');

    expect(bus.toDriver).toHaveBeenCalledTimes(2);
    for (const call of bus.toDriver.mock.calls) {
      const [driverId, event, payload] = call as [
        string,
        string,
        { rideId: string; pickup: unknown; fareCents: number; waveNumber: number },
      ];
      expect(['d-1', 'd-2']).toContain(driverId);
      expect(event).toBe('ride_offer');
      expect(payload.rideId).toBe('ride-1');
      expect(payload.fareCents).toBe(18500);
      expect(payload.waveNumber).toBe(1);
      expect(payload.pickup).toEqual({ lat: 26.1445, lng: 91.7362 });
    }

    const jobNames = queue.add.mock.calls.map((c) => c[0]);
    expect(jobNames).toContain(WAVE_TIMEOUT_JOB);
    expect(jobNames).toContain(HARD_FAIL_JOB);
  });

  it('tags each solo offer with offer:type=solo', async () => {
    const { svc, redis } = makeService({ soloRide: soloRide(), geo: ['d-1'] });
    await svc.dispatchSolo('ride-1');
    const typeSet = redis.set.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('offer:type:'),
    );
    expect(typeSet).toBeDefined();
    expect(typeSet?.[1]).toBe('solo');
  });

  it('excludes drivers already in ride:<id>:offered', async () => {
    const { svc, bus } = makeService({
      soloRide: soloRide(),
      geo: ['d-1', 'd-2'],
      alreadyOffered: ['d-1'],
    });
    await svc.dispatchSolo('ride-1');
    expect(bus.toDriver).toHaveBeenCalledTimes(1);
    expect(bus.toDriver.mock.calls[0][0]).toBe('d-2');
  });
});

describe('DispatchService.onRideRequested', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches the solo ride named in the event payload', async () => {
    const { svc, bus } = makeService({ soloRide: soloRide(), geo: ['d-1'] });
    await svc.onRideRequested({ rideId: 'ride-1' });
    expect(bus.toDriver).toHaveBeenCalledTimes(1);
  });
});

// ── claimSolo (RCAB-E4.S4) ───────────────────────────────────────────────────

describe('DispatchService.claimSolo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('winner: binds the rides row, sets driver:state, removes wave-2 + hard-fail timers', async () => {
    const { svc, ridesRepo, redis, queue } = makeService();
    const result = await svc.claimSolo('ride-1', 'd-1');

    expect(result).toEqual({ ok: true, reason: 'claimed' });
    expect(redis.set).toHaveBeenCalledWith(
      'claim:ride:ride-1',
      'd-1',
      'EX',
      expect.any(Number),
      'NX',
    );
    expect(ridesRepo.claimSolo).toHaveBeenCalledWith('ride-1', 'd-1', expect.any(Date));
    expect(redis.hset).toHaveBeenCalledWith('driver:state:d-1', 'current_ride_id', 'ride-1');
    expect(queue.remove).toHaveBeenCalledWith('dispatch:wave2-timeout:ride-1');
    expect(queue.remove).toHaveBeenCalledWith('dispatch:hard-fail:ride-1');
  });

  it('lost the claim race (SET NX fails, held by another driver): already_taken, no DB write', async () => {
    const { svc, ridesRepo } = makeService({ setNx: null });
    const result = await svc.claimSolo('ride-1', 'd-2');
    expect(result).toEqual({ ok: false, reason: 'already_taken' });
    expect(ridesRepo.claimSolo).not.toHaveBeenCalled();
  });

  it('ride moved on after the Redis claim (DB guard matches 0 rows): not_claimable, releases claim', async () => {
    const { svc, redis } = makeService({ soloClaimResult: null });
    const result = await svc.claimSolo('ride-1', 'd-1');
    expect(result).toEqual({ ok: false, reason: 'not_claimable' });
    expect(redis.del).toHaveBeenCalledWith('claim:ride:ride-1');
  });

  it('revokes losing offers but NOT the winner', async () => {
    const { svc, bus } = makeService({
      offerListIds: ['o-win', 'o-lose'],
      offerOwners: { 'o-win': 'd-1', 'o-lose': 'd-2' },
    });
    await svc.claimSolo('ride-1', 'd-1');

    expect(bus.toDriver).toHaveBeenCalledWith('d-2', 'ride_offer_revoked', expect.any(Object));
    expect(bus.toDriver).not.toHaveBeenCalledWith('d-1', 'ride_offer_revoked', expect.any(Object));
  });
});

// ── solo wave-2 / hard-fail handlers (RCAB-E4.S4) ─────────────────────────────

describe('DispatchService.handleWaveTimeout (solo)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('kind=solo + still requested: runs wave 2 and re-offers', async () => {
    const { svc, bus, queue } = makeService({ soloRide: soloRide(), geo: ['d-9'] });
    await svc.handleWaveTimeout({
      data: { rideId: 'ride-1', waveNumber: 2, kind: 'solo' },
    } as Job<WaveTimeoutJob>);

    expect(bus.toDriver).toHaveBeenCalledTimes(1);
    const [driverId, event, payload] = bus.toDriver.mock.calls[0] as [
      string,
      string,
      { waveNumber: number },
    ];
    expect(driverId).toBe('d-9');
    expect(event).toBe('ride_offer');
    expect(payload.waveNumber).toBe(2);
    // wave 2 does not schedule further timers
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('kind=solo but ride no longer requested: stale no-op', async () => {
    const { svc, bus } = makeService({ soloRide: soloRide({ status: 'accepted' }) });
    await svc.handleWaveTimeout({
      data: { rideId: 'ride-1', waveNumber: 2, kind: 'solo' },
    } as Job<WaveTimeoutJob>);
    expect(bus.toDriver).not.toHaveBeenCalled();
  });
});

describe('DispatchService.handleHardFail (solo)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('kind=solo: marks no_driver, revokes offers, notifies the passenger', async () => {
    const { svc, ridesRepo, bus } = makeService({
      offerListIds: ['o-1'],
      offerOwners: { 'o-1': 'd-1' },
    });
    await svc.handleHardFail({ data: { rideId: 'ride-1', kind: 'solo' } } as Job<HardFailJob>);

    expect(ridesRepo.markNoDriver).toHaveBeenCalledWith('ride-1');
    expect(bus.toDriver).toHaveBeenCalledWith('d-1', 'ride_offer_revoked', expect.any(Object));
    expect(bus.toUser).toHaveBeenCalledWith('c-1', 'ride_no_driver', { rideId: 'ride-1' });
  });

  it('kind=solo but the ride was just claimed (guard matches 0 rows): no-op', async () => {
    const { svc, bus } = makeService({ soloNoDriverResult: null });
    await svc.handleHardFail({ data: { rideId: 'ride-1', kind: 'solo' } } as Job<HardFailJob>);
    expect(bus.toUser).not.toHaveBeenCalled();
  });
});

describe('DispatchService.onRideCancelled / releaseDispatch (RCAB-E4.S8)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops the claim, revokes outstanding offers, removes both timers', async () => {
    const { svc, redis, queue, bus } = makeService({
      offerListIds: ['o-1'],
      offerOwners: { 'o-1': 'd-loser' },
    });
    await svc.onRideCancelled({ rideId: 'ride-1', driverId: 'd-1' });

    expect(redis.del).toHaveBeenCalledWith('claim:ride:ride-1');
    expect(redis.del).toHaveBeenCalledWith('offer:o-1');
    expect(bus.toDriver).toHaveBeenCalledWith(
      'd-loser',
      'ride_offer_revoked',
      expect.objectContaining({ offerId: 'o-1' }),
    );
    expect(queue.remove).toHaveBeenCalledWith('dispatch:wave2-timeout:ride-1');
    expect(queue.remove).toHaveBeenCalledWith('dispatch:hard-fail:ride-1');
  });

  it('is a safe no-op when nothing is in flight', async () => {
    const { svc, redis, queue, bus } = makeService({ offerListIds: [] });
    await expect(
      svc.onRideCancelled({ rideId: 'ride-9', driverId: null }),
    ).resolves.toBeUndefined();

    // del + timer removal are always attempted (each a no-op if the key is absent).
    expect(redis.del).toHaveBeenCalledWith('claim:ride:ride-9');
    expect(queue.remove).toHaveBeenCalledWith('dispatch:wave2-timeout:ride-9');
    expect(queue.remove).toHaveBeenCalledWith('dispatch:hard-fail:ride-9');
    expect(bus.toDriver).not.toHaveBeenCalled();
  });
});
