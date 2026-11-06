import { Pool } from 'pg';
import Redis from 'ioredis';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Job } from 'bullmq';
import {
  POOL_EXPIRE_JOB,
  POOL_UPDATE_EVENT,
} from '../../src/modules/matching/pool-lifecycle.service';
import { PoolExpireProcessor } from '../../src/modules/matching/pool-expire.processor';
import {
  ROUTE,
  buildPoolStack,
  cleanupPools,
  fixedFare,
  memberAt,
  poolInvariantViolations,
  seedPassenger,
  snapshot,
  type PoolStack,
} from './pool-harness';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('PoolLifecycleService — integration (Postgres + Redis)', () => {
  let admin: Pool;
  let redis: Redis;
  let s: PoolStack;
  let processor: PoolExpireProcessor;
  const poolIds: string[] = [];
  const passengers: string[] = [];

  const passenger = async () => {
    const id = await seedPassenger(admin);
    passengers.push(id);
    return id;
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 2 });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    s = buildPoolStack(redis, { max: 2, config: { MATCHING_POOL_TIMEOUT_MS: '45000' } });
    processor = new PoolExpireProcessor(s.lifecycle);
  });

  afterAll(async () => {
    await cleanupPools(admin, poolIds, passengers).catch(() => {});
    await s.close();
    await admin.end();
    await redis.quit();
  });

  it('openPool commits pool + opener seat + expiry intent together; projection + room after commit', async () => {
    const opener = await passenger();
    const res = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare: fixedFare(12_345),
    });
    expect(res).toMatchObject({
      poolState: 'open',
      seatCount: 1,
      maxSeats: 3,
      dispatchGeneration: 0,
    });
    expect(res.members.map((m) => m.passenger_id)).toEqual([opener]);
    const poolId = res.rideId;
    poolIds.push(poolId);

    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({
      poolState: 'open',
      seatCount: 1,
      maxSeats: 3,
      generation: 0,
      members: [opener],
      stops: 0,
      dispatchIntents: [],
      expireIntents: 1,
    });

    // Planned close on the DB clock (MATCHING_POOL_TIMEOUT_MS) and the expiry
    // intent carries exactly that instant, at generation 0.
    const { rows } = await admin.query<{
      pool_closed_at: Date;
      lead_s: number;
      payload: { expireAt: string };
      aggregate_generation: number;
      dedupe_key: string;
      aggregate_type: string;
    }>(
      `SELECT s.pool_closed_at, extract(epoch FROM s.pool_closed_at - s.pool_opened_at)::float8 AS lead_s,
              o.payload, o.aggregate_generation, o.dedupe_key, o.aggregate_type
         FROM shared_rides s JOIN outbox o ON o.aggregate_id = s.ride_id
        WHERE s.ride_id = $1 AND o.topic = 'pool.expire.schedule'`,
      [poolId],
    );
    expect(rows[0].lead_s).toBeCloseTo(45, 0);
    expect(new Date(rows[0].payload.expireAt).getTime()).toBe(rows[0].pool_closed_at.getTime());
    expect(rows[0]).toMatchObject({
      aggregate_generation: 0,
      aggregate_type: 'shared_ride',
      dedupe_key: `pool.expire.schedule:${poolId}:g0`,
    });
    const fare = await admin.query('SELECT agreed_fare_cents FROM pool_member WHERE pool_id = $1', [
      poolId,
    ]);
    expect(fare.rows).toEqual([{ agreed_fare_cents: 12_345 }]);

    expect(await redis.hgetall(`pool:${poolId}`)).toMatchObject({
      state: 'open',
      seat_count: '1',
      max_seats: '3',
      version: String(db.stateVersion),
    });
    expect(await redis.ttl(`pool:${poolId}`)).toBeGreaterThan(0);
    expect(await redis.exists(`pool:${poolId}:seats`)).toBe(0); // removed Redis seat counter
    expect(s.bus.joinPool).toHaveBeenCalledWith(opener, poolId);
    expect(s.bus.toPool).toHaveBeenCalledWith(poolId, POOL_UPDATE_EVENT, {
      sharedRideId: poolId,
      seatCount: 1,
      poolStatus: 'open',
    });
  });

  it('the filling join closes closed_full in the same commit: itinerary persisted, gen 1 intent', async () => {
    const opener = await passenger();
    const joiner = await passenger();
    const res = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 2,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare: fixedFare(7_000),
    });
    const poolId = res.rideId;
    poolIds.push(poolId);

    await expect(
      s.lifecycle.joinPool({ poolId, joiner: memberAt(joiner, 1), quoteFare: fixedFare(8_000) }),
    ).resolves.toMatchObject({ joined: true, closedFull: true, seatCount: 2 });

    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({ poolState: 'closed_full', seatCount: 2, generation: 1, stops: 4 });
    expect(db.dispatchIntents).toEqual([
      { generation: 1, payload: { poolId, reason: 'closed_full' } },
    ]);

    const stops = await admin.query<{ sequence_index: number; type: string; passenger_id: string }>(
      'SELECT sequence_index, type, passenger_id FROM ride_stops WHERE ride_id = $1 ORDER BY sequence_index',
      [poolId],
    );
    expect(stops.rows.map((r) => r.type)).toEqual(['pickup', 'pickup', 'dropoff', 'dropoff']);
    expect(new Set(stops.rows.map((r) => r.passenger_id))).toEqual(new Set([opener, joiner]));
    expect(await redis.hget(`pool:${poolId}`, 'state')).toBe('closed_full');
    expect(await poolInvariantViolations(admin, poolIds)).toEqual({ I5: [], I6: [], I7: [] });
  });

  it('PoolExpireProcessor → guarded timeout close; a redelivered / stale job is a no-op', async () => {
    const opener = await passenger();
    const res = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare: fixedFare(7_000),
    });
    const poolId = res.rideId;
    poolIds.push(poolId);

    const job = { name: POOL_EXPIRE_JOB, data: { rideId: poolId } } as Job<{ rideId: string }>;
    await processor.process(job);
    let db = await snapshot(admin, poolId);
    expect(db).toMatchObject({
      poolState: 'closed_timeout',
      seatCount: 1,
      generation: 1,
      stops: 2,
    });
    expect(db.dispatchIntents).toEqual([
      { generation: 1, payload: { poolId, reason: 'closed_timeout' } },
    ]);
    expect(await redis.hget(`pool:${poolId}`, 'state')).toBe('closed_timeout');

    // Redelivery (or a legacy `pool:expire:<id>` job) after the close.
    await processor.process(job);
    db = await snapshot(admin, poolId);
    expect(db.generation).toBe(1);
    expect(db.dispatchIntents).toHaveLength(1);

    // Unknown job names are ignored.
    await expect(
      processor.process({ name: 'other', data: { rideId: poolId } } as Job<{ rideId: string }>),
    ).resolves.toBeUndefined();
    expect(await poolInvariantViolations(admin, poolIds)).toEqual({ I5: [], I6: [], I7: [] });
  });

  it('a timeout on an EMPTY legacy open pool aborts it instead of dispatching nothing', async () => {
    const { rows } = await admin.query<{ ride_id: string }>(
      `INSERT INTO shared_rides (ride_id, seat_count, max_seats, pool_state, pool_closed_at,
         detour_budget_m, origin_lat, origin_lng, dest_lat, dest_lng)
       VALUES (gen_random_uuid(), 0, 3, 'open', now(), 800, 1, 2, 3, 4) RETURNING ride_id`,
    );
    const poolId = rows[0].ride_id;
    poolIds.push(poolId);
    await expect(s.lifecycle.closeIfOpen(poolId, 'closed_timeout')).resolves.toBe('aborted_empty');
    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({
      poolState: 'aborted',
      generation: 0,
      stops: 0,
      dispatchIntents: [],
    });
  });

  it('rebuildAll re-projects every non-terminal pool after Redis loss', async () => {
    const live = poolIds.slice();
    for (const id of live) await redis.del(`pool:${id}`);
    await s.projection.rebuildAll();
    for (const id of live) {
      const db = await snapshot(admin, id);
      if (['aborted', 'completed'].includes(db.poolState)) {
        expect(await redis.exists(`pool:${id}`)).toBe(0);
      } else {
        expect(await redis.hgetall(`pool:${id}`)).toMatchObject({
          state: db.poolState,
          seat_count: String(db.seatCount),
          version: String(db.stateVersion),
        });
      }
    }
  });
});
