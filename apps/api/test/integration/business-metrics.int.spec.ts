import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Job, Queue } from 'bullmq';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { register } from 'prom-client';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { uniquePhone, uniqueRegNo } from '@rcab/test-fixtures';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';
import { RealtimeBus } from '../../src/modules/realtime/realtime.bus';
import { QuoteTokenService } from '../../src/modules/rides/quote-token.service';
import { OutboxRelay } from '../../src/modules/outbox/outbox.relay';
import { DispatchProcessor } from '../../src/modules/dispatch/dispatch.processor';
import { DispatchService } from '../../src/modules/dispatch/dispatch.service';
import { PoolLifecycleService } from '../../src/modules/matching/pool-lifecycle.service';
import { RideStateMachine } from '../../src/modules/rides/ride-state-machine.service';
import { BusinessMetricsSampler } from '../../src/modules/metrics/business-metrics.sampler';
import { dispatchStartJobId } from '../../src/modules/outbox/outbox.jobs';
import { fixedFare } from './pool-harness';

const skip = process.env.RCAB_INT_SKIPPED === '1';

type Labels = Record<string, string>;

/**
 * Read one series total from the live registry. For a histogram pass
 * `{ suffix: '_count' }` (or `_sum`); label values are matched as a subset.
 */
async function metric(name: string, labels: Labels = {}, suffix = ''): Promise<number> {
  const json = await register.getMetricsAsJSON();
  const m = json.find((x) => x.name === name);
  if (!m) return 0;
  const want = suffix === '' ? name : `${name}${suffix}`;
  return (m.values as Array<{ value: number; labels: Labels; metricName?: string }>)
    .filter((v) => (v.metricName ?? name) === want)
    .filter((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))
    .reduce((sum, v) => sum + v.value, 0);
}

/** Every label set currently recorded for a metric (to assert nothing id-shaped leaked). */
async function labelValues(name: string, label: string): Promise<string[]> {
  const json = await register.getMetricsAsJSON();
  const m = json.find((x) => x.name === name);
  const seen = new Set<string>();
  for (const v of (m?.values ?? []) as Array<{ labels: Labels }>) {
    if (v.labels[label] !== undefined) seen.add(v.labels[label]);
  }
  return [...seen];
}

// Known business activity driven through the real Nest wiring; the registry
// must move by exactly the amounts the activity implies (RCAB-E8.S12 / R12).
describe.skipIf(skip)('business metrics move with known activity (full Nest wiring)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let relay: OutboxRelay;
  let dispatchQ: Queue;
  const bus = {
    setServer: vi.fn(),
    toDriver: vi.fn(),
    toUser: vi.fn(),
    toRide: vi.fn(),
    toPool: vi.fn(),
    joinRide: vi.fn().mockResolvedValue(undefined),
    joinPool: vi.fn().mockResolvedValue(undefined),
    broadcast: vi.fn(),
  };
  const clientIds: string[] = [];
  const driverIds: string[] = [];
  const poolIds: string[] = [];
  // A location no other spec uses, so only our drivers are candidates.
  const ORIGIN = { lat: 12.9716, lng: 77.5946 };
  const DEST = { lat: 13.0358, lng: 77.597 };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    redis = new Redis(process.env.TEST_REDIS_URL!);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(REDIS).useValue(redis)
      .overrideProvider(FirebaseAdminService).useValue({ verifyIdToken: vi.fn() })
      .overrideProvider(GoogleVerifierService).useValue({ verifyIdToken: vi.fn() })
      .overrideProvider(RealtimeBus).useValue(bus)
      .overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    relay = moduleRef.get(OutboxRelay, { strict: false });
    dispatchQ = moduleRef.get(getQueueToken('dispatch'), { strict: false });
  }, 30_000);

  afterAll(async () => {
    await pool
      .query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM rides WHERE passenger_id = ANY($1))', [clientIds])
      .catch(() => undefined);
    await pool.query('DELETE FROM driver_active_assignment WHERE driver_id = ANY($1)', [driverIds]).catch(() => undefined);
    await pool.query('DELETE FROM dispatch_offer WHERE driver_id = ANY($1)', [driverIds]).catch(() => undefined);
    await pool.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [poolIds]).catch(() => undefined);
    await pool.query('DELETE FROM ride_stops WHERE ride_id = ANY($1)', [poolIds]).catch(() => undefined);
    await pool.query('DELETE FROM pool_member WHERE pool_id = ANY($1)', [poolIds]).catch(() => undefined);
    await pool.query('DELETE FROM shared_rides WHERE ride_id = ANY($1)', [poolIds]).catch(() => undefined);
    await pool.query('DELETE FROM rides WHERE passenger_id = ANY($1)', [clientIds]).catch(() => undefined);
    await pool.query('DELETE FROM app_user WHERE id = ANY($1)', [[...clientIds, ...driverIds]]).catch(() => undefined);
    await redis.zrem('active_drivers', ...driverIds).catch(() => undefined);
    await app?.close();
    await pool?.end();
    vi.unstubAllGlobals();
  });

  async function seedClient(): Promise<{ id: string; jwt: string }> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1,$2,$3,'client')`,
      [id, `fb-metrics-${id}`, uniquePhone()],
    );
    clientIds.push(id);
    const jwt = moduleRef
      .get(JwtService)
      .sign({ sub: id, role: 'client', auth_method: 'phone', typ: 'access' });
    return { id, jwt };
  }

  async function seedNearbyDriver(): Promise<string> {
    const id = randomUUID();
    const vehicleId = randomUUID();
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1,$2,$3,'driver')`,
      [id, `fb-metrics-${id}`, uniquePhone()],
    );
    await pool.query(`INSERT INTO driver (user_id) VALUES ($1)`, [id]);
    await pool.query(
      `INSERT INTO vehicle (id, driver_id, type, reg_no, seats, active) VALUES ($1,$2,'cab_sedan',$3,4,true)`,
      [vehicleId, id, uniqueRegNo()],
    );
    await pool.query(`UPDATE driver SET current_vehicle_id = $2 WHERE user_id = $1`, [id, vehicleId]);
    if (driverIds.length) await redis.zrem('active_drivers', ...driverIds);
    driverIds.push(id);
    await redis.geoadd('active_drivers', ORIGIN.lng, ORIGIN.lat, id);
    return id;
  }

  const quote = (): string =>
    moduleRef.get(QuoteTokenService).sign({
      originLat: ORIGIN.lat,
      originLng: ORIGIN.lng,
      destLat: DEST.lat,
      destLng: DEST.lng,
      soloFareCents: 18500,
      distanceM: 9000,
      durationS: 1200,
    });

  const createRide = (jwt: string) =>
    supertest(app.getHttpServer())
      .post('/v1/rides')
      .set('Authorization', `Bearer ${jwt}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        type: 'normal',
        originLat: ORIGIN.lat,
        originLng: ORIGIN.lng,
        destLat: DEST.lat,
        destLng: DEST.lng,
        quoteToken: quote(),
      });

  it('HTTP: a ride id collapses to the route template; unknown paths share one fixed label', async () => {
    const { jwt } = await seedClient();
    const a = randomUUID();
    const b = randomUUID();

    const before = await metric(
      'http_request_duration_seconds',
      { method: 'GET', route: '/v1/rides/:id' },
      '_count',
    );
    // Two different ids -> ONE series. (Whatever the status, the route matched.)
    await supertest(app.getHttpServer()).get(`/v1/rides/${a}`).set('Authorization', `Bearer ${jwt}`);
    await supertest(app.getHttpServer()).get(`/v1/rides/${b}`).set('Authorization', `Bearer ${jwt}`);
    expect(
      await metric('http_request_duration_seconds', { method: 'GET', route: '/v1/rides/:id' }, '_count'),
    ).toBe(before + 2);

    const unmatchedBefore = await metric(
      'http_request_duration_seconds',
      { route: 'unmatched', status_code: '404' },
      '_count',
    );
    await supertest(app.getHttpServer()).get(`/v1/nope/${randomUUID()}`);
    await supertest(app.getHttpServer()).get(`/totally/${randomUUID()}/unknown`);
    expect(
      await metric('http_request_duration_seconds', { route: 'unmatched', status_code: '404' }, '_count'),
    ).toBe(unmatchedBefore + 2);

    // No id-shaped (or raw-path) value ever became a label.
    const routes = await labelValues('http_request_duration_seconds', 'route');
    expect(routes.filter((r) => r.includes(a) || r.includes(b))).toEqual([]);
    expect(routes.filter((r) => /[0-9a-f]{8}-[0-9a-f]{4}-/.test(r))).toEqual([]);
    expect(routes).toContain('/v1/rides/:id');
  });

  it('solo: create -> relay -> wave 1 -> accept moves transitions, outcome and both latency stages by exactly one', async () => {
    bus.toDriver.mockClear();
    const { jwt } = await seedClient();
    const driverId = await seedNearbyDriver();

    const created0 = await metric('rcab_ride_state_transition_total', { from: 'none', to: 'requested' });
    const accepted0 = await metric('rcab_ride_state_transition_total', { from: 'requested', to: 'accepted' });
    const assigned0 = await metric('rcab_dispatch_outcome_total', { outcome: 'assigned', kind: 'solo' });
    const first0 = await metric(
      'rcab_dispatch_latency_seconds',
      { stage: 'intent_to_first_offer', kind: 'solo' },
      '_count',
    );
    const accept0 = await metric(
      'rcab_dispatch_latency_seconds',
      { stage: 'offer_to_accept', kind: 'solo' },
      '_count',
    );
    const published0 = await metric('rcab_outbox_publish_total', { result: 'published' });

    const res = await createRide(jwt);
    expect(res.status).toBe(201);
    const rideId = res.body.rideId as string;
    expect(await metric('rcab_ride_state_transition_total', { from: 'none', to: 'requested' })).toBe(created0 + 1);

    await relay.drainOnce();
    expect(await metric('rcab_outbox_publish_total', { result: 'published' })).toBeGreaterThanOrEqual(published0 + 1);
    // Publication is not dispatch: no latency observed yet.
    expect(
      await metric('rcab_dispatch_latency_seconds', { stage: 'intent_to_first_offer', kind: 'solo' }, '_count'),
    ).toBe(first0);

    const job = (await dispatchQ.getJob(dispatchStartJobId(rideId, 1))) as Job;
    await moduleRef.get(DispatchProcessor, { strict: false }).process(job);
    expect(
      await metric('rcab_dispatch_latency_seconds', { stage: 'intent_to_first_offer', kind: 'solo' }, '_count'),
    ).toBe(first0 + 1);

    const offerCall = bus.toDriver.mock.calls.find(
      (c) => c[1] === 'ride_offer' && (c[2] as { rideId?: string }).rideId === rideId,
    );
    const offerId = (offerCall![2] as { offerId: string }).offerId;

    // Re-running wave 1 (BullMQ redelivery) offers nobody new -> still one observation.
    await moduleRef.get(DispatchProcessor, { strict: false }).process(job);
    expect(
      await metric('rcab_dispatch_latency_seconds', { stage: 'intent_to_first_offer', kind: 'solo' }, '_count'),
    ).toBe(first0 + 1);

    const dispatch = moduleRef.get(DispatchService, { strict: false });
    const ok = await dispatch.acceptOffer({ offerId, driverId });
    expect(ok).toMatchObject({ ok: true, replay: false });
    expect(await metric('rcab_ride_state_transition_total', { from: 'requested', to: 'accepted' })).toBe(accepted0 + 1);
    expect(await metric('rcab_dispatch_outcome_total', { outcome: 'assigned', kind: 'solo' })).toBe(assigned0 + 1);
    expect(
      await metric('rcab_dispatch_latency_seconds', { stage: 'offer_to_accept', kind: 'solo' }, '_count'),
    ).toBe(accept0 + 1);

    // Replaying the committed accept (lost ack) must not count the assignment twice.
    const replay = await dispatch.acceptOffer({ offerId, driverId });
    expect(replay).toMatchObject({ ok: true, replay: true });
    expect(await metric('rcab_dispatch_outcome_total', { outcome: 'assigned', kind: 'solo' })).toBe(assigned0 + 1);
    expect(
      await metric('rcab_dispatch_latency_seconds', { stage: 'offer_to_accept', kind: 'solo' }, '_count'),
    ).toBe(accept0 + 1);

    // The driver advances the ride; each committed step is one transition.
    const enRoute0 = await metric('rcab_ride_state_transition_total', { from: 'accepted', to: 'en_route' });
    const applied = await moduleRef.get(RideStateMachine, { strict: false }).apply(rideId, driverId, 'start_en_route');
    expect(applied.ok).toBe(true);
    // A rejected (out-of-order) transition changes nothing.
    const bad = await moduleRef.get(RideStateMachine, { strict: false }).apply(rideId, driverId, 'end_ride');
    expect(bad.ok).toBe(false);
    expect(await metric('rcab_ride_state_transition_total', { from: 'accepted', to: 'en_route' })).toBe(enRoute0 + 1);
  });

  it('solo: a cancel while dispatching counts the transition and the cancelled outcome once', async () => {
    const { jwt } = await seedClient();
    const res = await createRide(jwt);
    const rideId = res.body.rideId as string;
    const t0 = await metric('rcab_ride_state_transition_total', { from: 'requested', to: 'cancelled' });
    const o0 = await metric('rcab_dispatch_outcome_total', { outcome: 'cancelled', kind: 'solo' });

    const cancel = await supertest(app.getHttpServer())
      .post(`/v1/rides/${rideId}/cancel`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({});
    expect(cancel.status).toBe(200);
    expect(await metric('rcab_ride_state_transition_total', { from: 'requested', to: 'cancelled' })).toBe(t0 + 1);
    expect(await metric('rcab_dispatch_outcome_total', { outcome: 'cancelled', kind: 'solo' })).toBe(o0 + 1);

    // A second cancel is refused and counts nothing.
    const again = await supertest(app.getHttpServer())
      .post(`/v1/rides/${rideId}/cancel`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({});
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await metric('rcab_ride_state_transition_total', { from: 'requested', to: 'cancelled' })).toBe(t0 + 1);
  });

  it('pool: open + join + fill moves joins and closures; a refused join is counted by reason; the sampler sets the gauges', async () => {
    bus.toDriver.mockClear();
    const driverId = await seedNearbyDriver();
    const opener = (await seedClient()).id;
    const joiner = (await seedClient()).id;
    const lifecycle = moduleRef.get(PoolLifecycleService, { strict: false });

    const opened0 = await metric('rcab_pool_joins_total', { result: 'opened' });
    const joined0 = await metric('rcab_pool_joins_total', { result: 'joined' });
    const closedFull0 = await metric('rcab_pool_closures_total', { reason: 'closed_full' });
    const closedPool0 = await metric('rcab_pool_joins_total', { result: 'pool_closed' });
    const assignedPool0 = await metric('rcab_dispatch_outcome_total', { outcome: 'assigned', kind: 'pool' });
    const firstPool0 = await metric(
      'rcab_dispatch_latency_seconds',
      { stage: 'intent_to_first_offer', kind: 'pool' },
      '_count',
    );

    const open = await lifecycle.openPool({
      passengerId: opener,
      originLat: ORIGIN.lat,
      originLng: ORIGIN.lng,
      destLat: DEST.lat,
      destLng: DEST.lng,
      maxSeats: 2,
      detourBudgetM: 800,
      quoteFare: fixedFare(9_000),
    });
    const poolId = open.rideId;
    poolIds.push(poolId);
    expect(await metric('rcab_pool_joins_total', { result: 'opened' })).toBe(opened0 + 1);
    expect(await metric('rcab_pool_closures_total', { reason: 'closed_full' })).toBe(closedFull0);

    const joinerSeat = {
      passenger_id: joiner,
      origin_lat: ORIGIN.lat + 0.0005,
      origin_lng: ORIGIN.lng + 0.0005,
      dest_lat: DEST.lat,
      dest_lng: DEST.lng,
      joined_at: new Date().toISOString(),
    };
    const joined = await lifecycle.joinPool({ poolId, joiner: joinerSeat, quoteFare: fixedFare(9_000) });
    expect(joined).toMatchObject({ joined: true, closedFull: true });
    expect(await metric('rcab_pool_joins_total', { result: 'joined' })).toBe(joined0 + 1);
    expect(await metric('rcab_pool_closures_total', { reason: 'closed_full' })).toBe(closedFull0 + 1);

    // A third rider hits the now-closed pool: refused, typed, nothing else moves.
    const late = (await seedClient()).id;
    const refused = await lifecycle.joinPool({
      poolId,
      joiner: { ...joinerSeat, passenger_id: late },
      quoteFare: fixedFare(9_000),
    });
    expect(refused).toMatchObject({ joined: false, reason: 'pool_closed' });
    expect(await metric('rcab_pool_joins_total', { result: 'pool_closed' })).toBe(closedPool0 + 1);
    expect(await metric('rcab_pool_joins_total', { result: 'joined' })).toBe(joined0 + 1);

    // Closure -> intent -> relay -> pool wave 1 -> pool accept.
    await relay.drainOnce();
    const job = (await dispatchQ.getJob(dispatchStartJobId(poolId, 1))) as Job;
    await moduleRef.get(DispatchProcessor, { strict: false }).process(job);
    expect(
      await metric('rcab_dispatch_latency_seconds', { stage: 'intent_to_first_offer', kind: 'pool' }, '_count'),
    ).toBe(firstPool0 + 1);

    const offerCall = bus.toDriver.mock.calls.find(
      (c) => c[1] === 'ride_offer' && (c[2] as { sharedRideId?: string }).sharedRideId === poolId,
    );
    const offerId = (offerCall![2] as { offerId: string }).offerId;
    const ok = await moduleRef.get(DispatchService, { strict: false }).acceptOffer({ offerId, driverId });
    expect(ok).toMatchObject({ ok: true, replay: false });
    expect(await metric('rcab_dispatch_outcome_total', { outcome: 'assigned', kind: 'pool' })).toBe(assignedPool0 + 1);

    // Sampler: busy drivers (the accept holds an assignment), active drivers
    // (geo members), and the match rate (both riders of this pool shared).
    const report = await moduleRef.get(BusinessMetricsSampler, { strict: false }).sample();
    const busyRows = Number(
      (await pool.query('SELECT count(*) AS n FROM driver_active_assignment')).rows[0].n,
    );
    const geo = await redis.zcard('active_drivers');
    expect(report.busyDrivers).toBe(busyRows);
    expect(report.busyDrivers).toBeGreaterThanOrEqual(1);
    expect(await metric('rcab_busy_drivers')).toBe(busyRows);
    expect(report.activeDrivers).toBe(geo);
    expect(await metric('rcab_active_drivers')).toBe(geo);
    expect(report.matchRate!.riders).toBeGreaterThanOrEqual(2);
    expect(report.matchRate!.shared).toBeGreaterThanOrEqual(2);
    expect(await metric('rcab_shared_match_rate')).toBeCloseTo(report.matchRate!.rate!, 10);
    expect(report.matchRate!.rate!).toBeGreaterThan(0);
    expect(report.matchRate!.rate!).toBeLessThanOrEqual(1);
  });

  it('outbox gauges mirror the table: pending, oldest due age and exhausted', async () => {
    const { jwt } = await seedClient();
    const res = await createRide(jwt); // an undrained intent stays pending
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 20));

    // An exhausted row, planted directly.
    const deadId = randomUUID();
    await pool.query(
      `INSERT INTO outbox (topic, aggregate_type, aggregate_id, aggregate_generation, dedupe_key, failed_at, attempts)
       VALUES ('ride.dispatch.requested', 'ride', $1, 1, $2, now(), 10)`,
      [deadId, `metrics-dead:${deadId}`],
    );

    const report = await moduleRef.get(BusinessMetricsSampler, { strict: false }).sample();
    const truth = (
      await pool.query(`
        SELECT count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL) AS pending,
               count(*) FILTER (WHERE failed_at IS NOT NULL) AS exhausted
          FROM outbox`)
    ).rows[0];
    expect(report.outbox!.pending).toBe(Number(truth.pending));
    expect(report.outbox!.pending).toBeGreaterThanOrEqual(1);
    expect(report.outbox!.oldestPendingAgeS).toBeGreaterThan(0);
    expect(await metric('rcab_outbox_pending')).toBe(Number(truth.pending));
    expect(await metric('rcab_outbox_exhausted')).toBe(Number(truth.exhausted));
    expect(await metric('rcab_outbox_oldest_pending_age_seconds')).toBeGreaterThan(0);

    await pool.query(`DELETE FROM outbox WHERE aggregate_id = $1`, [deadId]).catch(() => undefined);
  });
});
