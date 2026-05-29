import { Client } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as schema from '../../src/db/schema';
import { SharedRideRepository } from '../../src/modules/matching/shared-ride.repository';
import {
  PoolLifecycleService,
  MATCHING_QUEUE,
} from '../../src/modules/matching/pool-lifecycle.service';
import { PoolExpireProcessor } from '../../src/modules/matching/pool-expire.processor';
import type { Job } from 'bullmq';

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

describe.skipIf(skip)('PoolLifecycleService — integration (Postgres + Redis + BullMQ)', () => {
  let pgClient: Client;
  let redis: Redis;
  let queue: Queue;
  let lifecycle: PoolLifecycleService;
  let processor: PoolExpireProcessor;

  beforeAll(async () => {
    pgClient = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    await pgClient.connect();
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });

    const pool = {
      query: (text: string, values?: unknown[]) => pgClient.query(text, values as never),
    };
    const db = drizzle(pool as never, { schema });
    const repo = new SharedRideRepository(db as never);

    const conn = parseRedis(process.env.TEST_REDIS_URL!);
    queue = new Queue(MATCHING_QUEUE, { connection: conn });

    const config = { get: vi.fn().mockReturnValue(undefined) };
    const events = new EventEmitter2();
    const bus = {
      toDriver: vi.fn(),
      toUser: vi.fn(),
      toRide: vi.fn(),
      toPool: vi.fn(),
      joinPool: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn(),
    };
    lifecycle = new PoolLifecycleService(
      repo,
      queue as never,
      redis,
      events,
      bus as never,
      config as never,
    );
    processor = new PoolExpireProcessor(lifecycle);
  });

  afterAll(async () => {
    await pgClient.query('DELETE FROM shared_rides').catch(() => {});
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close().catch(() => {});
    await pgClient.end();
    await redis.quit();
  });

  it('openPool writes DB row + members[0] opener, Redis HASH, and enqueues delayed pool:expire', async () => {
    const pool = await lifecycle.openPool({
      passengerId: 'p-opener-1',
      originLat: 22.5727,
      originLng: 88.364,
      destLat: 22.5801,
      destLng: 88.3701,
      maxSeats: 3,
      detourBudgetM: 800,
    });

    const { rows } = await pgClient.query<{
      pool_state: string;
      seat_count: number;
      members: unknown;
    }>('SELECT pool_state, seat_count, members FROM shared_rides WHERE ride_id = $1', [
      pool.rideId,
    ]);
    expect(rows[0].pool_state).toBe('open');
    expect(rows[0].seat_count).toBe(1);
    const members = rows[0].members as Array<{ passenger_id: string }>;
    expect(members).toHaveLength(1);
    expect(members[0].passenger_id).toBe('p-opener-1');

    const hash = await redis.hgetall(`pool:${pool.rideId}`);
    expect(hash.state).toBe('open');
    expect(hash.seat_count).toBe('1');
    expect(hash.max_seats).toBe('3');
    expect(hash.expiry_job_id).toBe(`pool:expire:${pool.rideId}`);

    const job = await queue.getJob(`pool:expire:${pool.rideId}`);
    expect(job).toBeDefined();
    expect(job?.opts.delay).toBe(60_000);
  });

  it('slotRequest filling the last seat transitions pool to closed_full and removes the expiry job', async () => {
    const pool = await lifecycle.openPool({
      passengerId: 'p-opener-2',
      originLat: 22.6,
      originLng: 88.4,
      destLat: 22.61,
      destLng: 88.41,
      maxSeats: 2,
      detourBudgetM: 800,
    });

    // Pool starts at seat_count=1. Slotting once should fill it (max=2).
    const result = await lifecycle.slotRequest({
      pool,
      joiner: {
        passenger_id: 'p-joiner-2',
        origin_lat: 22.6005,
        origin_lng: 88.4005,
        dest_lat: 22.6105,
        dest_lng: 88.4105,
        joined_at: new Date().toISOString(),
      },
    });
    expect(result).toEqual({ slotted: true, closedFull: true, seatCount: 2 });

    const { rows } = await pgClient.query<{ pool_state: string; seat_count: number }>(
      'SELECT pool_state, seat_count FROM shared_rides WHERE ride_id = $1',
      [pool.rideId],
    );
    expect(rows[0].pool_state).toBe('closed_full');
    expect(rows[0].seat_count).toBe(2);

    const hash = await redis.hgetall(`pool:${pool.rideId}`);
    expect(hash.state).toBe('closed_full');
    expect(hash.closed_at).toBeDefined();

    // The expiry job must have been removed.
    const job = await queue.getJob(`pool:expire:${pool.rideId}`);
    expect(job).toBeUndefined();
  });

  it('PoolExpireProcessor → closePool(closed_timeout): DB + HASH updated; job NOT explicitly removed', async () => {
    const pool = await lifecycle.openPool({
      passengerId: 'p-opener-3',
      originLat: 22.55,
      originLng: 88.35,
      destLat: 22.56,
      destLng: 88.36,
      maxSeats: 3,
      detourBudgetM: 800,
    });

    // The processor would normally be invoked by BullMQ when the delayed job fires.
    // We simulate the fire by calling its process() method directly with a Job-like.
    const fakeJob = {
      name: 'pool:expire',
      data: { rideId: pool.rideId },
    } as unknown as Job<{ rideId: string }>;

    await processor.process(fakeJob);

    const { rows } = await pgClient.query<{ pool_state: string }>(
      'SELECT pool_state FROM shared_rides WHERE ride_id = $1',
      [pool.rideId],
    );
    expect(rows[0].pool_state).toBe('closed_timeout');

    const hash = await redis.hgetall(`pool:${pool.rideId}`);
    expect(hash.state).toBe('closed_timeout');
    expect(hash.closed_at).toBeDefined();
  });
});
