import { describe, it, expect, vi } from 'vitest';
import { MatchingService, type SharedRideRequest } from './matching.service';
import type { SharedRideRow } from './shared-ride.repository';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Kolkata: two nearby points ~200 m apart
const REQUEST: SharedRideRequest = {
  passengerId: 'p-joiner',
  originLat: 22.5726, originLng: 88.3639,
  destLat:   22.5800, destLng:   88.3700,
};

function pool(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId:            'pool-uuid-1',
    seatCount:         1,
    maxSeats:          3,
    poolState:         'open',
    poolClosedAt:      null,
    detourBudgetM:     800,
    originLat: 22.5727, originLng: 88.3640,
    destLat:   22.5801, destLng:   88.3701,
    members: [{
      passenger_id: 'p-opener',
      origin_lat: 22.5727, origin_lng: 88.3640,
      dest_lat:   22.5801, dest_lng:   88.3701,
      joined_at: '2026-05-29T00:00:00.000Z',
    }],
    claimedByDriverId: null,
    claimedAt:         null,
    ...overrides,
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

function buildRepo(candidates: SharedRideRow[] = []) {
  return {
    findCandidates: vi.fn().mockResolvedValue(candidates),
    create:         vi.fn(),
    incrementSeats: vi.fn(),
    closePool:      vi.fn(),
  };
}

function buildScorer(score: number | number[]) {
  const scores = Array.isArray(score) ? score : [score];
  let i = 0;
  return { scoreRoutes: vi.fn().mockImplementation(() => Promise.resolve(scores[i++ % scores.length])) };
}

interface SlotResultLike { slotted: boolean; closedFull: boolean; seatCount: number }

function buildLifecycle(
  slotResults: SlotResultLike | SlotResultLike[] = { slotted: true, closedFull: false, seatCount: 2 },
  openedPool?: SharedRideRow,
) {
  const results = Array.isArray(slotResults) ? slotResults : [slotResults];
  let i = 0;
  return {
    slotRequest: vi.fn().mockImplementation(() =>
      Promise.resolve(results[Math.min(i++, results.length - 1)]),
    ),
    openPool: vi.fn().mockResolvedValue(openedPool ?? { ...pool(), rideId: 'new-pool-uuid', seatCount: 1 }),
    closePool: vi.fn(),
  };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return { get: vi.fn((key: string) => overrides[key] ?? undefined) };
}

function makeService(opts: {
  candidates?: SharedRideRow[];
  score?: number | number[];
  slot?: SlotResultLike | SlotResultLike[];
  openedPool?: SharedRideRow;
  config?: Record<string, unknown>;
} = {}) {
  const repo      = buildRepo(opts.candidates ?? []);
  const scorer    = buildScorer(opts.score ?? 0.9);
  const lifecycle = buildLifecycle(opts.slot, opts.openedPool);
  const config    = buildConfig(opts.config ?? {});

  const svc = new MatchingService(
    repo as never,
    scorer as never,
    lifecycle as never,
    config as never,
  );
  return { svc, repo, scorer, lifecycle };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MatchingService.findOrCreatePool', () => {
  describe('slot vs. open', () => {
    it('slots into an existing pool when score ≥ 0.7 and detour ≤ 800 m', async () => {
      const { svc, lifecycle } = makeService({
        candidates: [pool()],
        slot: { slotted: true, closedFull: false, seatCount: 2 },
      });
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result).toEqual({ mode: 'slotted', sharedRideId: 'pool-uuid-1', poolStatus: 'open' });
      expect(lifecycle.slotRequest).toHaveBeenCalledTimes(1);
      expect(lifecycle.slotRequest).toHaveBeenCalledWith(expect.objectContaining({
        joiner: expect.objectContaining({ passenger_id: 'p-joiner' }),
      }));
      expect(lifecycle.openPool).not.toHaveBeenCalled();
    });

    it('opens a new pool when similarity is below threshold (< 0.7)', async () => {
      const { svc, lifecycle } = makeService({ candidates: [pool()], score: 0.5 });
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(result.poolStatus).toBe('open');
      expect(lifecycle.openPool).toHaveBeenCalledTimes(1);
      expect(lifecycle.slotRequest).not.toHaveBeenCalled();
    });

    it('opens a new pool when detour exceeds budget', async () => {
      const farPool = pool({ originLat: 22.590, originLng: 88.375 }); // ~2 km away
      const { svc, lifecycle } = makeService({ candidates: [farPool], score: 0.9 });
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(lifecycle.openPool).toHaveBeenCalledTimes(1);
    });

    it('opens a new pool when there are no candidates', async () => {
      const { svc, lifecycle } = makeService();
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(result.sharedRideId).toBe('new-pool-uuid');
      expect(lifecycle.openPool).toHaveBeenCalledWith(expect.objectContaining({
        originLat:     REQUEST.originLat,
        maxSeats:      3,
        detourBudgetM: 800,
        passengerId:   'p-joiner',
      }));
    });
  });

  describe('best-pool selection', () => {
    it('slots into the higher composite-score pool when multiple qualify', async () => {
      const poolA = pool({ rideId: 'pool-a' });
      const poolB = pool({ rideId: 'pool-b', originLat: 22.5740, originLng: 88.3655 });
      const { svc, lifecycle } = makeService({
        candidates: [poolA, poolB],
        score: [0.95, 0.80],
      });
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('slotted');
      expect(result.sharedRideId).toBe('pool-a');
      expect(lifecycle.slotRequest).toHaveBeenCalledWith(expect.objectContaining({
        pool: expect.objectContaining({ rideId: 'pool-a' }),
      }));
    });
  });

  describe('lifecycle handoff', () => {
    it('falls through to next candidate when slotRequest reports unslotted (full)', async () => {
      const poolFull = pool({ rideId: 'full-pool' });
      const poolOpen = pool({ rideId: 'open-pool' });
      const { svc, lifecycle } = makeService({
        candidates: [poolFull, poolOpen],
        score: 0.9,
        slot: [
          { slotted: false, closedFull: false, seatCount: 3 },
          { slotted: true,  closedFull: false, seatCount: 2 },
        ],
      });
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result).toEqual({ mode: 'slotted', sharedRideId: 'open-pool', poolStatus: 'open' });
      expect(lifecycle.slotRequest).toHaveBeenCalledTimes(2);
    });

    it('returns poolStatus=closed_full when the slot filled the pool', async () => {
      const { svc } = makeService({
        candidates: [pool()],
        slot: { slotted: true, closedFull: true, seatCount: 3 },
      });
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result).toEqual({ mode: 'slotted', sharedRideId: 'pool-uuid-1', poolStatus: 'closed_full' });
    });

    it('opens new pool when ALL candidates report unslotted', async () => {
      const { svc, lifecycle } = makeService({
        candidates: [pool({ rideId: 'p-1' })],
        slot: { slotted: false, closedFull: false, seatCount: 3 },
      });
      const result = await svc.findOrCreatePool(REQUEST);

      expect(result.mode).toBe('opened');
      expect(lifecycle.openPool).toHaveBeenCalledTimes(1);
    });
  });
});
