import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Job, Queue } from 'bullmq';
import { Pool } from 'pg';
import Redis from 'ioredis';
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
import { ScheduledDispatchProcessor } from '../../src/modules/scheduled/scheduled.processor';
import { DispatchReconciler } from '../../src/modules/outbox/dispatch-reconciler.service';
import { PoolLifecycleService } from '../../src/modules/matching/pool-lifecycle.service';
import {
  dispatchStartJobId,
  scheduledWakeJobId,
} from '../../src/modules/outbox/outbox.jobs';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// Real Nest wiring end to end: HTTP controller -> RidesRepository (ride + outbox
// in one transaction) -> OutboxRelay -> BullMQ -> the registered processors ->
// DispatchStartService -> DispatchService. Workers run unattended in the suite
// (RCAB_DISABLE_BULL_AUTORUN), so the test plays the worker: it fetches the
// published job and hands it to the DI-built processor, exactly as BullMQ would.
describe.skipIf(skip)('outbox -> relay -> worker -> dispatch (full Nest wiring)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let relay: OutboxRelay;
  let dispatchQ: Queue;
  let scheduledQ: Queue;
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
  const ORIGIN = { lat: 19.076, lng: 72.8777 };
  const DEST = { lat: 19.1136, lng: 72.8697 };

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
    scheduledQ = moduleRef.get(getQueueToken('scheduled-dispatch'), { strict: false });
  }, 30_000);

  afterAll(async () => {
    await pool
      .query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM rides WHERE passenger_id = ANY($1))', [clientIds])
      .catch(() => undefined);
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
      [id, `fb-e2e-${id}`, uniquePhone()],
    );
    clientIds.push(id);
    const jwt = moduleRef
      .get(JwtService)
      .sign({ sub: id, role: 'client', auth_method: 'phone', typ: 'access' });
    return { id, jwt };
  }

  /** An online-looking driver (app_user + driver + active vehicle + geo entry). */
  async function seedNearbyDriver(): Promise<string> {
    const id = randomUUID();
    const vehicleId = randomUUID();
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1,$2,$3,'driver')`,
      [id, `fb-e2e-${id}`, uniquePhone()],
    );
    await pool.query(`INSERT INTO driver (user_id) VALUES ($1)`, [id]);
    await pool.query(
      `INSERT INTO vehicle (id, driver_id, type, reg_no, seats, active) VALUES ($1,$2,'cab_sedan',$3,4,true)`,
      [vehicleId, id, uniqueRegNo()],
    );
    await pool.query(`UPDATE driver SET current_vehicle_id = $2 WHERE user_id = $1`, [id, vehicleId]);
    // Only the newest driver is a candidate: drop earlier tests' geo entries.
    if (driverIds.length) await redis.zrem('active_drivers', ...driverIds);
    driverIds.push(id);
    await redis.geoadd('active_drivers', ORIGIN.lng, ORIGIN.lat, id);
    return id;
  }

  function quote(): string {
    return moduleRef.get(QuoteTokenService).sign({
      originLat: ORIGIN.lat,
      originLng: ORIGIN.lng,
      destLat: DEST.lat,
      destLng: DEST.lng,
      soloFareCents: 18500,
      distanceM: 9000,
      durationS: 1200,
    });
  }

  const body = (type: 'normal' | 'scheduled', extra: object = {}) => ({
    type,
    originLat: ORIGIN.lat,
    originLng: ORIGIN.lng,
    destLat: DEST.lat,
    destLng: DEST.lng,
    quoteToken: quote(),
    ...extra,
  });

  const post = (jwt: string, key: string, payload: object) =>
    supertest(app.getHttpServer())
      .post('/v1/rides')
      .set('Authorization', `Bearer ${jwt}`)
      .set('Idempotency-Key', key)
      .send(payload);

  const outboxRows = async (aggregateId: string) =>
    (await pool.query(`SELECT topic, processed_at, aggregate_generation FROM outbox WHERE aggregate_id = $1`, [aggregateId]))
      .rows;

  async function offeredDriverIds(rideId: string): Promise<string[]> {
    return bus.toDriver.mock.calls
      .filter((c) => c[1] === 'ride_offer' && (c[2] as { rideId?: string }).rideId === rideId)
      .map((c) => c[0] as string);
  }

  it('POST /v1/rides (normal): ride + outbox commit together; relay publishes; the worker job completes only after wave 1 offered the driver', async () => {
    bus.toDriver.mockClear();
    const { jwt } = await seedClient();
    const driverId = await seedNearbyDriver();

    const res = await post(jwt, randomUUID(), body('normal'));
    expect(res.status).toBe(201);
    const rideId = res.body.rideId as string;

    // The intent is already durable, before any queue exists.
    expect(await outboxRows(rideId)).toMatchObject([{ topic: 'ride.dispatch.requested', processed_at: null }]);
    expect((await pool.query('SELECT dispatch_generation FROM rides WHERE id = $1', [rideId])).rows[0]).toEqual({
      dispatch_generation: 1,
    });

    await relay.drainOnce();
    const job = (await dispatchQ.getJob(dispatchStartJobId(rideId, 1))) as Job;
    expect(job).toBeDefined();
    expect(await offeredDriverIds(rideId)).toEqual([]); // publication is not dispatch

    await moduleRef.get(DispatchProcessor, { strict: false }).process(job);
    expect(await offeredDriverIds(rideId)).toEqual([driverId]);

    // Timers for the escalation window exist, one of each kind, for this ride.
    const timers = (await dispatchQ.getJobs(['delayed', 'waiting'])).filter(
      (j) => (j.data as { rideId?: string }).rideId === rideId,
    );
    expect(timers.map((j) => j.name).sort()).toEqual(['dispatch:hard-fail', 'dispatch:wave-timeout']);
  });

  it('a retried identical request (same key) returns the same ride and writes no second intent', async () => {
    const { jwt } = await seedClient();
    const key = randomUUID();
    const b = body('normal');
    const first = await post(jwt, key, b);
    const again = await post(jwt, key, b);
    expect(first.status).toBe(201);
    expect(again.body.rideId).toBe(first.body.rideId);
    expect(await outboxRows(first.body.rideId)).toHaveLength(1);
  });

  it('POST /v1/rides (scheduled): the wake is durable at create; the worker wakes the ride and dispatch runs before the job completes', async () => {
    bus.toDriver.mockClear();
    const { jwt } = await seedClient();
    const driverId = await seedNearbyDriver();
    const when = new Date(Date.now() + 2 * 3600_000).toISOString();

    const res = await post(jwt, randomUUID(), body('scheduled', { scheduledFor: when }));
    expect(res.status).toBe(201);
    const rideId = res.body.rideId as string;
    expect((await pool.query('SELECT dispatch_generation FROM rides WHERE id = $1', [rideId])).rows[0]).toEqual({
      dispatch_generation: 0,
    });
    expect(await outboxRows(rideId)).toMatchObject([{ topic: 'ride.wake.schedule', aggregate_generation: 1 }]);

    await relay.drainOnce();
    const wake = (await scheduledQ.getJob(scheduledWakeJobId(rideId, 1))) as Job;
    expect(wake).toBeDefined();
    expect(await wake.getState()).toBe('delayed');
    expect(await offeredDriverIds(rideId)).toEqual([]); // not dispatched before the wake

    // Fire the wake (the delay elapsed): DI-built processor -> start service -> dispatch.
    await moduleRef.get(ScheduledDispatchProcessor, { strict: false }).process(wake);
    expect((await pool.query('SELECT dispatch_generation, status FROM rides WHERE id = $1', [rideId])).rows[0]).toEqual({
      dispatch_generation: 1,
      status: 'requested',
    });
    expect(await offeredDriverIds(rideId)).toEqual([driverId]);
  });

  it('cancelling a scheduled ride before the wake removes the job and a late wake dispatches nothing (T26)', async () => {
    bus.toDriver.mockClear();
    const { jwt } = await seedClient();
    await seedNearbyDriver();
    const when = new Date(Date.now() + 2 * 3600_000).toISOString();
    const res = await post(jwt, randomUUID(), body('scheduled', { scheduledFor: when }));
    const rideId = res.body.rideId as string;
    await relay.drainOnce();
    const wake = (await scheduledQ.getJob(scheduledWakeJobId(rideId, 1))) as Job;

    const cancel = await supertest(app.getHttpServer())
      .post(`/v1/rides/${rideId}/cancel`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({});
    expect(cancel.status).toBe(200);
    expect(await scheduledQ.getJob(scheduledWakeJobId(rideId, 1))).toBeUndefined();

    // The job is gone, but a worker that already fetched it must still be harmless.
    await moduleRef.get(ScheduledDispatchProcessor, { strict: false }).process(wake);
    expect(await offeredDriverIds(rideId)).toEqual([]);
    expect((await pool.query('SELECT status, dispatch_generation FROM rides WHERE id = $1', [rideId])).rows[0]).toEqual({
      status: 'cancelled',
      dispatch_generation: 0,
    });
  });

  it('boot-time reconcile recovers a wake whose job was lost while the app was down (T25)', async () => {
    const { jwt } = await seedClient();
    const when = new Date(Date.now() + 2 * 3600_000).toISOString();
    const res = await post(jwt, randomUUID(), body('scheduled', { scheduledFor: when }));
    const rideId = res.body.rideId as string;
    await relay.drainOnce();
    await (await scheduledQ.getJob(scheduledWakeJobId(rideId, 1)))!.remove(); // Redis lost it

    const report = await moduleRef.get(DispatchReconciler, { strict: false }).reconcile();
    expect(report.wakeRearmed).toBeGreaterThanOrEqual(1);
    await relay.drainOnce();
    expect(await scheduledQ.getJob(scheduledWakeJobId(rideId, 1))).toBeDefined();
  });

  // C -> B -> A end to end: a pool filled through the real lifecycle commits its
  // itinerary + `pool.dispatch.requested` intent with the closure (slice C); the
  // relay publishes it and the DI-built worker runs pool wave 1 (slice B), which
  // persists an authoritative `dispatch_offer` row before pushing it (slice A).
  it('pool closure -> pool.dispatch.requested -> dispatch-start job -> pool wave 1 persists the offer', async () => {
    bus.toDriver.mockClear();
    const driverId = await seedNearbyDriver();
    const opener = (await seedClient()).id;
    const joiner = (await seedClient()).id;
    const lifecycle = moduleRef.get(PoolLifecycleService, { strict: false });

    const opened = await lifecycle.openPool({
      passengerId: opener,
      originLat: ORIGIN.lat,
      originLng: ORIGIN.lng,
      destLat: DEST.lat,
      destLng: DEST.lng,
      maxSeats: 2,
      detourBudgetM: 800,
      quotedFareCents: 9_000,
    });
    const poolId = opened.rideId;
    poolIds.push(poolId);
    const joined = await lifecycle.joinPool({
      poolId,
      joiner: {
        passenger_id: joiner,
        origin_lat: ORIGIN.lat + 0.0005,
        origin_lng: ORIGIN.lng + 0.0005,
        dest_lat: DEST.lat,
        dest_lng: DEST.lng,
        joined_at: new Date().toISOString(),
      },
      quotedFareCents: 9_000,
    });
    expect(joined).toMatchObject({ joined: true, closedFull: true, seatCount: 2 });

    // The closure committed the dispatch intent at generation 1 (and the expiry
    // schedule at open). Nothing is dispatched before the relay + worker run.
    expect(
      (await outboxRows(poolId)).map((r) => [r.topic, r.aggregate_generation]).sort(),
    ).toEqual([
      ['pool.dispatch.requested', 1],
      ['pool.expire.schedule', 0],
    ]);
    expect(bus.toDriver).not.toHaveBeenCalled();

    await relay.drainOnce();
    const job = (await dispatchQ.getJob(dispatchStartJobId(poolId, 1))) as Job;
    expect(job.data).toEqual({ kind: 'pool', tripId: poolId, generation: 1 });
    await moduleRef.get(DispatchProcessor, { strict: false }).process(job);

    const { rows: offers } = await pool.query(
      `SELECT id, driver_id, trip_kind, state, dispatch_generation
         FROM dispatch_offer WHERE shared_ride_id = $1`,
      [poolId],
    );
    expect(offers).toEqual([
      {
        id: expect.any(String),
        driver_id: driverId,
        trip_kind: 'shared',
        state: 'offered',
        dispatch_generation: 1,
      },
    ]);
    expect(bus.toDriver).toHaveBeenCalledWith(
      driverId,
      'ride_offer',
      expect.objectContaining({ sharedRideId: poolId, offerId: offers[0].id, passengerCount: 2 }),
    );
  });
});
