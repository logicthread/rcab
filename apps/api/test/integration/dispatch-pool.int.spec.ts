import { Client } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import * as schema from '../../src/db/schema';
import { SharedRideRepository } from '../../src/modules/matching/shared-ride.repository';
import { RideStopRepository } from '../../src/modules/matching/ride-stop.repository';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import {
  PoolLifecycleService,
  MATCHING_QUEUE,
  POOL_CLOSED_EVENT,
  type PoolClosedEventPayload,
} from '../../src/modules/matching/pool-lifecycle.service';
import { DispatchService, DISPATCH_QUEUE } from '../../src/modules/dispatch/dispatch.service';
import type {
  SharedRideOfferPayload,
  SoloRideOfferPayload,
} from '../../src/modules/dispatch/dispatch.types';

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
  let redis: Redis;
  let matchingQueue: Queue;
  let dispatchQueue: Queue;
  let lifecycle: PoolLifecycleService;
  let dispatch: DispatchService;
  let ridesRepo: RidesRepository;
  let bus: {
    toDriver: ReturnType<typeof vi.fn>;
    toUser: ReturnType<typeof vi.fn>;
    toRide: ReturnType<typeof vi.fn>;
    toPool: ReturnType<typeof vi.fn>;
    joinPool: ReturnType<typeof vi.fn>;
    broadcast: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    pgClient = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    await pgClient.connect();
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });

    const pgPool = {
      query: (text: string, values?: unknown[]) => pgClient.query(text, values as never),
    };
    const db = drizzle(pgPool as never, { schema });
    const repo = new SharedRideRepository(db as never);
    const stopsRepo = new RideStopRepository(db as never);
    ridesRepo = new RidesRepository(db as never);

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

    dispatch = new DispatchService(
      repo,
      ridesRepo,
      stopsRepo,
      lifecycle,
      bus as never,
      dispatchQueue as never,
      redis,
      events,
      config as never,
    );
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
    await redis.quit();
  });

  it('dispatchPool fans out ride_offer events with members[] mapped to stops, schedules timers', async () => {
    bus.toDriver.mockClear();

    const driverId = randomUUID();
    await redis.geoadd('active_drivers', 88.3641, 22.5728, driverId);

    const pool = await lifecycle.openPool({
      passengerId: 'p-opener',
      originLat: 22.5727,
      originLng: 88.364,
      destLat: 22.5801,
      destLng: 88.3701,
      maxSeats: 2,
      detourBudgetM: 800,
    });
    // close it cleanly so dispatch can pick it up
    await lifecycle.closePool(pool.rideId, 'closed_full');

    await dispatch.dispatchPool(pool.rideId);

    expect(bus.toDriver).toHaveBeenCalledTimes(1);
    const [actualDriverId, eventName, payload] = bus.toDriver.mock.calls[0] as [
      string,
      string,
      SharedRideOfferPayload,
    ];
    expect(actualDriverId).toBe(driverId);
    expect(eventName).toBe('ride_offer');
    expect(payload.sharedRideId).toBe(pool.rideId);
    expect(payload.waveNumber).toBe(1);
    expect(payload.stops.length).toBeGreaterThanOrEqual(2);
    expect(payload.stops[0].type).toBe('pickup');

    const waveJob = await dispatchQueue.getJob(`dispatch:wave2-timeout:${pool.rideId}`);
    const hardFailJob = await dispatchQueue.getJob(`dispatch:hard-fail:${pool.rideId}`);
    expect(waveJob).toBeDefined();
    expect(hardFailJob).toBeDefined();

    await redis.zrem('active_drivers', driverId);
  });

  it('claimPool atomic Lua: second driver claim returns already_taken; DB shows first claim', async () => {
    bus.toDriver.mockClear();

    const pool = await lifecycle.openPool({
      passengerId: 'p-opener',
      originLat: 22.574,
      originLng: 88.365,
      destLat: 22.581,
      destLng: 88.371,
      maxSeats: 2,
      detourBudgetM: 800,
    });
    await lifecycle.closePool(pool.rideId, 'closed_full');

    const driverA = randomUUID();
    const driverB = randomUUID();

    const a = await dispatch.claimPool(pool.rideId, driverA);
    const b = await dispatch.claimPool(pool.rideId, driverB);

    expect(a).toEqual({ ok: true, reason: 'claimed' });
    expect(b).toEqual({ ok: false, reason: 'already_taken' });

    const { rows } = await pgClient.query<{ claimed_by_driver_id: string; claimed_at: Date }>(
      'SELECT claimed_by_driver_id, claimed_at FROM shared_rides WHERE ride_id = $1',
      [pool.rideId],
    );
    expect(rows[0].claimed_by_driver_id).toBe(driverA);
    expect(rows[0].claimed_at).toBeInstanceOf(Date);

    const hash = await redis.hgetall(`pool:${pool.rideId}`);
    expect(hash.claimed_by).toBe(driverA);
  });

  it('handleHardFail with no claim → pool transitions to aborted', async () => {
    bus.toDriver.mockClear();

    const pool = await lifecycle.openPool({
      passengerId: 'p-opener',
      originLat: 22.576,
      originLng: 88.367,
      destLat: 22.583,
      destLng: 88.373,
      maxSeats: 2,
      detourBudgetM: 800,
    });
    await lifecycle.closePool(pool.rideId, 'closed_full');

    const fakeJob = { data: { rideId: pool.rideId } } as Job<{ rideId: string }>;
    await dispatch.handleHardFail(fakeJob);

    const { rows } = await pgClient.query<{ pool_state: string }>(
      'SELECT pool_state FROM shared_rides WHERE ride_id = $1',
      [pool.rideId],
    );
    expect(rows[0].pool_state).toBe('aborted');

    const hash = await redis.hgetall(`pool:${pool.rideId}`);
    expect(hash.state).toBe('aborted');
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

  it('dispatchSolo fans out a solo ride_offer (offer:type=solo) + schedules timers', async () => {
    bus.toDriver.mockClear();

    const driverId = randomUUID();
    await redis.geoadd('active_drivers', 91.7363, 26.1446, driverId);

    const passengerId = randomUUID();
    await pgClient.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
      [
        passengerId,
        `fb-solo-${passengerId}`,
        `+9199${Math.floor(Math.random() * 1e8)
          .toString()
          .padStart(8, '0')}`,
      ],
    );
    const { row } = await ridesRepo.create({
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: `idem-${randomUUID()}`,
    });

    await dispatch.dispatchSolo(row.id);

    expect(bus.toDriver).toHaveBeenCalledTimes(1);
    const [actualDriver, eventName, payload] = bus.toDriver.mock.calls[0] as [
      string,
      string,
      SoloRideOfferPayload,
    ];
    expect(actualDriver).toBe(driverId);
    expect(eventName).toBe('ride_offer');
    expect(payload.rideId).toBe(row.id);
    expect(payload.fareCents).toBe(18500);
    expect(payload.waveNumber).toBe(1);

    const offerIds = await redis.smembers(`offer:list:${row.id}`);
    expect(offerIds).toHaveLength(1);
    expect(await redis.get(`offer:type:${offerIds[0]}`)).toBe('solo');

    expect(await dispatchQueue.getJob(`dispatch:wave2-timeout:${row.id}`)).toBeDefined();
    expect(await dispatchQueue.getJob(`dispatch:hard-fail:${row.id}`)).toBeDefined();

    await redis.zrem('active_drivers', driverId);
  });
});
