import { uniquePhone } from '@rcab/test-fixtures';
import { Client, Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import * as schema from '../../src/db/schema';
import {
  SharedRideRepository,
  type SharedRideMember,
} from '../../src/modules/matching/shared-ride.repository';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import {
  PoolLifecycleService,
  MATCHING_QUEUE,
  POOL_CLOSED_EVENT,
  type PoolClosedEventPayload,
} from '../../src/modules/matching/pool-lifecycle.service';
import {
  DispatchService,
  DISPATCH_QUEUE,
  RIDE_REQUESTED_EVENT,
  hardFailJobId,
  waveTwoJobId,
} from '../../src/modules/dispatch/dispatch.service';
import { ScheduledDispatchProcessor } from '../../src/modules/scheduled/scheduled.processor';
import { SCHEDULED_WAKE_JOB } from '../../src/modules/scheduled/scheduled.service';
import type {
  SharedRideOfferPayload,
  SoloRideOfferPayload,
} from '../../src/modules/dispatch/dispatch.types';
import {
  buildDispatch,
  insertOffer,
  markOnline,
  seedClient,
  seedClosedPool,
  seedDriver,
  seedSoloRide,
  type DispatchHarness,
} from './support/dispatch-fixtures';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function parseRedis(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
  };
}

describe.skipIf(skip)('DispatchService — integration (Postgres + Redis + BullMQ)', () => {
  let pgClient: Client;
  let pgPoolA: Pool;
  let pgPoolB: Pool;
  let redis: Redis;
  let matchingQueue: Queue;
  let dispatchQueue: Queue;
  let lifecycle: PoolLifecycleService;
  let dispatch: DispatchService;
  let harness: DispatchHarness;
  let harnessB: DispatchHarness;
  let ridesRepo: RidesRepository;
  let bus: {
    toDriver: ReturnType<typeof vi.fn>;
    toUser: ReturnType<typeof vi.fn>;
    toRide: ReturnType<typeof vi.fn>;
    toPool: ReturnType<typeof vi.fn>;
    joinPool: ReturnType<typeof vi.fn>;
    joinRide: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    pgClient = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    await pgClient.connect();
    // Real pools (independent connections) for the dispatch services — the
    // accept transaction needs its own connection per caller.
    pgPoolA = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 4 });
    pgPoolB = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 4 });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });

    const pgPool = {
      query: (text: string, values?: unknown[]) => pgClient.query(text, values as never),
    };
    const db = drizzle(pgPool as never, { schema });
    const repo = new SharedRideRepository(db as never);

    const conn = parseRedis(process.env.TEST_REDIS_URL!);
    matchingQueue = new Queue(MATCHING_QUEUE, { connection: conn });
    dispatchQueue = new Queue(DISPATCH_QUEUE, { connection: conn });

    const events = new EventEmitter2();
    const config = { get: vi.fn().mockReturnValue(undefined) };

    bus = {
      toDriver: vi.fn(),
      toUser: vi.fn(),
      toRide: vi.fn(),
      toPool: vi.fn(),
      joinPool: vi.fn().mockResolvedValue(undefined),
      joinRide: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn(),
    };

    lifecycle = new PoolLifecycleService(
      repo,
      matchingQueue as never,
      redis,
      events,
      bus as never,
      config as never,
    );

    harness = buildDispatch(pgPoolA, redis, dispatchQueue, bus);
    harnessB = buildDispatch(pgPoolB, redis, dispatchQueue, bus);
    dispatch = harness.dispatch;
    ridesRepo = harness.rides;
  });

  afterAll(async () => {
    await pgClient.query('DELETE FROM ride_stops').catch(() => {});
    await pgClient.query('DELETE FROM shared_rides').catch(() => {});
    await pgClient.query('DELETE FROM rides').catch(() => {});
    await pgClient
      .query("DELETE FROM app_user WHERE firebase_uid LIKE 'fb-solo-%'")
      .catch(() => {});
    await matchingQueue?.obliterate({ force: true }).catch(() => {});
    await dispatchQueue?.obliterate({ force: true }).catch(() => {});
    await matchingQueue?.close().catch(() => {});
    await dispatchQueue?.close().catch(() => {});
    await pgClient.end();
    await Promise.all([pgPoolA?.end(), pgPoolB?.end()]);
    await redis.quit();
  });

  it('dispatchPool fans out ride_offer events with the persisted itinerary, schedules timers', async () => {
    bus.toDriver.mockClear();

    const { poolId } = await seedClosedPool(pgClient, { members: 2, lat: 22.5727, lng: 88.364 });
    const driverId = await seedDriver(pgClient);
    await redis.geoadd('active_drivers', 88.3641, 22.5728, driverId);

    const pool = (await harness.shared.findById(poolId))!;
    await dispatch.runPoolWave(pool, 1, 1);

    const offered = bus.toDriver.mock.calls.filter((c) => c[0] === driverId);
    expect(offered).toHaveLength(1);
    const [, eventName, payload] = offered[0] as [string, string, SharedRideOfferPayload];
    expect(eventName).toBe('ride_offer');
    expect(payload.sharedRideId).toBe(poolId);
    expect(payload.waveNumber).toBe(1);
    expect(payload.passengerCount).toBe(2);
    expect(payload.stops).toHaveLength(4);
    expect(payload.stops[0].type).toBe('pickup');

    expect(await dispatchQueue.getJob(waveTwoJobId(poolId, 1))).toBeDefined();
    expect(await dispatchQueue.getJob(hardFailJobId(poolId, 1))).toBeDefined();

    await redis.zrem('active_drivers', driverId);
  });

  it('claimPool via offer accept: second driver gets trip_taken; DB shows first claim', async () => {
    bus.toDriver.mockClear();

    const { poolId } = await seedClosedPool(pgClient, { members: 2 });
    const trip = { kind: 'shared', sharedRideId: poolId } as const;
    const driverA = await seedDriver(pgClient);
    const driverB = await seedDriver(pgClient);
    await markOnline(redis, driverA);
    const offerA = await insertOffer(pgClient, { trip, driverId: driverA });
    const offerB = await insertOffer(pgClient, { trip, driverId: driverB });

    const a = await dispatch.acceptOffer({ offerId: offerA, driverId: driverA });
    const b = await harnessB.dispatch.acceptOffer({ offerId: offerB, driverId: driverB });

    expect(a).toEqual({ ok: true, trip, generation: 1, replay: false });
    expect(b).toEqual({ ok: false, reason: 'trip_taken' });

    const { rows } = await pgClient.query<{ claimed_by_driver_id: string; claimed_at: Date }>(
      'SELECT claimed_by_driver_id, claimed_at FROM shared_rides WHERE ride_id = $1',
      [poolId],
    );
    expect(rows[0].claimed_by_driver_id).toBe(driverA);
    expect(rows[0].claimed_at).toBeInstanceOf(Date);
    const guards = await pgClient.query(
      'SELECT driver_id FROM driver_active_assignment WHERE shared_ride_id = $1',
      [poolId],
    );
    expect(guards.rows).toEqual([{ driver_id: driverA }]);
    expect(await redis.hget(`driver:state:${driverA}`, 'current_ride_id')).toBe(poolId);
  });

  it('handleHardFail with no claim → pool transitions to aborted', async () => {
    bus.toDriver.mockClear();

    const { poolId } = await seedClosedPool(pgClient, { members: 2 });
    const driverId = await seedDriver(pgClient);
    const offerId = await insertOffer(pgClient, {
      trip: { kind: 'shared', sharedRideId: poolId },
      driverId,
    });

    const fakeJob = { data: { rideId: poolId } } as Job<{ rideId: string }>;
    await dispatch.handleHardFail(fakeJob);

    const { rows } = await pgClient.query<{ pool_state: string }>(
      'SELECT pool_state FROM shared_rides WHERE ride_id = $1',
      [poolId],
    );
    expect(rows[0].pool_state).toBe('aborted');
    const members = await pgClient.query<{ active: boolean }>(
      'SELECT active FROM pool_member WHERE pool_id = $1',
      [poolId],
    );
    expect(members.rows.every((m) => !m.active)).toBe(true);
    const offer = await pgClient.query('SELECT state FROM dispatch_offer WHERE id = $1', [offerId]);
    expect(offer.rows[0].state).toBe('revoked');
    expect(bus.toDriver).toHaveBeenCalledWith(
      driverId,
      'ride_offer_revoked',
      expect.objectContaining({ offerId, sharedRideId: poolId, reason: 'revoked' }),
    );
  });

  it('pool.closed event triggers dispatchPool via the registered listener', async () => {
    bus.toDriver.mockClear();

    // @OnEvent metadata is only wired up when Nest builds the provider via DI.
    // We instantiate DispatchService directly here, so subscribe its handler
    // manually for this test only.
    const events = (
      lifecycle as unknown as {
        events: { on: (e: string, f: (p: PoolClosedEventPayload) => void) => void };
      }
    ).events;
    const handler = (payload: PoolClosedEventPayload): void => {
      void dispatch.onPoolClosed(payload);
    };
    events.on(POOL_CLOSED_EVENT, handler);

    const driverId = randomUUID();
    await redis.geoadd('active_drivers', 88.368, 22.578, driverId);

    const pool = await lifecycle.openPool({
      passengerId: 'p-opener',
      originLat: 22.578,
      originLng: 88.368,
      destLat: 22.585,
      destLng: 88.374,
      maxSeats: 2,
      detourBudgetM: 800,
    });
    // close via lifecycle → emits pool.closed → DispatchService.onPoolClosed fires
    await lifecycle.closePool(pool.rideId, 'closed_full');

    // Event-loop tick; @OnEvent({ async: true }) is fire-and-forget.
    await new Promise((r) => setTimeout(r, 100));

    expect(bus.toDriver).toHaveBeenCalledWith(
      driverId,
      'ride_offer',
      expect.objectContaining({ sharedRideId: pool.rideId }),
    );

    await redis.zrem('active_drivers', driverId);
  });

  it('dispatchSolo fans out a persisted solo ride_offer + schedules timers', async () => {
    bus.toDriver.mockClear();

    const driverId = await seedDriver(pgClient);
    await redis.geoadd('active_drivers', 91.7363, 26.1446, driverId);
    const passengerId = await seedClient(pgClient);
    const rideId = await seedSoloRide(pgClient, passengerId, { lat: 26.1445, lng: 91.7362 });

    const ride = (await ridesRepo.findById(rideId))!;
    await dispatch.runSoloWave(ride, 1, 1);

    const offered = bus.toDriver.mock.calls.filter((c) => c[0] === driverId);
    expect(offered).toHaveLength(1);
    const [, eventName, payload] = offered[0] as [string, string, SoloRideOfferPayload];
    expect(eventName).toBe('ride_offer');
    expect(payload.rideId).toBe(rideId);
    expect(payload.fareCents).toBe(18500);
    expect(payload.waveNumber).toBe(1);

    const { rows } = await pgClient.query(
      'SELECT id, driver_id, trip_kind, state, dispatch_generation FROM dispatch_offer WHERE ride_id = $1',
      [rideId],
    );
    expect(rows).toEqual([
      {
        id: payload.offerId,
        driver_id: driverId,
        trip_kind: 'solo',
        state: 'offered',
        dispatch_generation: 1,
      },
    ]);

    expect(await dispatchQueue.getJob(waveTwoJobId(rideId, 1))).toBeDefined();
    expect(await dispatchQueue.getJob(hardFailJobId(rideId, 1))).toBeDefined();

    await redis.zrem('active_drivers', driverId);
  });

  it('claimSolo (solo): concurrent accepts → exactly one wins; rides row bound to the winner', async () => {
    const passengerId = await seedClient(pgClient);
    const rideId = await seedSoloRide(pgClient, passengerId);
    const trip = { kind: 'solo', rideId } as const;
    const driverA = await seedDriver(pgClient);
    const driverB = await seedDriver(pgClient);
    const offerA = await insertOffer(pgClient, { trip, driverId: driverA });
    const offerB = await insertOffer(pgClient, { trip, driverId: driverB });

    // Two independent connections (one pool per service).
    const [a, b] = await Promise.all([
      dispatch.acceptOffer({ offerId: offerA, driverId: driverA }),
      harnessB.dispatch.acceptOffer({ offerId: offerB, driverId: driverB }),
    ]);

    // Atomic claim: exactly one driver wins; the loser is told the trip is taken.
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: 'trip_taken' });
    const winner = a.ok ? driverA : driverB;

    const { rows } = await pgClient.query<{ status: string; driver_id: string; accepted_at: Date }>(
      'SELECT status, driver_id, accepted_at FROM rides WHERE id = $1',
      [rideId],
    );
    expect(rows[0].status).toBe('accepted');
    expect(rows[0].driver_id).toBe(winner);
    expect(rows[0].accepted_at).toBeInstanceOf(Date);
    const guards = await pgClient.query(
      'SELECT driver_id FROM driver_active_assignment WHERE solo_ride_id = $1',
      [rideId],
    );
    expect(guards.rows).toEqual([{ driver_id: winner }]);
  });

  it('handleHardFail (solo): unclaimed ride → status no_driver + passenger notified', async () => {
    bus.toUser.mockClear();

    const passengerId = await seedClient(pgClient);
    const rideId = await seedSoloRide(pgClient, passengerId, { lat: 26.2, lng: 91.7 });

    await dispatch.handleHardFail({
      data: { rideId, kind: 'solo' },
    } as Job<{ rideId: string; kind: 'solo' | 'pool' }>);

    const { rows } = await pgClient.query<{ status: string }>(
      'SELECT status FROM rides WHERE id = $1',
      [rideId],
    );
    expect(rows[0].status).toBe('no_driver');
    expect(bus.toUser).toHaveBeenCalledWith(passengerId, 'ride_no_driver', { rideId });
  });

  // The pool seat-race block moved to pool-membership.int.spec.ts (Stage C, T27).

  it('scheduled wake → ride.requested → dispatchSolo, end-to-end (RCAB-E6.S3)', async () => {
    bus.toDriver.mockClear();

    // Wire the event → dispatch handler that @OnEvent would register under DI.
    const emitter = (dispatch as unknown as { events: EventEmitter2 }).events;
    const handler = (p: { rideId: string }): void => void dispatch.onRideRequested(p);
    emitter.on(RIDE_REQUESTED_EVENT, handler);

    const driverId = randomUUID();
    await redis.geoadd('active_drivers', 91.7362, 26.1446, driverId);

    const passengerId = randomUUID();
    await pgClient.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
      [
        passengerId,
        `fb-solo-${passengerId}`,
        uniquePhone(),
      ],
    );
    // A scheduled ride sits in `requested` until its wake fires (no dispatch yet).
    const { row } = await ridesRepo.create({
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: `idem-${randomUUID()}`,
      type: 'scheduled',
      scheduledFor: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    // Fire the wake job through the real processor.
    const proc = new ScheduledDispatchProcessor(emitter);
    await proc.process({ name: SCHEDULED_WAKE_JOB, data: { rideId: row.id } } as never);
    // @OnEvent({ async: true }) → dispatchSolo runs on a later tick.
    await new Promise((r) => setTimeout(r, 150));

    expect(bus.toDriver).toHaveBeenCalledWith(
      driverId,
      'ride_offer',
      expect.objectContaining({ rideId: row.id }),
    );

    emitter.off(RIDE_REQUESTED_EVENT, handler);
    await redis.zrem('active_drivers', driverId);
  });
});
