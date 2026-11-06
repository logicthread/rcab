import { describe, it, expect, vi } from 'vitest';
import {
  DispatchService,
  computeStops,
  HARD_FAIL_JOB,
  WAVE_TIMEOUT_JOB,
  hardFailJobId,
  legacyHardFailJobId,
  legacyWaveTwoJobId,
  waveTwoJobId,
  type HardFailJob,
  type WaveTimeoutJob,
} from './dispatch.service';
import type { Job } from 'bullmq';
import type { SharedRideMember, SharedRideRow } from '../matching/shared-ride.repository';
import type { RideRow } from '../rides/rides.repository';
import type { OfferRow } from './offer.repository';
import type { SharedTripLockRow } from './assignment.repository';

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
    dispatchGeneration: 1,
    stateVersion: 0,
    ...overrides,
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
    dispatchGeneration: 1,
    ...overrides,
  };
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

  it('orders dropoffs by destination coordinates, not pickup coordinates (F16)', () => {
    // Identical origins; only the destinations differ. Swapping the two
    // destinations must swap the dropoff order.
    const near = { dest_lat: 22.5802, dest_lng: 88.3702 };
    const far = { dest_lat: 22.65, dest_lng: 88.45 };
    const base = { origin_lat: 22.5727, origin_lng: 88.364 };
    const build = (aDest: typeof near, bDest: typeof near) =>
      computeStops(
        pool({
          destLat: 22.5801,
          destLng: 88.3701,
          members: [
            member({ passenger_id: 'a', ...base, ...aDest }),
            member({ passenger_id: 'b', ...base, ...bDest }),
          ],
        }),
      )
        .filter((s) => s.type === 'dropoff')
        .map((s) => s.passengerId);

    expect(build(near, far)).toEqual(['a', 'b']);
    expect(build(far, near)).toEqual(['b', 'a']);
  });
});

describe('computeStops dropoff ordering (nearest-neighbour from last pickup)', () => {
  // Everyone is picked up at the same spot; destinations run east at +1/+2/+3
  // "steps". The anchor's destination (pool.dest) is the farthest one, so the
  // old ascending-distance-from-pool.dest order drove 3 -> 2 -> 1 (backtracking).
  const O = { origin_lat: 22.5727, origin_lng: 88.364 };
  const at = (k: number) => ({ dest_lat: 22.5727, dest_lng: 88.364 + 0.01 * k });

  it('visits dropoffs outward along the route instead of backtracking', () => {
    const p = pool({
      originLat: O.origin_lat,
      originLng: O.origin_lng,
      destLat: at(3).dest_lat,
      destLng: at(3).dest_lng,
      members: [
        member({ passenger_id: 'c', ...O, ...at(3) }),
        member({ passenger_id: 'a', ...O, ...at(1) }),
        member({ passenger_id: 'b', ...O, ...at(2) }),
      ],
    });
    const dropoffs = computeStops(p).filter((s) => s.type === 'dropoff');
    expect(dropoffs.map((s) => s.passengerId)).toEqual(['a', 'b', 'c']);
    expect(dropoffs.map((s) => s.sequenceIndex)).toEqual([3, 4, 5]);
  });

  it('starts from the LAST pickup, not the pool origin', () => {
    // Two pickups; the last one (farthest from pool origin) is next to d2.
    const p = pool({
      originLat: 22.5,
      originLng: 88.3,
      members: [
        member({
          passenger_id: 'first',
          origin_lat: 22.5,
          origin_lng: 88.3,
          dest_lat: 22.5,
          dest_lng: 88.1,
        }),
        member({
          passenger_id: 'last',
          origin_lat: 22.5,
          origin_lng: 88.5,
          dest_lat: 22.5,
          dest_lng: 88.7,
        }),
      ],
    });
    const stops = computeStops(p);
    expect(stops.filter((s) => s.type === 'pickup').map((s) => s.passengerId)).toEqual([
      'first',
      'last',
    ]);
    // From 88.5: 'last' dest (88.7, 0.2 away) is nearer than 'first' dest (88.1, 0.4 away).
    expect(stops.filter((s) => s.type === 'dropoff').map((s) => s.passengerId)).toEqual([
      'last',
      'first',
    ]);
  });

  it('is deterministic regardless of member input order (ties break on passenger id)', () => {
    const ms = ['x', 'y', 'z'].map((id) => member({ passenger_id: id, ...O, ...at(1) }));
    const ids = (members: SharedRideMember[]) =>
      computeStops(pool({ originLat: O.origin_lat, originLng: O.origin_lng, members }))
        .filter((s) => s.type === 'dropoff')
        .map((s) => s.passengerId);
    expect(ids(ms)).toEqual(['x', 'y', 'z']);
    expect(ids([...ms].reverse())).toEqual(['x', 'y', 'z']);
  });
});

// ── dispatchPool / runWave ───────────────────────────────────────────────────

// ── DispatchService (unit: repositories + infra mocked) ──────────────────────

const OFFER = '00000000-0000-4000-8000-000000000001';
const DRIVER = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const RIDE = '00000000-0000-4000-8000-0000000000aa';
const POOL = '00000000-0000-4000-8000-0000000000bb';

function offerRow(overrides: Partial<OfferRow> = {}): OfferRow {
  return {
    id: OFFER,
    trip: { kind: 'solo', rideId: RIDE },
    driverId: DRIVER,
    generation: 1,
    waveNumber: 1,
    state: 'offered',
    offeredAt: new Date(),
    expiresAt: new Date(Date.now() + 10_000),
    resolvedAt: null,
    lapsed: false,
    ...overrides,
  };
}

function poolLock(overrides: Partial<SharedTripLockRow> = {}): SharedTripLockRow {
  return {
    rideId: POOL,
    poolState: 'closed_full',
    seatCount: 2,
    maxSeats: 3,
    claimedByDriverId: null,
    dispatchGeneration: 1,
    stateVersion: 3,
    ...overrides,
  };
}

function stopRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    rideId: POOL,
    sequenceIndex: i,
    passengerId: `p-${i}`,
    type: (i < n / 2 ? 'pickup' : 'dropoff') as 'pickup' | 'dropoff',
    lat: 22.57,
    lng: 88.36,
    confirmedAt: null,
  }));
}

function makeService(config: Record<string, unknown> = {}) {
  const tx = { tx: true };
  const db = { transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
  const repo = { findById: vi.fn().mockResolvedValue(pool()) };
  const ridesRepo = {
    findById: vi.fn().mockResolvedValue(soloRide({ id: RIDE })),
    markNoDriver: vi.fn().mockResolvedValue(null),
  };
  const stops = {
    findByRideId: vi.fn().mockResolvedValue(stopRows(4)),
    countAll: vi.fn().mockResolvedValue(4),
  };
  const offers = {
    findForDriver: vi.fn().mockResolvedValue(offerRow()),
    lockForUpdate: vi.fn().mockResolvedValue(offerRow()),
    resolveLive: vi.fn().mockResolvedValue(true),
    markAccepted: vi.fn().mockResolvedValue(undefined),
    decline: vi.fn().mockResolvedValue('declined'),
    revokeLiveForTrip: vi.fn().mockResolvedValue([]),
    createOffer: vi.fn().mockImplementation(async () => ({
      offerId: OFFER,
      expiresAt: new Date('2026-11-06T00:00:12.000Z'),
    })),
    offeredDriverIds: vi.fn().mockResolvedValue([]),
    eligibleCandidates: vi.fn().mockImplementation(async (_db: unknown, ids: string[]) => ids),
  };
  const assignments = {
    lockSoloTrip: vi.fn().mockResolvedValue(soloRide({ id: RIDE })),
    lockSharedTrip: vi.fn().mockResolvedValue(poolLock()),
    findByTrip: vi.fn().mockResolvedValue(null),
    driverEligibility: vi.fn().mockResolvedValue('ok'),
    acquire: vi.fn().mockResolvedValue({ ok: true }),
    claimSoloRow: vi.fn().mockResolvedValue(soloRide({ id: RIDE, status: 'accepted' })),
    claimSharedRow: vi.fn().mockResolvedValue(undefined),
    abortUnclaimedPool: vi.fn().mockResolvedValue(true),
  };
  const projection = { set: vi.fn().mockResolvedValue(undefined) };
  const poolProjection = { project: vi.fn().mockResolvedValue(null) };
  const bus = { toDriver: vi.fn(), toUser: vi.fn(), toRide: vi.fn() };
  const queue = {
    add: vi.fn().mockResolvedValue({ id: 'job' }),
    remove: vi.fn().mockResolvedValue(1),
  };
  const redis = { georadius: vi.fn().mockResolvedValue([]) };
  const snapshots = {
    driverAssignment: vi.fn().mockImplementation(async (driverId: string) => ({
      driverId,
      assignment: null,
    })),
    publishPoolUpdate: vi.fn().mockResolvedValue(undefined),
  };
  const svc = new DispatchService(
    repo as never,
    ridesRepo as never,
    stops as never,
    offers as never,
    assignments as never,
    projection as never,
    bus as never,
    queue as never,
    redis as never,
    db as never,
    { get: vi.fn((k: string) => config[k]) } as never,
    poolProjection as never,
    snapshots as never,
  );
  return {
    svc,
    snapshots,
    db,
    tx,
    repo,
    ridesRepo,
    stops,
    offers,
    assignments,
    projection,
    poolProjection,
    bus,
    queue,
    redis,
  };
}

describe('job ids (contract §1.3 rule 7)', () => {
  it('are generation-scoped and colon-free; legacy ids are kept for removal', () => {
    expect(waveTwoJobId('t', 3)).toBe('dispatch-wave2-t-g3');
    expect(hardFailJobId('t', 3)).toBe('dispatch-hardfail-t-g3');
    expect(legacyWaveTwoJobId('t')).toBe('dispatch:wave2-timeout:t');
    expect(legacyHardFailJobId('t')).toBe('dispatch:hard-fail:t');
  });
});

describe('DispatchService.onRideOfferResponse', () => {
  it('routes accept and decline and returns the result (the gateway ack)', async () => {
    const { svc, offers } = makeService();
    await expect(
      svc.onRideOfferResponse({ driverId: DRIVER, offerId: OFFER, accept: true }),
    ).resolves.toEqual({ ok: true, trip: { kind: 'solo', rideId: RIDE }, generation: 1, replay: false });
    await expect(
      svc.onRideOfferResponse({ driverId: DRIVER, offerId: OFFER, accept: false }),
    ).resolves.toBe('declined');
    expect(offers.decline).toHaveBeenCalledWith(expect.anything(), OFFER, DRIVER);
  });
});

describe('DispatchService.acceptOffer', () => {
  it('solo winner: guard → claim → accept → revoke, in that order, then after-commit effects', async () => {
    const m = makeService();
    m.offers.revokeLiveForTrip.mockResolvedValue([{ offerId: 'o-2', driverId: OTHER }]);
    const res = await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });

    expect(res).toEqual({ ok: true, trip: { kind: 'solo', rideId: RIDE }, generation: 1, replay: false });
    const order = [
      m.assignments.lockSoloTrip,
      m.offers.lockForUpdate,
      m.assignments.driverEligibility,
      m.assignments.acquire,
      m.assignments.claimSoloRow,
      m.offers.markAccepted,
      m.offers.revokeLiveForTrip,
    ].map((f) => f.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(m.assignments.acquire).toHaveBeenCalledWith(m.tx, {
      driverId: DRIVER,
      trip: { kind: 'solo', rideId: RIDE },
      offerId: OFFER,
      generation: 1,
    });
    expect(m.offers.revokeLiveForTrip).toHaveBeenCalledWith(m.tx, { kind: 'solo', rideId: RIDE }, OFFER);
    expect(m.projection.set).toHaveBeenCalledWith(DRIVER, RIDE);
    expect(m.queue.remove).toHaveBeenCalledWith(waveTwoJobId(RIDE, 1));
    expect(m.queue.remove).toHaveBeenCalledWith(hardFailJobId(RIDE, 1));
    expect(m.queue.remove).toHaveBeenCalledWith(legacyWaveTwoJobId(RIDE));
    expect(m.queue.remove).toHaveBeenCalledWith(legacyHardFailJobId(RIDE));
    expect(m.bus.toDriver).toHaveBeenCalledWith(DRIVER, 'ride_offer_accepted', {
      offerId: OFFER,
      rideId: RIDE,
    });
    expect(m.bus.toDriver).toHaveBeenCalledWith(OTHER, 'ride_offer_revoked', {
      offerId: 'o-2',
      rideId: RIDE,
      sharedRideId: RIDE,
      reason: 'taken',
    });
    expect(m.bus.toRide).toHaveBeenCalledWith(RIDE, 'ride_state_changed', {
      rideId: RIDE,
      state: 'accepted',
      by: 'driver',
      version: 3,
    });
  });

  it('shared winner: needs a complete itinerary and seats ≥ seat_count', async () => {
    const m = makeService();
    const trip = { kind: 'shared', sharedRideId: POOL } as const;
    m.offers.findForDriver.mockResolvedValue(offerRow({ trip }));
    m.offers.lockForUpdate.mockResolvedValue(offerRow({ trip }));
    const res = await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });

    expect(res).toEqual({ ok: true, trip, generation: 1, replay: false });
    expect(m.assignments.lockSharedTrip).toHaveBeenCalledWith(m.tx, POOL);
    expect(m.stops.countAll).toHaveBeenCalledWith(POOL, m.tx);
    expect(m.assignments.driverEligibility).toHaveBeenCalledWith(m.tx, DRIVER, 2);
    expect(m.assignments.claimSharedRow).toHaveBeenCalledWith(m.tx, POOL, DRIVER, 1);
    expect(m.bus.toDriver).toHaveBeenCalledWith(DRIVER, 'ride_offer_accepted', {
      offerId: OFFER,
      rideId: POOL,
      sharedRideId: POOL,
    });
    expect(m.bus.toRide).not.toHaveBeenCalled();
    // pool:<id> hash re-projected from the committed claim (F09).
    expect(m.poolProjection.project).toHaveBeenCalledWith(POOL);
  });

  it.each([
    ['malformed offer id', { offerId: 'x' }, 'offer_not_found'],
    ['malformed driver id', { driverId: 'd' }, 'offer_not_found'],
  ])('%s → %s without touching the DB', async (_n, input, reason) => {
    const m = makeService();
    const res = await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER, ...input });
    expect(res).toEqual({ ok: false, reason });
    expect(m.offers.findForDriver).not.toHaveBeenCalled();
  });

  it('unknown / foreign offer → offer_not_found; the refusal is also pushed as a revoke', async () => {
    const m = makeService();
    m.offers.findForDriver.mockResolvedValue(null);
    expect(await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).toEqual({
      ok: false,
      reason: 'offer_not_found',
    });
    expect(m.db.transaction).not.toHaveBeenCalled();
    expect(m.bus.toDriver).toHaveBeenCalledWith(DRIVER, 'ride_offer_revoked', {
      offerId: OFFER,
      reason: 'unavailable',
      detail: 'offer_not_found',
    });
  });

  type M = ReturnType<typeof makeService>;
  const cases: Array<[string, (m: M) => void, string]> = [
    ['trip row gone', (m) => m.assignments.lockSoloTrip.mockResolvedValue(null), 'trip_not_claimable'],
    [
      'offer re-read under lock belongs to someone else',
      (m) => m.offers.lockForUpdate.mockResolvedValue(offerRow({ driverId: OTHER })),
      'offer_not_found',
    ],
    [
      'accepted earlier but the assignment was released',
      (m) => m.offers.lockForUpdate.mockResolvedValue(offerRow({ state: 'accepted' })),
      'trip_not_claimable',
    ],
    [
      'revoked because another driver won',
      (m) => {
        m.offers.lockForUpdate.mockResolvedValue(offerRow({ state: 'revoked' }));
        m.assignments.lockSoloTrip.mockResolvedValue(
          soloRide({ id: RIDE, status: 'accepted', driverId: OTHER }),
        );
      },
      'trip_taken',
    ],
    [
      'revoked by cancellation',
      (m) => m.offers.lockForUpdate.mockResolvedValue(offerRow({ state: 'revoked' })),
      'offer_revoked',
    ],
    [
      'declined',
      (m) => m.offers.lockForUpdate.mockResolvedValue(offerRow({ state: 'declined' })),
      'offer_declined',
    ],
    [
      'lapsed on the DB clock',
      (m) => m.offers.lockForUpdate.mockResolvedValue(offerRow({ lapsed: true })),
      'offer_expired',
    ],
    [
      'older generation',
      (m) => m.assignments.lockSoloTrip.mockResolvedValue(soloRide({ id: RIDE, dispatchGeneration: 2 })),
      'offer_stale',
    ],
    [
      'solo already bound',
      (m) => m.assignments.lockSoloTrip.mockResolvedValue(soloRide({ id: RIDE, driverId: OTHER })),
      'trip_taken',
    ],
    [
      'solo no longer requested',
      (m) => m.assignments.lockSoloTrip.mockResolvedValue(soloRide({ id: RIDE, status: 'cancelled' })),
      'trip_not_claimable',
    ],
    ['ineligible account', (m) => m.assignments.driverEligibility.mockResolvedValue('driver_ineligible'), 'driver_ineligible'],
    ['undersized vehicle', (m) => m.assignments.driverEligibility.mockResolvedValue('vehicle_capacity'), 'vehicle_capacity'],
    [
      'guard: driver already busy',
      (m) => m.assignments.acquire.mockResolvedValue({ ok: false, reason: 'driver_busy' }),
      'driver_busy',
    ],
    [
      'guard: trip already assigned',
      (m) => m.assignments.acquire.mockResolvedValue({ ok: false, reason: 'trip_taken' }),
      'trip_taken',
    ],
  ];
  it.each(cases)('%s → %s, nothing claimed', async (_name, arrange, reason) => {
    const m = makeService();
    arrange(m);
    expect(await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).toEqual({ ok: false, reason });
    expect(m.assignments.claimSoloRow).not.toHaveBeenCalled();
    expect(m.offers.markAccepted).not.toHaveBeenCalled();
    expect(m.projection.set).not.toHaveBeenCalled();
    expect(m.bus.toDriver).toHaveBeenCalledWith(
      DRIVER,
      'ride_offer_revoked',
      expect.objectContaining({ offerId: OFFER, rideId: RIDE, detail: reason }),
    );
  });

  it('expiry and staleness resolve the offer inside the transaction', async () => {
    const lapsed = makeService();
    lapsed.offers.lockForUpdate.mockResolvedValue(offerRow({ lapsed: true }));
    await lapsed.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });
    expect(lapsed.offers.resolveLive).toHaveBeenCalledWith(lapsed.tx, OFFER, 'expired');

    const stale = makeService();
    stale.assignments.lockSoloTrip.mockResolvedValue(soloRide({ id: RIDE, dispatchGeneration: 2 }));
    await stale.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });
    expect(stale.offers.resolveLive).toHaveBeenCalledWith(stale.tx, OFFER, 'revoked');
  });

  it('shared trip-state checks: claimed, wrong state, incomplete itinerary', async () => {
    const trip = { kind: 'shared', sharedRideId: POOL } as const;
    const arrange = (lock: Partial<SharedTripLockRow>, stopCount = 4) => {
      const m = makeService();
      m.offers.findForDriver.mockResolvedValue(offerRow({ trip }));
      m.offers.lockForUpdate.mockResolvedValue(offerRow({ trip }));
      m.assignments.lockSharedTrip.mockResolvedValue(poolLock(lock));
      m.stops.countAll.mockResolvedValue(stopCount);
      return m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });
    };
    expect(await arrange({ claimedByDriverId: OTHER })).toEqual({ ok: false, reason: 'trip_taken' });
    expect(await arrange({ poolState: 'aborted' })).toEqual({ ok: false, reason: 'trip_not_claimable' });
    expect(await arrange({}, 0)).toEqual({ ok: false, reason: 'itinerary_missing' });
    expect(await arrange({ seatCount: 0 }, 0)).toEqual({ ok: false, reason: 'itinerary_missing' });
  });

  it('replays a committed acceptance (before expiry rules) and re-acks without side effects', async () => {
    const m = makeService();
    m.offers.lockForUpdate.mockResolvedValue(offerRow({ state: 'accepted', lapsed: true }));
    m.assignments.findByTrip.mockResolvedValue({
      driverId: DRIVER,
      trip: { kind: 'solo', rideId: RIDE },
      offerId: OFFER,
      generation: 1,
      assignedAt: new Date(),
    });
    expect(await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).toEqual({
      ok: true,
      trip: { kind: 'solo', rideId: RIDE },
      generation: 1,
      replay: true,
    });
    expect(m.assignments.acquire).not.toHaveBeenCalled();
    expect(m.queue.remove).not.toHaveBeenCalled();
    expect(m.bus.toRide).not.toHaveBeenCalled();
    expect(m.projection.set).toHaveBeenCalledWith(DRIVER, RIDE);
    expect(m.bus.toDriver).toHaveBeenCalledWith(DRIVER, 'ride_offer_accepted', expect.anything());
  });

  it('retries a deadlock victim twice, then answers conflict', async () => {
    const m = makeService();
    m.db.transaction.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    expect(await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).toEqual({
      ok: false,
      reason: 'conflict',
    });
    expect(m.db.transaction).toHaveBeenCalledTimes(3);
    // The offer is still live: no revoke is pushed for a lost lock race.
    expect(m.bus.toDriver).not.toHaveBeenCalled();
  });

  it('a serialization failure that clears on retry still wins', async () => {
    const m = makeService();
    const real = m.db.transaction.getMockImplementation()!;
    m.db.transaction
      .mockRejectedValueOnce({ cause: { code: '40001' } })
      .mockImplementation(real);
    expect(await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).toMatchObject({ ok: true });
  });

  it('a non-retryable error propagates (no false success)', async () => {
    const m = makeService();
    m.assignments.claimSoloRow.mockRejectedValue(new Error('boom'));
    await expect(m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).rejects.toThrow('boom');
    expect(m.projection.set).not.toHaveBeenCalled();
  });

  it('a failing socket delivery after commit never fails the winner', async () => {
    const m = makeService();
    m.bus.toDriver.mockImplementation(() => {
      throw new Error('socket down');
    });
    m.queue.remove.mockRejectedValue(new Error('redis down'));
    expect(await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).toMatchObject({ ok: true });
  });
});

describe('DispatchService.runSoloWave', () => {
  it('offers eligible, not-yet-offered drivers; wave 1 arms generation timers', async () => {
    const m = makeService();
    m.redis.georadius.mockResolvedValue([DRIVER, OTHER, 'gone']);
    m.offers.offeredDriverIds.mockResolvedValue(['gone']);
    m.offers.createOffer.mockImplementation(async (_db: unknown, p: { driverId: string }) =>
      p.driverId === OTHER ? null : { offerId: OFFER, expiresAt: new Date('2026-11-06T00:00:12.000Z') },
    );

    await m.svc.runSoloWave(soloRide({ id: RIDE }), 1, 1);

    expect(m.redis.georadius).toHaveBeenCalledWith('active_drivers', 91.7362, 26.1445, 2000, 'm', 'ASC', 'COUNT', 21);
    expect(m.offers.eligibleCandidates).toHaveBeenCalledWith(expect.anything(), [DRIVER, OTHER], 1);
    expect(m.bus.toDriver).toHaveBeenCalledTimes(1);
    expect(m.bus.toDriver).toHaveBeenCalledWith(DRIVER, 'ride_offer', {
      offerId: OFFER,
      rideId: RIDE,
      ttlMs: 12_000,
      expiresAt: '2026-11-06T00:00:12.000Z',
      pickup: { lat: 26.1445, lng: 91.7362 },
      dropoff: { lat: 26.1758, lng: 91.7898 },
      fareCents: 18500,
      waveNumber: 1,
    });
    expect(m.queue.add).toHaveBeenCalledWith(
      WAVE_TIMEOUT_JOB,
      { rideId: RIDE, waveNumber: 2, kind: 'solo', generation: 1 },
      expect.objectContaining({ jobId: waveTwoJobId(RIDE, 1), delay: 30_000 }),
    );
    expect(m.queue.add).toHaveBeenCalledWith(
      HARD_FAIL_JOB,
      { rideId: RIDE, kind: 'solo', generation: 1 },
      expect.objectContaining({ jobId: hardFailJobId(RIDE, 1), delay: 60_000 }),
    );
  });

  it('wave 2 uses K2/R2 and arms no timers; the configured windows are honoured', async () => {
    const m = makeService({ DISPATCH_K2: 3, DISPATCH_R2_METERS: 9000 });
    await m.svc.runSoloWave(soloRide({ id: RIDE }), 2, 1);
    expect(m.redis.georadius).toHaveBeenCalledWith('active_drivers', 91.7362, 26.1445, 9000, 'm', 'ASC', 'COUNT', 12);
    expect(m.queue.add).not.toHaveBeenCalled();
  });

  it('refuses generation 0 (an un-woken / un-dispatched ride) and propagates infra errors', async () => {
    const m = makeService();
    await expect(m.svc.runSoloWave(soloRide({ id: RIDE, dispatchGeneration: 0 }), 1)).rejects.toThrow(
      /no dispatch generation/,
    );
    m.redis.georadius.mockRejectedValue(new Error('redis down'));
    await expect(m.svc.runSoloWave(soloRide({ id: RIDE }), 1, 1)).rejects.toThrow('redis down');
    m.redis.georadius.mockResolvedValue([]);
    m.queue.add.mockRejectedValue(new Error('queue down'));
    await expect(m.svc.runSoloWave(soloRide({ id: RIDE }), 1, 1)).rejects.toThrow('queue down');
  });
});

describe('DispatchService.runPoolWave', () => {
  it('offers the persisted itinerary with passengerCount = seat_count', async () => {
    const m = makeService();
    m.redis.georadius.mockResolvedValue([DRIVER]);
    await m.svc.runPoolWave(pool({ rideId: POOL }), 1, 1);
    expect(m.offers.eligibleCandidates).toHaveBeenCalledWith(expect.anything(), [DRIVER], 2);
    expect(m.bus.toDriver).toHaveBeenCalledWith(
      DRIVER,
      'ride_offer',
      expect.objectContaining({ sharedRideId: POOL, passengerCount: 2, waveNumber: 1 }),
    );
    const payload = m.bus.toDriver.mock.calls[0][2] as { stops: unknown[] };
    expect(payload.stops).toHaveLength(4);
    expect(m.queue.add).toHaveBeenCalledWith(
      WAVE_TIMEOUT_JOB,
      { rideId: POOL, waveNumber: 2, kind: 'pool', generation: 1 },
      expect.objectContaining({ jobId: waveTwoJobId(POOL, 1) }),
    );
  });

  it('an incomplete itinerary gets no offers but still arms the hard-fail', async () => {
    const m = makeService();
    m.stops.findByRideId.mockResolvedValue(stopRows(2));
    m.redis.georadius.mockResolvedValue([DRIVER]);
    await m.svc.runPoolWave(pool({ rideId: POOL }), 1, 1);
    expect(m.offers.createOffer).not.toHaveBeenCalled();
    expect(m.queue.add).toHaveBeenCalledWith(HARD_FAIL_JOB, expect.anything(), expect.anything());
  });

  it('refuses generation 0 (open pool)', async () => {
    const m = makeService();
    await expect(m.svc.runPoolWave(pool({ dispatchGeneration: 0 }), 1)).rejects.toThrow(
      /no dispatch generation/,
    );
  });
});

describe('DispatchService.handleWaveTimeout', () => {
  const job = (data: WaveTimeoutJob) => ({ data }) as Job<WaveTimeoutJob>;

  it('solo, still requested on the job generation → wave 2', async () => {
    const m = makeService();
    const spy = vi.spyOn(m.svc, 'runSoloWave').mockResolvedValue(undefined);
    await m.svc.handleWaveTimeout(job({ rideId: RIDE, waveNumber: 2, kind: 'solo', generation: 1 }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: RIDE }), 2, 1);
  });

  it.each([
    ['ride gone', null, 1],
    ['ride accepted', soloRide({ id: RIDE, status: 'accepted', driverId: OTHER }), 1],
    ['older generation', soloRide({ id: RIDE, dispatchGeneration: 2 }), 1],
  ])('solo stale (%s) → no-op', async (_n, ride, generation) => {
    const m = makeService();
    m.ridesRepo.findById.mockResolvedValue(ride);
    const spy = vi.spyOn(m.svc, 'runSoloWave');
    await m.svc.handleWaveTimeout(job({ rideId: RIDE, waveNumber: 2, kind: 'solo', generation }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('legacy pool job (no kind, no generation) → current generation', async () => {
    const m = makeService();
    const spy = vi.spyOn(m.svc, 'runPoolWave').mockResolvedValue(undefined);
    await m.svc.handleWaveTimeout(job({ rideId: POOL, waveNumber: 2 }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ rideId: 'pool-1' }), 2, 1);
  });

  it.each([
    ['claimed', pool({ claimedByDriverId: OTHER })],
    ['aborted', pool({ poolState: 'aborted' })],
    ['re-dispatched', pool({ dispatchGeneration: 2 })],
  ])('pool stale (%s) → no-op', async (_n, p) => {
    const m = makeService();
    m.repo.findById.mockResolvedValue(p);
    const spy = vi.spyOn(m.svc, 'runPoolWave');
    await m.svc.handleWaveTimeout(job({ rideId: POOL, waveNumber: 2, kind: 'pool', generation: 1 }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('DispatchService.handleHardFail', () => {
  const job = (data: HardFailJob) => ({ data }) as Job<HardFailJob>;

  it('solo: no_driver committed → revoked drivers + passenger told, timers dropped', async () => {
    const m = makeService();
    m.ridesRepo.markNoDriver.mockResolvedValue({
      row: soloRide({ id: RIDE, status: 'no_driver' }),
      revokedOffers: [{ offerId: OFFER, driverId: DRIVER }],
    });
    await m.svc.handleHardFail(job({ rideId: RIDE, kind: 'solo', generation: 1 }));
    expect(m.ridesRepo.markNoDriver).toHaveBeenCalledWith(RIDE, 1);
    expect(m.bus.toDriver).toHaveBeenCalledWith(DRIVER, 'ride_offer_revoked', {
      offerId: OFFER,
      rideId: RIDE,
      sharedRideId: RIDE,
      reason: 'revoked',
    });
    expect(m.bus.toUser).toHaveBeenCalledWith('c-1', 'ride_no_driver', { rideId: RIDE });
    expect(m.queue.remove).toHaveBeenCalledWith(waveTwoJobId(RIDE, 1));
  });

  it('solo: claimed / stale in the same instant → no-op', async () => {
    const m = makeService();
    await m.svc.handleHardFail(job({ rideId: RIDE, kind: 'solo', generation: 1 }));
    expect(m.bus.toUser).not.toHaveBeenCalled();
  });

  it('pool: aborts the unclaimed pool on its generation and revokes offers', async () => {
    const m = makeService();
    m.offers.revokeLiveForTrip.mockResolvedValue([{ offerId: OFFER, driverId: DRIVER }]);
    await m.svc.handleHardFail(job({ rideId: POOL, kind: 'pool' }));
    expect(m.assignments.abortUnclaimedPool).toHaveBeenCalledWith(m.tx, POOL, 1);
    expect(m.bus.toDriver).toHaveBeenCalledWith(DRIVER, 'ride_offer_revoked', {
      offerId: OFFER,
      sharedRideId: POOL,
      reason: 'revoked',
    });
    expect(m.queue.remove).toHaveBeenCalledWith(hardFailJobId(POOL, 1));
    expect(m.poolProjection.project).toHaveBeenCalledWith(POOL);
  });

  it('pool: a failing projection refresh never fails the committed abort', async () => {
    const m = makeService();
    m.poolProjection.project.mockRejectedValue(new Error('redis down'));
    await expect(m.svc.handleHardFail(job({ rideId: POOL, kind: 'pool' }))).resolves.toBeUndefined();
    expect(m.assignments.abortUnclaimedPool).toHaveBeenCalled();
  });

  it.each([
    ['pool gone', null, undefined],
    ['older generation job', poolLock({ dispatchGeneration: 2 }), 1],
  ])('pool: %s → no abort', async (_n, lock, generation) => {
    const m = makeService();
    m.assignments.lockSharedTrip.mockResolvedValue(lock);
    await m.svc.handleHardFail(job({ rideId: POOL, kind: 'pool', generation }));
    expect(m.assignments.abortUnclaimedPool).not.toHaveBeenCalled();
  });

  it('pool: already claimed (abort matched nothing) → no revoke', async () => {
    const m = makeService();
    m.assignments.abortUnclaimedPool.mockResolvedValue(false);
    await m.svc.handleHardFail(job({ rideId: POOL, kind: 'pool', generation: 1 }));
    expect(m.offers.revokeLiveForTrip).not.toHaveBeenCalled();
    expect(m.queue.remove).not.toHaveBeenCalled();
    expect(m.poolProjection.project).not.toHaveBeenCalled();
  });
});

describe('DispatchService.onRideCancelled / releaseDispatch', () => {
  it('drops current + legacy timers for the cancelled generation', async () => {
    const m = makeService();
    await m.svc.onRideCancelled({ rideId: RIDE, driverId: null, generation: 3 });
    expect(m.queue.remove.mock.calls.map((c) => c[0])).toEqual([
      legacyWaveTwoJobId(RIDE),
      legacyHardFailJobId(RIDE),
      waveTwoJobId(RIDE, 3),
      hardFailJobId(RIDE, 3),
    ]);
  });

  it('looks the generation up when not given; tolerates a missing ride and queue errors', async () => {
    const m = makeService();
    await m.svc.releaseDispatch(RIDE);
    expect(m.queue.remove).toHaveBeenCalledWith(hardFailJobId(RIDE, 1));

    const gone = makeService();
    gone.ridesRepo.findById.mockRejectedValue(new Error('db down'));
    gone.queue.remove.mockRejectedValue(new Error('redis down'));
    await expect(gone.svc.releaseDispatch(RIDE)).resolves.toBeUndefined();
    expect(gone.queue.remove).toHaveBeenCalledTimes(2);
  });
});

// ── R09 / F10: explicit offer outcomes + versioned post-commit broadcasts ───
describe('DispatchService — explicit offer outcomes (ride_offer_outcome)', () => {
  const sharedTrip = { kind: 'shared', sharedRideId: POOL } as const;
  const sharedAssignment = {
    tripKind: 'shared' as const,
    tripId: POOL,
    sharedRideId: POOL,
    offerId: OFFER,
    generation: 1,
    assignedAt: '2026-11-06T00:00:00.000Z',
    version: 4,
    poolStatus: 'closed_full',
    seatCount: 2,
    stops: [],
  };

  function outcomes(m: ReturnType<typeof makeService>, driverId: string) {
    return m.bus.toDriver.mock.calls
      .filter(([d, e]) => d === driverId && e === 'ride_offer_outcome')
      .map(([, , p]) => p as Record<string, unknown>);
  }

  it('shared winner gets `assigned` with the committed itinerary; losers get `lost`; never the winner', async () => {
    const m = makeService();
    m.offers.findForDriver.mockResolvedValue(offerRow({ trip: sharedTrip }));
    m.offers.lockForUpdate.mockResolvedValue(offerRow({ trip: sharedTrip }));
    m.offers.revokeLiveForTrip.mockResolvedValue([{ offerId: 'o-2', driverId: OTHER }]);
    m.snapshots.driverAssignment.mockResolvedValue({
      driverId: DRIVER,
      assignment: sharedAssignment,
    });

    await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });

    // The winner's offer is excluded from the revoke (A's contract) …
    expect(m.offers.revokeLiveForTrip).toHaveBeenCalledWith(m.tx, sharedTrip, OFFER);
    // … and gets a positive, explicit acknowledgement with the assignment.
    expect(outcomes(m, DRIVER)).toEqual([
      {
        offerId: OFFER,
        outcome: 'assigned',
        tripKind: 'shared',
        tripId: POOL,
        generation: 1,
        assignment: sharedAssignment,
      },
    ]);
    expect(outcomes(m, OTHER)).toEqual([
      { offerId: 'o-2', outcome: 'lost', tripKind: 'shared', tripId: POOL, reason: 'taken' },
    ]);
    expect(m.bus.toDriver).not.toHaveBeenCalledWith(
      DRIVER,
      'ride_offer_revoked',
      expect.anything(),
    );
    // Members learn the claim from the committed row.
    expect(m.snapshots.publishPoolUpdate).toHaveBeenCalledWith(POOL);
  });

  it('a replayed accept (lost ack) re-sends `assigned` but no revokes / broadcasts', async () => {
    const m = makeService();
    m.offers.lockForUpdate.mockResolvedValue(offerRow({ state: 'accepted' }));
    m.assignments.findByTrip.mockResolvedValue({ driverId: DRIVER, generation: 1 });

    await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });

    expect(outcomes(m, DRIVER)).toEqual([
      expect.objectContaining({ offerId: OFFER, outcome: 'assigned', tripId: RIDE }),
    ]);
    expect(m.bus.toRide).not.toHaveBeenCalled();
    expect(m.snapshots.publishPoolUpdate).not.toHaveBeenCalled();
  });

  it('an assignment snapshot for another trip is never attached to the outcome', async () => {
    const m = makeService();
    m.snapshots.driverAssignment.mockResolvedValue({
      driverId: DRIVER,
      assignment: { ...sharedAssignment, tripId: 'other-trip' },
    });
    await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });
    expect(outcomes(m, DRIVER)[0]).toMatchObject({ outcome: 'assigned', assignment: null });
  });

  it('a failing snapshot read never fails the committed winner', async () => {
    const m = makeService();
    m.snapshots.driverAssignment.mockRejectedValue(new Error('pg blip'));
    const res = await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });
    expect(res).toMatchObject({ ok: true });
    expect(outcomes(m, DRIVER)[0]).toMatchObject({ outcome: 'assigned', assignment: null });
  });

  it.each([
    ['trip_taken', 'lost'],
    ['offer_expired', 'expired'],
    ['offer_stale', 'expired'],
    ['trip_not_claimable', 'revoked'],
    ['driver_busy', 'rejected'],
  ])('a refused accept (%s) is answered with outcome %s', async (reason, outcome) => {
    const m = makeService();
    if (reason === 'trip_taken') {
      m.assignments.lockSoloTrip.mockResolvedValue(soloRide({ id: RIDE, driverId: OTHER }));
    } else if (reason === 'offer_expired') {
      m.offers.lockForUpdate.mockResolvedValue(offerRow({ lapsed: true }));
    } else if (reason === 'offer_stale') {
      m.offers.lockForUpdate.mockResolvedValue(offerRow({ generation: 0 }));
    } else if (reason === 'trip_not_claimable') {
      m.assignments.lockSoloTrip.mockResolvedValue(null);
    } else {
      m.assignments.acquire.mockResolvedValue({ ok: false, reason: 'driver_busy' });
    }
    expect(await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER })).toEqual({
      ok: false,
      reason,
    });
    expect(outcomes(m, DRIVER)).toEqual([
      { offerId: OFFER, outcome, tripKind: 'solo', tripId: RIDE, reason },
    ]);
  });

  it('an unknown offer gets `rejected` without echoing any trip id', async () => {
    const m = makeService();
    m.offers.findForDriver.mockResolvedValue(null);
    await m.svc.acceptOffer({ offerId: OFFER, driverId: DRIVER });
    expect(outcomes(m, DRIVER)).toEqual([
      { offerId: OFFER, outcome: 'rejected', reason: 'offer_not_found' },
    ]);
  });

  it('hard-fail: revoked drivers get `revoked`; the pool room gets the versioned abort', async () => {
    const m = makeService();
    m.offers.revokeLiveForTrip.mockResolvedValue([{ offerId: OFFER, driverId: DRIVER }]);
    await m.svc.handleHardFail({ data: { rideId: POOL, kind: 'pool' } } as Job<HardFailJob>);
    expect(outcomes(m, DRIVER)).toEqual([
      { offerId: OFFER, outcome: 'revoked', tripKind: 'shared', tripId: POOL, reason: 'revoked' },
    ]);
    expect(m.snapshots.publishPoolUpdate).toHaveBeenCalledWith(POOL);
  });

  it('solo hard-fail tells the ride room `no_driver` with its terminal version', async () => {
    const m = makeService();
    m.ridesRepo.markNoDriver.mockResolvedValue({
      row: soloRide({ id: RIDE, status: 'no_driver' }),
      revokedOffers: [],
    });
    await m.svc.handleHardFail({
      data: { rideId: RIDE, kind: 'solo', generation: 1 },
    } as Job<HardFailJob>);
    expect(m.bus.toRide).toHaveBeenCalledWith(RIDE, 'ride_state_changed', {
      rideId: RIDE,
      state: 'no_driver',
      by: 'system',
      version: 10,
    });
  });
});
