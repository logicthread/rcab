import { describe, it, expect, vi } from 'vitest';
import { MatchingService, type SharedRideRequest } from './matching.service';
import type { SharedRideRow } from './shared-ride.repository';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Kolkata: two nearby points ~200 m apart
const REQUEST: SharedRideRequest = {
  originLat: 22.5726, originLng: 88.3639,
  destLat:   22.5800, destLng:   88.3700,
};

function pool(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId:        'pool-uuid-1',
    seatCount:     1,
    maxSeats:      3,
    poolState:     'open',
    poolClosedAt:  null,
    detourBudgetM: 800,
    // centroid very close to REQUEST origin/dest
    originLat: 22.5727, originLng: 88.3640,
    destLat:   22.5801, destLng:   88.3701,
    ...overrides,
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

function buildRepo(candidates: SharedRideRow[] = [], createdPool?: SharedRideRow) {
  return {
    findCandidates:   vi.fn().mockResolvedValue(candidates),
    create:           vi.fn().mockResolvedValue(createdPool ?? { ...pool(), rideId: 'new-pool-uuid', seatCount: 1 }),
    incrementSeats:   vi.fn().mockResolvedValue(undefined),
  };
}

function buildScorer(score: number | number[]) {
  const scores = Array.isArray(score) ? score : [score];
  let i = 0;
  return { scoreRoutes: vi.fn().mockImplementation(() => Promise.resolve(scores[i++ % scores.length])) };
}

function buildRedis(evalResult: number = 2) {
  return { eval: vi.fn().mockResolvedValue(evalResult) };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return { get: vi.fn((key: string) => overrides[key] ?? undefined) };
}

function makeService(
  candidates: SharedRideRow[] = [],
  score: number | number[] = 0.9,
  evalResult = 2,
  configOverrides: Record<string, unknown> = {},
) {
  const repo   = buildRepo(candidates);
  const scorer = buildScorer(score);
  const redis  = buildRedis(evalResult);
  const config = buildConfig(configOverrides);

  const svc = new MatchingService(
    repo as never,
    scorer as never,
    redis as never,
    config as never,
  );
  return { svc, repo, scorer, redis };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MatchingService.findOrCreatePool', () => {
  describe('slotting', () => {
    it('slots into an existing pool when score ≥ 0.7 and detour ≤ 800 m', async () => {
      const { svc, repo, redis } = makeService([pool()], 0.85);
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result).toEqual({ mode: 'slotted', sharedRideId: 'pool-uuid-1' });
      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(repo.incrementSeats).toHaveBeenCalledWith('pool-uuid-1', 2);
    });

    it('opens a new pool when similarity is below threshold (< 0.7)', async () => {
      const { svc, repo } = makeService([pool()], 0.5);
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('opens a new pool when detour exceeds budget', async () => {
      // Pool far away — detour > 800 m
      const farPool = pool({ originLat: 22.590, originLng: 88.375 }); // ~2 km away
      const { svc, repo } = makeService([farPool], 0.9);
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('opens a new pool when there are no candidates', async () => {
      const { svc, repo } = makeService([]);
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(result.sharedRideId).toBe('new-pool-uuid');
    });
  });

  describe('best-pool selection', () => {
    it('slots into the higher composite-score pool when multiple qualify', async () => {
      const poolA = pool({ rideId: 'pool-a', originLat: 22.5727, originLng: 88.3640 });
      const poolB = pool({ rideId: 'pool-b', originLat: 22.5728, originLng: 88.3641 });
      // scorer returns 0.95 for pool-a, 0.80 for pool-b
      const { svc, repo } = makeService([poolA, poolB], [0.95, 0.80]);
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('slotted');
      expect(result.sharedRideId).toBe('pool-a'); // higher composite score wins
      expect(repo.incrementSeats).toHaveBeenCalledWith('pool-a', expect.any(Number));
    });
  });

  describe('Lua slot interaction', () => {
    it('calls redis.eval with pool key, max_seats, and current seat_count', async () => {
      const p = pool({ rideId: 'my-pool', seatCount: 1, maxSeats: 3 });
      const { svc, redis } = makeService([p], 0.9, 2);
      await svc.findOrCreatePool(REQUEST);

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),  // Lua script
        1,
        'pool:my-pool:seats',
        '3',
        '1',
      );
    });

    it('falls through to next candidate when Lua returns -1 (full)', async () => {
      const poolFull  = pool({ rideId: 'full-pool',  seatCount: 3, maxSeats: 3 });
      const poolOpen  = pool({ rideId: 'open-pool',  seatCount: 1, maxSeats: 3 });
      const repo   = buildRepo([poolFull, poolOpen]);
      const scorer = buildScorer(0.9);
      // First eval returns -1 (full), second returns 2 (success)
      const redis  = { eval: vi.fn().mockResolvedValueOnce(-1).mockResolvedValueOnce(2) };
      const config = buildConfig();
      const svc = new MatchingService(repo as never, scorer as never, redis as never, config as never);

      const result = await svc.findOrCreatePool(REQUEST);
      expect(result).toEqual({ mode: 'slotted', sharedRideId: 'open-pool' });
      expect(redis.eval).toHaveBeenCalledTimes(2);
    });

    it('opens new pool if ALL candidates return Lua -1', async () => {
      const p = pool({ rideId: 'full-pool', seatCount: 3, maxSeats: 3 });
      const { svc, repo, redis } = makeService([p], 0.9, -1);
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledTimes(1);
    });
  });
});
