import { Client } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as schema from '../../src/db/schema';
import { MatchingService } from '../../src/modules/matching/matching.service';
import { SharedRideRepository } from '../../src/modules/matching/shared-ride.repository';
import { PoolLifecycleService, MATCHING_QUEUE } from '../../src/modules/matching/pool-lifecycle.service';
import { randomUUID } from 'node:crypto';

function parseRedis(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
  };
}

const skip = process.env.RCAB_INT_SKIPPED === '1';

// ── Coords ────────────────────────────────────────────────────────────────────
// Kolkata city centre — two corridors, one close to the request, one further.
const REQUEST_ORIGIN = { lat: 22.5726, lng: 88.3639 };
const REQUEST_DEST   = { lat: 22.5800, lng: 88.3700 };

// Pool A: very close to the request corridor (within 200 m)
const POOL_A_ORIGIN  = { lat: 22.5727, lng: 88.3640 };
const POOL_A_DEST    = { lat: 22.5801, lng: 88.3701 };

// Pool B: origin 4 km away — outside the 1500 m spatial pre-filter
const POOL_B_ORIGIN  = { lat: 22.610,  lng: 88.380  };
const POOL_B_DEST    = { lat: 22.620,  lng: 88.390  };

describe.skipIf(skip)('MatchingService — integration (Postgres + Redis)', () => {
  let pgClient: Client;
  let redis: Redis;
  let queue: Queue;
  let svc: MatchingService;
  let poolAId: string;

  beforeAll(async () => {
    pgClient = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    await pgClient.connect();
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });

    const pool = { query: (text: string, values?: unknown[]) => pgClient.query(text, values as never) };
    const db = drizzle(pool as never, { schema });

    const repo   = new SharedRideRepository(db as never);
    const config = { get: vi.fn().mockReturnValue(undefined) };

    const conn = parseRedis(process.env.TEST_REDIS_URL!);
    queue = new Queue(MATCHING_QUEUE, { connection: conn });
    const events = new EventEmitter2();
    const bus = {
      toUser: vi.fn(),
      toRide: vi.fn(),
      toPool: vi.fn(),
      joinPool: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn(),
    };
    const lifecycle = new PoolLifecycleService(
      repo, queue as never, redis, events, bus as never, config as never,
    );

    // Mock RouteSimilarityService: return 0.95 for requests near pool A, 0.1 for pool B
    const scorer = {
      scoreRoutes: vi.fn().mockImplementation(
        async (_a: unknown, b: { originLat: number }) =>
          Math.abs(b.originLat - POOL_A_ORIGIN.lat) < 0.01 ? 0.95 : 0.1,
      ),
    };

    svc = new MatchingService(repo as never, scorer as never, lifecycle, config as never);

    // Seed pool A (close, open)
    poolAId = randomUUID();
    await pgClient.query(`
      INSERT INTO shared_rides
        (ride_id, seat_count, max_seats, pool_state, pool_closed_at,
         detour_budget_m, origin_lat, origin_lng, dest_lat, dest_lng)
      VALUES ($1, 1, 3, 'open', now() + interval '60s', 800,
              $2, $3, $4, $5)
    `, [poolAId, POOL_A_ORIGIN.lat, POOL_A_ORIGIN.lng, POOL_A_DEST.lat, POOL_A_DEST.lng]);

    // Seed pool B (far away, open — should be filtered by spatial pre-filter)
    await pgClient.query(`
      INSERT INTO shared_rides
        (ride_id, seat_count, max_seats, pool_state, pool_closed_at,
         detour_budget_m, origin_lat, origin_lng, dest_lat, dest_lng)
      VALUES ($1, 1, 3, 'open', now() + interval '60s', 800,
              $2, $3, $4, $5)
    `, [randomUUID(), POOL_B_ORIGIN.lat, POOL_B_ORIGIN.lng, POOL_B_DEST.lat, POOL_B_DEST.lng]);
  });

  afterAll(async () => {
    await pgClient.query('DELETE FROM shared_rides').catch(() => {});
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close().catch(() => {});
    await pgClient.end();
    await redis.quit();
  });

  it('slots the request into pool A and returns its ID', async () => {
    const result = await svc.findOrCreatePool({
      passengerId: randomUUID(),
      originLat: REQUEST_ORIGIN.lat, originLng: REQUEST_ORIGIN.lng,
      destLat:   REQUEST_DEST.lat,   destLng:   REQUEST_DEST.lng,
    });

    expect(result.mode).toBe('slotted');
    expect(result.sharedRideId).toBe(poolAId);
  });

  it('increments seat_count in Postgres after slotting', async () => {
    const { rows } = await pgClient.query<{ seat_count: number }>(
      'SELECT seat_count FROM shared_rides WHERE ride_id = $1',
      [poolAId],
    );
    expect(rows[0].seat_count).toBe(2);
  });

  it('opens a new pool when no candidate qualifies', async () => {
    // Mark pool A full so it no longer qualifies
    await pgClient.query(
      "UPDATE shared_rides SET seat_count = max_seats WHERE ride_id = $1",
      [poolAId],
    );

    const result = await svc.findOrCreatePool({
      passengerId: randomUUID(),
      originLat: REQUEST_ORIGIN.lat, originLng: REQUEST_ORIGIN.lng,
      destLat:   REQUEST_DEST.lat,   destLng:   REQUEST_DEST.lng,
    });

    expect(result.mode).toBe('opened');
    const { rows } = await pgClient.query<{ seat_count: number; pool_state: string }>(
      'SELECT seat_count, pool_state FROM shared_rides WHERE ride_id = $1',
      [result.sharedRideId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].seat_count).toBe(1);
    expect(rows[0].pool_state).toBe('open');
  });
});
