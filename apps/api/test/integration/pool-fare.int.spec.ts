import { Pool } from 'pg';
import Redis from 'ioredis';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ROUTE,
  buildPoolStack,
  cleanupPools,
  memberAt,
  seedPassenger,
  snapshot,
  type PoolStack,
} from './pool-harness';
import type { SeatFareQuoter } from '../../src/modules/pricing/pricing.types';

const skip = process.env.RCAB_INT_SKIPPED === '1';

/** Fare depends on the seat count AFTER the join: 1 -> 10 000, 2 -> 7 000, 3 -> 5 500 paise. */
const BY_SEAT_COUNT: Record<number, number> = { 1: 10_000, 2: 7_000, 3: 5_500 };
const seatCountQuoter: SeatFareQuoter = async (ctx) => ({
  perSeatPrice: { amount: BY_SEAT_COUNT[ctx.seatCount], currency: 'INR' },
  seatMultiplier: 1,
  detourFactor: 1,
  policy: 'fixed_at_join',
});

describe.skipIf(skip)('Shared fare — fixed_at_join stand-in (F15 fare half, R10)', () => {
  let admin: Pool;
  let redis: Redis;
  const stacks: PoolStack[] = [];
  const poolIds: string[] = [];
  const passengers: string[] = [];

  const stack = (opts: Parameters<typeof buildPoolStack>[1] = {}) => {
    const s = buildPoolStack(redis, opts);
    stacks.push(s);
    return s;
  };
  const passenger = async () => {
    const id = await seedPassenger(admin);
    passengers.push(id);
    return id;
  };
  const fares = async (poolId: string) => {
    const { rows } = await admin.query<{ passenger_id: string; agreed_fare_cents: number }>(
      'SELECT passenger_id, agreed_fare_cents FROM pool_member WHERE pool_id = $1 ORDER BY joined_at, passenger_id',
      [poolId],
    );
    return rows;
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 4 });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await cleanupPools(admin, poolIds, passengers).catch(() => {});
    await Promise.all(stacks.map((s) => s.close().catch(() => {})));
    await admin.end();
    await redis.quit();
  });

  it('each member keeps the fare quoted at THEIR join; later joins never reprice earlier members', async () => {
    const s = stack();
    const [a, b, c] = [await passenger(), await passenger(), await passenger()];
    const opened = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: a,
      quoteFare: seatCountQuoter,
    });
    poolIds.push(opened.rideId);
    expect(opened.quote.perSeatPrice.amount).toBe(10_000);

    const joinedB = await s.lifecycle.joinPool({
      poolId: opened.rideId,
      joiner: memberAt(b, 1),
      quoteFare: seatCountQuoter,
    });
    expect(joinedB).toMatchObject({ joined: true, seatCount: 2 });
    const afterB = await fares(opened.rideId);
    expect(afterB.map((r) => r.agreed_fare_cents)).toEqual([10_000, 7_000]);

    const joinedC = await s.lifecycle.joinPool({
      poolId: opened.rideId,
      joiner: memberAt(c, 2),
      quoteFare: seatCountQuoter,
    });
    expect(joinedC).toMatchObject({ joined: true, seatCount: 3, closedFull: true });
    if (joinedC.joined) expect(joinedC.quote.perSeatPrice.amount).toBe(5_500);

    // A and B are untouched by C's join (no readjustment).
    const afterC = await fares(opened.rideId);
    expect(afterC.map((r) => [r.passenger_id, r.agreed_fare_cents])).toEqual([
      [a, 10_000],
      [b, 7_000],
      [c, 5_500],
    ]);
  });

  it('prices from the LOCKED state: concurrent joiners are quoted distinct, serialized seat counts', async () => {
    const owner = stack({ max: 2 });
    const other = stack({ max: 2 });
    const opener = await passenger();
    const opened = await owner.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare: seatCountQuoter,
    });
    poolIds.push(opened.rideId);
    const [p2, p3] = [await passenger(), await passenger()];
    const seen: number[] = [];
    const recording: SeatFareQuoter = async (ctx) => {
      seen.push(ctx.seatCount);
      // Hold the pool lock a little so the other joiner really queues behind us.
      await new Promise((r) => setTimeout(r, 150));
      return seatCountQuoter(ctx);
    };
    const results = await Promise.all([
      owner.lifecycle.joinPool({ poolId: opened.rideId, joiner: memberAt(p2, 1), quoteFare: recording }),
      other.lifecycle.joinPool({ poolId: opened.rideId, joiner: memberAt(p3, 2), quoteFare: recording }),
    ]);
    expect(results.every((r) => r.joined)).toBe(true);
    expect([...seen].sort()).toEqual([2, 3]);
    const rows = await fares(opened.rideId);
    expect(rows.map((r) => r.agreed_fare_cents).sort()).toEqual([10_000, 5_500, 7_000]);
  });

  it('a pricing failure on join fails cleanly: no member, no seat, pool untouched', async () => {
    const s = stack();
    const opener = await passenger();
    const opened = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare: seatCountQuoter,
    });
    poolIds.push(opened.rideId);
    const before = await snapshot(admin, opened.rideId);
    const joiner = await passenger();

    await expect(
      s.lifecycle.joinPool({
        poolId: opened.rideId,
        joiner: memberAt(joiner, 1),
        quoteFare: async () => {
          throw new Error('routing_unavailable');
        },
      }),
    ).rejects.toThrow('routing_unavailable');

    const after = await snapshot(admin, opened.rideId);
    expect(after.seatCount).toBe(before.seatCount);
    expect(after.members).toEqual(before.members);
    expect(await fares(opened.rideId)).toHaveLength(1);
    // The failed attempt did not burn the passenger's one-active-pool slot.
    const retry = await s.lifecycle.joinPool({
      poolId: opened.rideId,
      joiner: memberAt(joiner, 1),
      quoteFare: seatCountQuoter,
    });
    expect(retry).toMatchObject({ joined: true, seatCount: 2 });
  });

  it('a pricing failure on open creates no pool at all', async () => {
    const s = stack();
    const opener = await passenger();
    const poolId = '00000000-0000-4000-8000-0000000000f1';
    await expect(
      s.lifecycle.openPool({
        ...ROUTE,
        maxSeats: 3,
        detourBudgetM: 800,
        passengerId: opener,
        poolId,
        quoteFare: async () => {
          throw new Error('routing_unavailable');
        },
      }),
    ).rejects.toThrow('routing_unavailable');
    const { rows } = await admin.query('SELECT 1 FROM shared_rides WHERE ride_id = $1', [poolId]);
    expect(rows).toEqual([]);
    const seat = await admin.query('SELECT 1 FROM pool_member WHERE passenger_id = $1', [opener]);
    expect(seat.rows).toEqual([]);
  });

  it('DB guard: a new member without an agreed fare is rejected (pool_member_agreed_fare_required)', async () => {
    const s = stack();
    const opener = await passenger();
    const opened = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare: seatCountQuoter,
    });
    poolIds.push(opened.rideId);
    const intruder = await passenger();
    await expect(
      admin.query(
        `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng)
         VALUES ($1, $2, 1, 2, 3, 4)`,
        [opened.rideId, intruder],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'pool_member_agreed_fare_required' });
    await expect(
      admin.query(
        `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, agreed_fare_cents)
         VALUES ($1, $2, 1, 2, 3, 4, -1)`,
        [opened.rideId, intruder],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'pool_member_agreed_fare_check' });
  });

  it('DB guard: an agreed fare is immutable once set (fixed at join), but other updates still work', async () => {
    const s = stack();
    const opener = await passenger();
    const opened = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare: seatCountQuoter,
    });
    poolIds.push(opened.rideId);
    await expect(
      admin.query(
        'UPDATE pool_member SET agreed_fare_cents = 1 WHERE pool_id = $1 AND passenger_id = $2',
        [opened.rideId, opener],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'pool_member_agreed_fare_immutable' });
    // Same-value and unrelated updates (e.g. the terminal-state active flip) are fine.
    await admin.query(
      'UPDATE pool_member SET agreed_fare_cents = agreed_fare_cents WHERE pool_id = $1',
      [opened.rideId],
    );
    await admin.query(`UPDATE shared_rides SET pool_state = 'aborted' WHERE ride_id = $1`, [
      opened.rideId,
    ]);
    expect(await fares(opened.rideId)).toEqual([{ passenger_id: opener, agreed_fare_cents: 10_000 }]);
  });
});
