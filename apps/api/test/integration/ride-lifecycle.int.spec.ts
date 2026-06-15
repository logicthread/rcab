import { Client } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/db/schema';
import { SharedRideRepository } from '../../src/modules/matching/shared-ride.repository';
import { RideStopRepository } from '../../src/modules/matching/ride-stop.repository';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import {
  PoolLifecycleService,
  MATCHING_QUEUE,
} from '../../src/modules/matching/pool-lifecycle.service';
import { DispatchService, DISPATCH_QUEUE } from '../../src/modules/dispatch/dispatch.service';
import { RideLifecycleService } from '../../src/modules/ride-lifecycle/ride-lifecycle.service';

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

describe.skipIf(skip)(
  'RideLifecycleService — integration (full pool → 2 pickups + 2 drops → completed)',
  () => {
    let pgClient: Client;
    let redis: Redis;
    let matchingQueue: Queue;
    let dispatchQueue: Queue;
    let lifecycle: PoolLifecycleService;
    let dispatch: DispatchService;
    let rideLifecycle: RideLifecycleService;
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
      const sharedRepo = new SharedRideRepository(db as never);
      const stopsRepo = new RideStopRepository(db as never);
      const ridesRepo = new RidesRepository(db as never);

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
        sharedRepo,
        matchingQueue as never,
        redis,
        events,
        bus as never,
        config as never,
      );

      dispatch = new DispatchService(
        sharedRepo,
        ridesRepo,
        stopsRepo,
        lifecycle,
        bus as never,
        dispatchQueue as never,
        redis,
        events,
        config as never,
      );

      rideLifecycle = new RideLifecycleService(sharedRepo, stopsRepo, bus as never, redis);
    });

    afterAll(async () => {
      await pgClient.query('DELETE FROM ride_stops').catch(() => {});
      await pgClient.query('DELETE FROM shared_rides').catch(() => {});
      await matchingQueue?.obliterate({ force: true }).catch(() => {});
      await dispatchQueue?.obliterate({ force: true }).catch(() => {});
      await matchingQueue?.close().catch(() => {});
      await dispatchQueue?.close().catch(() => {});
      await pgClient.end();
      await redis.quit();
    });

    it('full lifecycle: pool dispatch → claim → 2 pickups + 2 drops → pool_state=completed', async () => {
      const driverId = randomUUID();
      const passengerA = randomUUID();
      const passengerB = randomUUID();

      // 1. Open pool with passenger A, slot passenger B.
      const opened = await lifecycle.openPool({
        passengerId: passengerA,
        originLat: 22.5727,
        originLng: 88.364,
        destLat: 22.5801,
        destLng: 88.3701,
        maxSeats: 2,
        detourBudgetM: 800,
      });
      await lifecycle.slotRequest({
        pool: opened,
        joiner: {
          passenger_id: passengerB,
          origin_lat: 22.573,
          origin_lng: 88.3645,
          dest_lat: 22.5805,
          dest_lng: 88.3705,
          joined_at: new Date().toISOString(),
        },
      });

      // 2. Place a driver in the geo index, register them as a known candidate,
      //    then close the pool to trigger dispatch.
      await redis.geoadd('active_drivers', 88.3641, 22.5728, driverId);
      await lifecycle.closePool(opened.rideId, 'closed_full');
      await dispatch.dispatchPool(opened.rideId);

      // 3. Driver accepts → claim succeeds → ride_stops seeded.
      const claim = await dispatch.claimPool(opened.rideId, driverId);
      expect(claim).toEqual({ ok: true, reason: 'claimed' });

      const seeded = await pgClient.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM ride_stops WHERE ride_id = $1',
        [opened.rideId],
      );
      expect(Number(seeded.rows[0].count)).toBe(4);

      // driver:state.current_ride_id was set on claim.
      const onClaimRideId = await redis.hget(`driver:state:${driverId}`, 'current_ride_id');
      expect(onClaimRideId).toBe(opened.rideId);

      // 4. Driver confirms pickup #0 — pool transitions to closed_started.
      let r = await rideLifecycle.confirmStop({
        rideId: opened.rideId,
        driverId,
        sequenceIndex: 0,
        type: 'pickup',
      });
      expect(r.ok).toBe(true);
      {
        const { rows } = await pgClient.query<{ pool_state: string }>(
          'SELECT pool_state FROM shared_rides WHERE ride_id = $1',
          [opened.rideId],
        );
        expect(rows[0].pool_state).toBe('closed_started');
      }

      // 5. Confirm pickup #1.
      r = await rideLifecycle.confirmStop({
        rideId: opened.rideId,
        driverId,
        sequenceIndex: 1,
        type: 'pickup',
      });
      expect(r.ok).toBe(true);

      // 6. Confirm dropoff #2.
      r = await rideLifecycle.confirmStop({
        rideId: opened.rideId,
        driverId,
        sequenceIndex: 2,
        type: 'dropoff',
      });
      expect(r.ok).toBe(true);

      // 7. Confirm final dropoff #3 — ride completes.
      r = await rideLifecycle.confirmStop({
        rideId: opened.rideId,
        driverId,
        sequenceIndex: 3,
        type: 'dropoff',
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.rideCompleted).toBe(true);

      const final = await pgClient.query<{ pool_state: string; completed_at: Date | null }>(
        'SELECT pool_state, completed_at FROM shared_rides WHERE ride_id = $1',
        [opened.rideId],
      );
      expect(final.rows[0].pool_state).toBe('completed');
      expect(final.rows[0].completed_at).toBeInstanceOf(Date);

      // driver:state.current_ride_id cleared.
      const afterRideId = await redis.hget(`driver:state:${driverId}`, 'current_ride_id');
      expect(afterRideId).toBeNull();

      // every stop has a non-null confirmed_at.
      const stops = await pgClient.query<{ confirmed_at: Date | null }>(
        'SELECT confirmed_at FROM ride_stops WHERE ride_id = $1 ORDER BY sequence_index',
        [opened.rideId],
      );
      expect(stops.rows).toHaveLength(4);
      for (const s of stops.rows) {
        expect(s.confirmed_at).toBeInstanceOf(Date);
      }

      await redis.zrem('active_drivers', driverId);
    });

    it('rejects out-of-order confirmation', async () => {
      const driverId = randomUUID();
      const pool = await lifecycle.openPool({
        passengerId: randomUUID(),
        originLat: 22.576,
        originLng: 88.367,
        destLat: 22.583,
        destLng: 88.373,
        maxSeats: 1,
        detourBudgetM: 800,
      });
      await redis.geoadd('active_drivers', 88.3671, 22.5761, driverId);
      await lifecycle.closePool(pool.rideId, 'closed_full');
      await dispatch.dispatchPool(pool.rideId);
      await dispatch.claimPool(pool.rideId, driverId);

      // Try to confirm dropoff before pickup.
      const r = await rideLifecycle.confirmStop({
        rideId: pool.rideId,
        driverId,
        sequenceIndex: 1,
        type: 'dropoff',
      });
      expect(r).toEqual({ ok: false, reason: 'out_of_order' });

      await redis.zrem('active_drivers', driverId);
    });

    it('rejects confirmation from non-claimed driver', async () => {
      const driverId = randomUUID();
      const intruder = randomUUID();
      const pool = await lifecycle.openPool({
        passengerId: randomUUID(),
        originLat: 22.578,
        originLng: 88.368,
        destLat: 22.585,
        destLng: 88.374,
        maxSeats: 1,
        detourBudgetM: 800,
      });
      await redis.geoadd('active_drivers', 88.3681, 22.5781, driverId);
      await lifecycle.closePool(pool.rideId, 'closed_full');
      await dispatch.dispatchPool(pool.rideId);
      await dispatch.claimPool(pool.rideId, driverId);

      const r = await rideLifecycle.confirmStop({
        rideId: pool.rideId,
        driverId: intruder,
        sequenceIndex: 0,
        type: 'pickup',
      });
      expect(r).toEqual({ ok: false, reason: 'not_owner' });

      await redis.zrem('active_drivers', driverId);
    });
  },
);
