/**
 * RCAB-E8.S13 — optimistic seat pricing: no routing call ever runs while the
 * `shared_rides` row lock is held.
 *
 * Uses the REAL PricingService (itinerary legs, detour factor, seat multiplier)
 * against an OSRM stub with injected latency, real Postgres with independent
 * connections per contender, and asserts on the committed rows: each member's
 * agreed fare must equal what the committed member count + persisted itinerary
 * imply, and the transaction (lock) hold time must stay far below the routing
 * latency.
 */
import { Pool } from 'pg';
import Redis from 'ioredis';
import { timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
import { buildPolicy } from '../../src/config/policy/policy';
import { PricingService } from '../../src/modules/pricing/pricing.service';
import { computeStops } from '../../src/modules/matching/itinerary';
import type { SeatFareContext, SeatFareQuoter } from '../../src/modules/pricing/pricing.types';

const skip = process.env.RCAB_INT_SKIPPED === '1';

const OSRM_LATENCY_MS = 400;

/**
 * OSRM stand-in: every leg is 1 000 m / 100 s. `delayMs` simulates a slow
 * routing engine; `onCall` observes every request.
 */
function osrmStub(delayMs: number, onCall?: (url: string) => void) {
  return {
    get: (url: string) => {
      onCall?.(url);
      const waypoints = url.split('/driving/')[1].split('?')[0].split(';').length;
      return timer(delayMs).pipe(
        map(() => ({
          data: {
            code: 'Ok',
            routes: [
              {
                distance: (waypoints - 1) * 1000,
                duration: (waypoints - 1) * 100,
                legs: Array.from({ length: waypoints - 1 }, () => ({ distance: 1000, duration: 100 })),
              },
            ],
          },
        })),
      );
    },
  };
}

/** An in-memory stand-in for the pricing route cache (never a cache hit). */
const noCacheRedis = { get: async () => null, set: async () => 'OK' };

function pricingWith(delayMs: number, onCall?: (url: string) => void): PricingService {
  const config = { get: () => undefined };
  return new PricingService(
    osrmStub(delayMs, onCall) as never,
    noCacheRedis as never,
    config as never,
    buildPolicy(config),
  );
}

describe.skipIf(skip)('Optimistic seat pricing — no routing under the pool lock (RCAB-E8.S13)', () => {
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
  async function openPool(s: PoolStack, maxSeats: number, quoteFare: SeatFareQuoter = fixedFare(10_000)) {
    const opener = await passenger();
    const row = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats,
      detourBudgetM: 800,
      passengerId: opener,
      quoteFare,
    });
    poolIds.push(row.rideId);
    return { poolId: row.rideId, opener };
  }
  /** Records how long each pool transaction (= how long the row lock could be held) lasted. */
  function timeTransactions(s: PoolStack): number[] {
    const durations: number[] = [];
    const original = s.db.transaction.bind(s.db) as (fn: never, cfg?: never) => Promise<unknown>;
    (s.db as { transaction: unknown }).transaction = async (fn: never, cfg?: never) => {
      const t0 = Date.now();
      try {
        return await original(fn, cfg);
      } finally {
        durations.push(Date.now() - t0);
      }
    };
    return durations;
  }

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

  it('a slow OSRM quote holds NO lock: closeIfOpen on the same pool does not wait for it', async () => {
    const [joinStack, timerStack] = [stack(), stack()];
    const { poolId } = await openPool(joinStack, 3);
    const joiner = await passenger();
    const pricing = pricingWith(OSRM_LATENCY_MS);

    let lockProbe: 'free' | 'held' | null = null;
    let closeMs = -1;
    let closeResult: string | null = null;
    const quoteFare: SeatFareQuoter = async (ctx: SeatFareContext) => {
      // We are inside the joiner's (slow) pricing call. Probe the row lock
      // from an unrelated connection: NOWAIT fails fast if anyone holds it.
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        try {
          await c.query('SELECT 1 FROM shared_rides WHERE ride_id = $1 FOR UPDATE NOWAIT', [poolId]);
          lockProbe = 'free';
        } catch (err) {
          lockProbe = (err as { code?: string }).code === '55P03' ? 'held' : null;
        }
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      // A closure now must not queue behind the slow quote.
      const t0 = Date.now();
      closeResult = await timerStack.lifecycle.closeIfOpen(poolId, 'closed_timeout');
      closeMs = Date.now() - t0;
      return pricing.quoteSeatInItinerary(ctx);
    };

    const res = await joinStack.lifecycle.joinPool({
      poolId,
      joiner: memberAt(joiner, 1),
      quoteFare,
    });

    expect(lockProbe).toBe('free');
    expect(closeResult).toBe('closed');
    expect(closeMs).toBeLessThan(OSRM_LATENCY_MS / 2);
    // The slow quote lost the race to the closure: typed rejection, no seat.
    expect(res).toEqual({ joined: false, reason: 'pool_closed' });
    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({ poolState: 'closed_timeout', seatCount: 1, stops: 2 });
    expect(db.members).not.toContain(joiner);
    expect((await poolInvariantViolations(admin, [poolId])).I5).toEqual([]);
  });

  it('two racing joins with slow OSRM: both fares match the committed member counts and itineraries; lock hold stays small', async () => {
    const [a, b] = [stack({ max: 2 }), stack({ max: 2 })];
    const durationsA = timeTransactions(a);
    const durationsB = timeTransactions(b);
    const { poolId, opener } = await openPool(a, 3);
    durationsA.length = 0;
    const [j1, j2] = [await passenger(), await passenger()];

    let osrmCalls = 0;
    const pricing = pricingWith(OSRM_LATENCY_MS, () => osrmCalls++);
    const quotes = new Map<string, SeatFareContext[]>();
    const recording: SeatFareQuoter = async (ctx) => {
      quotes.set(ctx.passengerId, [...(quotes.get(ctx.passengerId) ?? []), ctx]);
      return pricing.quoteSeatInItinerary(ctx);
    };

    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      a.lifecycle.joinPool({ poolId, joiner: memberAt(j1, 1), quoteFare: recording }),
      b.lifecycle.joinPool({ poolId, joiner: memberAt(j2, 2), quoteFare: recording }),
    ]);
    const elapsed = Date.now() - t0;

    // Both seated, in some serialized order: seat 2 then seat 3 (which fills + closes).
    if (!r1.joined || !r2.joined) throw new Error(`both joins must commit: ${JSON.stringify({ r1, r2 })}`);
    expect([r1.seatCount, r2.seatCount].sort()).toEqual([2, 3]);

    // The loser was re-priced from the committed state: 3 pricing rounds in total.
    const totalQuotes = [...quotes.values()].reduce((n, q) => n + q.length, 0);
    expect(totalQuotes).toBe(3);
    // …and it still took ~two routing latencies, not a serialized lock queue per call.
    expect(elapsed).toBeGreaterThanOrEqual(OSRM_LATENCY_MS);

    // Final state is a full, closed pool with one itinerary of 3 pickups + 3 dropoffs.
    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({ poolState: 'closed_full', seatCount: 3, stops: 6, generation: 1 });
    expect(db.dispatchIntents).toHaveLength(1);

    const rows = await admin.query<{
      passenger_id: string;
      agreed_fare_cents: number;
      origin_lat: number;
      origin_lng: number;
      dest_lat: number;
      dest_lng: number;
      joined_at: Date;
    }>(
      `SELECT passenger_id, agreed_fare_cents, origin_lat, origin_lng, dest_lat, dest_lng, joined_at
         FROM pool_member WHERE pool_id = $1`,
      [poolId],
    );
    const fareOf = new Map(rows.rows.map((r) => [r.passenger_id, Number(r.agreed_fare_cents)]));
    expect(fareOf.size).toBe(3);

    // What the persisted (final) itinerary implies for the LAST joiner.
    const persisted = await admin.query<{
      passenger_id: string;
      type: 'pickup' | 'dropoff';
      sequence_index: number;
    }>('SELECT passenger_id, type, sequence_index FROM ride_stops WHERE ride_id = $1 ORDER BY sequence_index', [
      poolId,
    ]);
    const expectedFare = (stops: Array<{ type: string; passengerId: string }>, pid: string, seatCount: number) => {
      const pick = stops.findIndex((s) => s.type === 'pickup' && s.passengerId === pid);
      const drop = stops.findIndex((s) => s.type === 'dropoff' && s.passengerId === pid);
      const direct = { distanceM: 1000, durationS: 100 };
      return pricing.quoteSeatFromMetrics({
        soloPrice: pricing.quoteSoloFromMetrics(direct),
        seatCount,
        directDistanceM: direct.distanceM,
        poolDistanceM: (drop - pick) * 1000,
      }).perSeatPrice.amount;
    };

    const last = r1.seatCount === 3 ? { pid: j1, r: r1 } : { pid: j2, r: r2 };
    const first = r1.seatCount === 2 ? { pid: j1, r: r1 } : { pid: j2, r: r2 };

    // Last joiner (seat 3): fare == persisted 3-member itinerary.
    const persistedStops = persisted.rows.map((s) => ({ type: s.type, passengerId: s.passenger_id }));
    expect(fareOf.get(last.pid)).toBe(expectedFare(persistedStops, last.pid, 3));
    expect(last.r.quote.perSeatPrice.amount).toBe(fareOf.get(last.pid));
    // Its accepted quote was computed from the 3-member state, not the stale 2-member snapshot.
    const lastCtx = quotes.get(last.pid)!.at(-1)!;
    expect(lastCtx.seatCount).toBe(3);
    expect(new Set(lastCtx.stops.map((s) => s.passengerId))).toEqual(new Set([opener, j1, j2]));

    // First joiner (seat 2): fare == the 2-member itinerary that was committed at that moment.
    const memberRow = (pid: string) => rows.rows.find((r) => r.passenger_id === pid)!;
    const twoMemberStops = computeStops({
      originLat: ROUTE.originLat,
      originLng: ROUTE.originLng,
      members: [opener, first.pid].map((pid) => {
        const m = memberRow(pid);
        return {
          passenger_id: pid,
          origin_lat: Number(m.origin_lat),
          origin_lng: Number(m.origin_lng),
          dest_lat: Number(m.dest_lat),
          dest_lng: Number(m.dest_lng),
          joined_at: new Date(m.joined_at).toISOString(),
        };
      }),
    });
    expect(fareOf.get(first.pid)).toBe(expectedFare(twoMemberStops, first.pid, 2));
    expect(first.r.quote.perSeatPrice.amount).toBe(fareOf.get(first.pid));
    // Fixed at join: the opener's fare is untouched by either join.
    expect(fareOf.get(opener)).toBe(10_000);

    // Lock hold: no pool transaction came anywhere near the routing latency.
    const all = [...durationsA, ...durationsB];
    expect(all.length).toBeGreaterThanOrEqual(3); // 2 commits + 1 stale attempt
    expect(Math.max(...all)).toBeLessThan(OSRM_LATENCY_MS / 2);

    expect((await poolInvariantViolations(admin, [poolId]))).toEqual({ I5: [], I6: [], I7: [] });
  });

  it('a pool that keeps changing during pricing ends as a typed conflict after joinPriceRetries (no seat, no partial write)', async () => {
    const s = stack({ config: { MATCHING_JOIN_PRICE_RETRIES: '2' } });
    const { poolId } = await openPool(s, 3);
    const joiner = await passenger();
    const before = await snapshot(admin, poolId);

    let quoteCalls = 0;
    const churning: SeatFareQuoter = async (ctx) => {
      quoteCalls++;
      // Any UPDATE of the pool row bumps state_version (trigger): "someone else changed the pool".
      await admin.query('UPDATE shared_rides SET dispatch_generation = dispatch_generation WHERE ride_id = $1', [
        poolId,
      ]);
      return fixedFare(1)(ctx);
    };

    const res = await s.lifecycle.joinPool({ poolId, joiner: memberAt(joiner, 1), quoteFare: churning });

    expect(res).toEqual({ joined: false, reason: 'conflict' });
    expect(quoteCalls).toBe(3); // first attempt + 2 retries
    const after = await snapshot(admin, poolId);
    expect(after.members).toEqual(before.members);
    expect(after.seatCount).toBe(before.seatCount);
    expect(after.poolState).toBe('open');
    // The passenger is not stuck: a calm retry seats them.
    await expect(
      s.lifecycle.joinPool({ poolId, joiner: memberAt(joiner, 1), quoteFare: fixedFare(2) }),
    ).resolves.toMatchObject({ joined: true, seatCount: 2 });
  });

  it('matching falls through to a NEW pool when the candidate pool is too contended to price against', async () => {
    const s = stack({ config: { MATCHING_JOIN_PRICE_RETRIES: '1' } });
    // A corridor of its own (the database is shared with other specs).
    const origin = { lat: 12.9716, lng: 77.5946 };
    const dest = { lat: 12.9816, lng: 77.6046 };
    const candidate = await s.lifecycle.openPool({
      originLat: origin.lat,
      originLng: origin.lng,
      destLat: dest.lat,
      destLng: dest.lng,
      maxSeats: 3,
      detourBudgetM: 800,
      passengerId: await passenger(),
      quoteFare: fixedFare(10_000),
    });
    poolIds.push(candidate.rideId);

    const requester = await passenger();
    const quote = vi.fn(async (ctx: SeatFareContext) => {
      if (ctx.poolId === candidate.rideId) {
        await admin.query(
          'UPDATE shared_rides SET dispatch_generation = dispatch_generation WHERE ride_id = $1',
          [candidate.rideId],
        );
      }
      return fixedFare(4_321)(ctx);
    });
    const result = await s
      .matching({ scoreRoutes: async () => 0.95 })
      .findOrCreatePool(
        {
          passengerId: requester,
          originLat: origin.lat,
          originLng: origin.lng,
          destLat: dest.lat,
          destLng: dest.lng,
        },
        { quote },
      );

    expect(result).toMatchObject({ mode: 'opened', poolStatus: 'open', seatCount: 1 });
    if (result.mode !== 'opened') throw new Error('unreachable');
    poolIds.push(result.sharedRideId);
    expect(result.sharedRideId).not.toBe(candidate.rideId);
    // 1 attempt + 1 retry on the contended candidate, then 1 quote for the new pool.
    expect(quote).toHaveBeenCalledTimes(3);
    expect((await snapshot(admin, candidate.rideId)).seatCount).toBe(1);
    const seat = await admin.query(
      'SELECT agreed_fare_cents FROM pool_member WHERE pool_id = $1 AND passenger_id = $2',
      [result.sharedRideId, requester],
    );
    expect(seat.rows).toEqual([{ agreed_fare_cents: 4_321 }]);
  });
});
