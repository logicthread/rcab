import { Pool } from 'pg';
import Redis from 'ioredis';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MatchingService } from '../../src/modules/matching/matching.service';
import {
  buildPoolStack,
  cleanupPools,
  fixedFare,
  poolInvariantViolations,
  seedPassenger,
  snapshot,
  type PoolStack,
} from './pool-harness';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// ── Coords ────────────────────────────────────────────────────────────────────
// Kolkata city centre — two corridors, one close to the request, one further.
const REQUEST_ORIGIN = { lat: 22.5726, lng: 88.3639 };
const REQUEST_DEST = { lat: 22.58, lng: 88.37 };

// Pool A: very close to the request corridor (within 200 m)
const POOL_A_ORIGIN = { lat: 22.5727, lng: 88.364 };
const POOL_A_DEST = { lat: 22.5801, lng: 88.3701 };

// Pool B: origin 4 km away — outside the 1500 m spatial pre-filter
const POOL_B_ORIGIN = { lat: 22.61, lng: 88.38 };
const POOL_B_DEST = { lat: 22.62, lng: 88.39 };

describe.skipIf(skip)('MatchingService — integration (Postgres + Redis)', () => {
  let admin: Pool;
  let redis: Redis;
  let s: PoolStack;
  let svc: MatchingService;
  let poolAId: string;
  const poolIds: string[] = [];
  const passengers: string[] = [];

  const passenger = async () => {
    const id = await seedPassenger(admin);
    passengers.push(id);
    return id;
  };
  const request = (passengerId: string) => ({
    passengerId,
    originLat: REQUEST_ORIGIN.lat,
    originLng: REQUEST_ORIGIN.lng,
    destLat: REQUEST_DEST.lat,
    destLng: REQUEST_DEST.lng,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 2 });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    s = buildPoolStack(redis, { max: 2 });

    // Mock RouteSimilarityService: 0.95 for pool A's corridor, 0.1 elsewhere.
    const scorer = {
      scoreRoutes: vi
        .fn()
        .mockImplementation(async (_a: unknown, b: { originLat: number }) =>
          Math.abs(b.originLat - POOL_A_ORIGIN.lat) < 0.01 ? 0.95 : 0.1,
        ),
    };
    svc = s.matching(scorer);

    // Pool A (close, open) and pool B (far, open), each with a real opener seat.
    for (const [origin, dest] of [
      [POOL_A_ORIGIN, POOL_A_DEST],
      [POOL_B_ORIGIN, POOL_B_DEST],
    ]) {
      const res = await s.lifecycle.openPool({
        originLat: origin.lat,
        originLng: origin.lng,
        destLat: dest.lat,
        destLng: dest.lng,
        maxSeats: 3,
        detourBudgetM: 800,
        passengerId: await passenger(),
        quoteFare: fixedFare(5_000),
      });
      poolIds.push(res.rideId);
    }
    poolAId = poolIds[0];
  });

  afterAll(async () => {
    await cleanupPools(admin, poolIds, passengers).catch(() => {});
    await s.close();
    await admin.end();
    await redis.quit();
  });

  it('joins the request into pool A (spatial pre-filter excludes B) and stores the quoted fare', async () => {
    const quote = vi.fn().mockResolvedValue({
      perSeatPrice: { amount: 6_100, currency: 'INR' },
      seatMultiplier: 0.75,
      detourFactor: 1,
      policy: 'fixed_at_join',
    });
    const pId = await passenger();
    const result = await svc.findOrCreatePool(request(pId), { quote });

    expect(result).toMatchObject({
      mode: 'slotted',
      sharedRideId: poolAId,
      poolStatus: 'open',
      seatCount: 2,
    });
    // Priced inside the seat txn from the locked state: seat count AFTER the join,
    // itinerary including the joiner (two members -> 4 stops).
    expect(quote).toHaveBeenCalledWith(
      expect.objectContaining({
        poolId: poolAId,
        passengerId: pId,
        seatCount: 2,
        stops: expect.arrayContaining([expect.objectContaining({ passengerId: pId })]),
      }),
    );
    expect((quote.mock.calls[0][0] as { stops: unknown[] }).stops).toHaveLength(4);
    const seat = await admin.query(
      'SELECT agreed_fare_cents FROM pool_member WHERE pool_id = $1 AND passenger_id = $2',
      [poolAId, pId],
    );
    expect(seat.rows).toEqual([{ agreed_fare_cents: 6_100 }]);
  });

  it('seat_count in Postgres is derived from membership', async () => {
    const db = await snapshot(admin, poolAId);
    expect(db.seatCount).toBe(2);
    expect(db.members).toHaveLength(2);
  });

  it('the seat that fills pool A closes it; the next request opens a new pool', async () => {
    const filler = await svc.findOrCreatePool(request(await passenger()), { quote: fixedFare(5_000) });
    expect(filler).toMatchObject({
      mode: 'slotted',
      sharedRideId: poolAId,
      poolStatus: 'closed_full',
    });

    const result = await svc.findOrCreatePool(request(await passenger()), { quote: fixedFare(5_000) });
    expect(result.mode).toBe('opened');
    const newId = (result as { sharedRideId: string }).sharedRideId;
    poolIds.push(newId);
    const db = await snapshot(admin, newId);
    expect(db).toMatchObject({ poolState: 'open', seatCount: 1, expireIntents: 1 });
    expect(await poolInvariantViolations(admin, poolIds)).toEqual({ I5: [], I6: [], I7: [] });
  });

  it('a candidate that filled since it was scored is skipped (advisory discovery)', async () => {
    // A stale view of an open pool that is in fact full by the time we join.
    const reqA = request(await passenger());
    const fresh = await svc.findOrCreatePool(reqA, { quote: fixedFare(5_000) });
    const target = (fresh as { sharedRideId: string }).sharedRideId;
    const real = (await s.repo.findById(target))!;
    const scorer = { scoreRoutes: vi.fn().mockResolvedValue(0.95) };
    const stale = s.matching(scorer);
    vi.spyOn(s.repo, 'findCandidates').mockResolvedValueOnce([
      { ...real, poolState: 'open', seatCount: 0 },
    ]);
    await admin.query(`UPDATE shared_rides SET pool_state = 'closed_timeout' WHERE ride_id = $1`, [
      target,
    ]);

    const out = await stale.findOrCreatePool(request(await passenger()), { quote: fixedFare(5_000) });
    expect(out.mode).toBe('opened');
    expect((out as { sharedRideId: string }).sharedRideId).not.toBe(target);
    poolIds.push((out as { sharedRideId: string }).sharedRideId);
  });

  it('an unknown pool id from a stale candidate list is skipped too', async () => {
    const ghost = {
      ...(await s.repo.findById(poolAId))!,
      rideId: randomUUID(),
      poolState: 'open',
      seatCount: 0,
    };
    vi.spyOn(s.repo, 'findCandidates').mockResolvedValueOnce([ghost]);
    const out = await svc.findOrCreatePool(request(await passenger()), { quote: fixedFare(5_000) });
    expect(out.mode).toBe('opened');
    poolIds.push((out as { sharedRideId: string }).sharedRideId);
  });
});
