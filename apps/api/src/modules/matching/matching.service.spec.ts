import { buildPolicy } from '../../config/policy/policy';
import { describe, it, expect, vi } from 'vitest';
import { MatchingService, type SharedRideRequest } from './matching.service';
import { PoolOpenRejectedError, type JoinPoolResult } from './pool-lifecycle.service';
import type { SharedRideRow } from './shared-ride.repository';

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Kolkata: two nearby points ~200 m apart
const REQUEST: SharedRideRequest = {
  passengerId: 'p-joiner',
  originLat: 22.5726,
  originLng: 88.3639,
  destLat: 22.58,
  destLng: 88.37,
};

function pool(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId: 'pool-uuid-1',
    seatCount: 1,
    maxSeats: 3,
    poolState: 'open',
    poolClosedAt: null,
    detourBudgetM: 800,
    originLat: 22.5727,
    originLng: 88.364,
    destLat: 22.5801,
    destLng: 88.3701,
    members: [
      {
        passenger_id: 'p-opener',
        origin_lat: 22.5727,
        origin_lng: 88.364,
        dest_lat: 22.5801,
        dest_lng: 88.3701,
        joined_at: '2026-05-29T00:00:00.000Z',
      },
    ],
    claimedByDriverId: null,
    claimedAt: null,
    dispatchGeneration: 0,
    stateVersion: 1,
    ...overrides,
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

function buildScorer(score: number | number[]) {
  const scores = Array.isArray(score) ? score : [score];
  let i = 0;
  return {
    scoreRoutes: vi.fn().mockImplementation(() => Promise.resolve(scores[i++ % scores.length])),
  };
}

function buildLifecycle(
  joinResults: JoinPoolResult | JoinPoolResult[] = {
    joined: true,
    closedFull: false,
    seatCount: 2,
    quote: QUOTE,
  },
  openError?: PoolOpenRejectedError,
) {
  const results = Array.isArray(joinResults) ? joinResults : [joinResults];
  let i = 0;
  return {
    joinPool: vi
      .fn()
      .mockImplementation(() => Promise.resolve(results[Math.min(i++, results.length - 1)])),
    openPool: vi
      .fn()
      .mockImplementation((p: { poolId: string }) =>
        openError
          ? Promise.reject(openError)
          : Promise.resolve({ ...pool({ rideId: p.poolId, seatCount: 1 }), quote: QUOTE }),
      ),
  };
}

function makeService(
  opts: {
    candidates?: SharedRideRow[];
    score?: number | number[];
    join?: JoinPoolResult | JoinPoolResult[];
    open?: PoolOpenRejectedError | Error;
    config?: Record<string, unknown>;
  } = {},
) {
  const repo = { findCandidates: vi.fn().mockResolvedValue(opts.candidates ?? []) };
  const scorer = buildScorer(opts.score ?? 0.9);
  const lifecycle = buildLifecycle(opts.join, opts.open as PoolOpenRejectedError | undefined);
  const members = {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    findSeat: vi.fn().mockResolvedValue(null),
  };
  const config = { get: vi.fn((key: string) => (opts.config ?? {})[key] ?? undefined) };

  const svc = new MatchingService(
    repo as never,
    scorer as never,
    lifecycle as never,
    members as never,
    {} as never,
    buildPolicy(config),
  );
  return { svc, repo, scorer, lifecycle, members };
}

const QUOTE = {
  perSeatPrice: { amount: 9_000, currency: 'INR' as const },
  seatMultiplier: 0.75,
  detourFactor: 1,
  policy: 'fixed_at_join' as const,
};
const OPTS = { quote: vi.fn().mockResolvedValue(QUOTE) };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MatchingService.findOrCreatePool', () => {
  describe('join vs. open', () => {
    it('joins an existing pool when score ≥ 0.7 and detour ≤ 800 m', async () => {
      const { svc, lifecycle } = makeService({ candidates: [pool()] });
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result).toEqual({
        mode: 'slotted',
        sharedRideId: 'pool-uuid-1',
        poolStatus: 'open',
        seatCount: 2,
        quote: QUOTE,
      });
      expect(lifecycle.joinPool).toHaveBeenCalledTimes(1);
      expect(lifecycle.joinPool).toHaveBeenCalledWith(
        expect.objectContaining({
          poolId: 'pool-uuid-1',
          joiner: expect.objectContaining({ passenger_id: 'p-joiner' }),
          quoteFare: OPTS.quote,
          idempotency: undefined,
        }),
      );
      expect(lifecycle.openPool).not.toHaveBeenCalled();
    });

    it('opens a new pool when similarity is below threshold (< 0.7)', async () => {
      const { svc, lifecycle } = makeService({ candidates: [pool()], score: 0.5 });
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result).toMatchObject({ mode: 'opened', poolStatus: 'open', seatCount: 1 });
      expect(lifecycle.openPool).toHaveBeenCalledTimes(1);
      expect(lifecycle.joinPool).not.toHaveBeenCalled();
    });

    it('opens a new pool when detour exceeds budget', async () => {
      const farPool = pool({ originLat: 22.59, originLng: 88.375 }); // ~2 km away
      const { svc, lifecycle } = makeService({ candidates: [farPool], score: 0.9 });
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result.mode).toBe('opened');
      expect(lifecycle.openPool).toHaveBeenCalledTimes(1);
    });

    it('opens a new pool (pre-generated id, configured seats/budget) when there are no candidates', async () => {
      const { svc, lifecycle } = makeService();
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result.mode).toBe('opened');
      const call = lifecycle.openPool.mock.calls[0][0] as { poolId: string };
      expect(result).toMatchObject({ sharedRideId: call.poolId });
      expect(lifecycle.openPool).toHaveBeenCalledWith(
        expect.objectContaining({
          originLat: REQUEST.originLat,
          maxSeats: 3,
          detourBudgetM: 800,
          passengerId: 'p-joiner',
          quoteFare: OPTS.quote,
        }),
      );
    });
  });

  describe('best-pool selection', () => {
    it('joins the higher composite-score pool when multiple qualify', async () => {
      const poolA = pool({ rideId: 'pool-a' });
      const poolB = pool({ rideId: 'pool-b', originLat: 22.574, originLng: 88.3655 });
      const { svc, lifecycle } = makeService({ candidates: [poolA, poolB], score: [0.95, 0.8] });
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result).toMatchObject({ mode: 'slotted', sharedRideId: 'pool-a' });
      expect(lifecycle.joinPool).toHaveBeenCalledWith(
        expect.objectContaining({ poolId: 'pool-a' }),
      );
    });
  });

  describe('transactional join outcomes (advisory candidates)', () => {
    it.each(['pool_full', 'pool_closed', 'not_found', 'conflict'] as const)(
      'skips a stale candidate that reports %s and tries the next one',
      async (reason) => {
        const { svc, lifecycle } = makeService({
          candidates: [pool({ rideId: 'stale' }), pool({ rideId: 'fresh' })],
          join: [
            { joined: false, reason },
            { joined: true, closedFull: false, seatCount: 2, quote: QUOTE },
          ],
        });
        const result = await svc.findOrCreatePool(REQUEST, OPTS);

        expect(result).toMatchObject({ mode: 'slotted', sharedRideId: 'fresh' });
        expect(lifecycle.joinPool).toHaveBeenCalledTimes(2);
      },
    );

    it('returns poolStatus=closed_full when the join filled the pool', async () => {
      const { svc } = makeService({
        candidates: [pool()],
        join: { joined: true, closedFull: true, seatCount: 3, quote: QUOTE },
      });
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result).toMatchObject({ mode: 'slotted', poolStatus: 'closed_full', seatCount: 3 });
    });

    it('opens a new pool when ALL candidates reject', async () => {
      const { svc, lifecycle } = makeService({
        candidates: [pool({ rideId: 'p-1' })],
        join: { joined: false, reason: 'pool_full' },
      });
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result.mode).toBe('opened');
      expect(lifecycle.openPool).toHaveBeenCalledTimes(1);
    });

    it.each(['already_member', 'idempotent_replay'] as const)(
      'returns the existing seat on %s without opening a pool',
      async (reason) => {
        const { svc, lifecycle } = makeService({
          candidates: [pool({ rideId: 'mine' })],
          join: { joined: false, reason, existingPoolId: 'mine' },
        });
        const result = await svc.findOrCreatePool(REQUEST, OPTS);

        expect(result).toEqual({ mode: 'existing', reason, sharedRideId: 'mine' });
        expect(lifecycle.openPool).not.toHaveBeenCalled();
      },
    );

    it('returns a typed conflict when the passenger holds a seat in another live pool', async () => {
      const { svc, lifecycle } = makeService({
        candidates: [pool()],
        join: { joined: false, reason: 'passenger_has_active_pool', existingPoolId: 'other' },
      });
      const result = await svc.findOrCreatePool(REQUEST, OPTS);

      expect(result).toEqual({
        mode: 'conflict',
        reason: 'passenger_has_active_pool',
        existingPoolId: 'other',
      });
      expect(lifecycle.openPool).not.toHaveBeenCalled();
    });

    it('maps an openPool rejection to existing / conflict', async () => {
      const replay = makeService({ open: new PoolOpenRejectedError('idempotent_replay', 'p-old') });
      expect(await replay.svc.findOrCreatePool(REQUEST, OPTS)).toEqual({
        mode: 'existing',
        reason: 'idempotent_replay',
        sharedRideId: 'p-old',
      });

      const busy = makeService({
        open: new PoolOpenRejectedError('passenger_has_active_pool', 'p-x'),
      });
      expect(await busy.svc.findOrCreatePool(REQUEST, OPTS)).toEqual({
        mode: 'conflict',
        reason: 'passenger_has_active_pool',
        existingPoolId: 'p-x',
      });

      const conflict = makeService({ open: new PoolOpenRejectedError('conflict') });
      expect(await conflict.svc.findOrCreatePool(REQUEST, OPTS)).toMatchObject({
        mode: 'conflict',
        reason: 'conflict',
      });

      // A replay without a pool id cannot be resolved here → conflict.
      const odd = makeService({ open: new PoolOpenRejectedError('idempotent_replay') });
      expect(await odd.svc.findOrCreatePool(REQUEST, OPTS)).toMatchObject({ mode: 'conflict' });
    });

    it('propagates unexpected openPool errors', async () => {
      const { svc } = makeService({ open: new Error('db down') });
      await expect(svc.findOrCreatePool(REQUEST, OPTS)).rejects.toThrow('db down');
    });
  });

  describe('quote + idempotency handoff', () => {
    it('hands the quoter to the seat transaction (priced there, not here) and returns its quote', async () => {
      const { svc, lifecycle } = makeService({ candidates: [pool({ seatCount: 2 })] });
      const quote = vi.fn().mockResolvedValue(QUOTE);
      const result = await svc.findOrCreatePool(REQUEST, { quote });

      // MatchingService never prices outside the transaction.
      expect(quote).not.toHaveBeenCalled();
      expect(lifecycle.joinPool).toHaveBeenCalledWith(expect.objectContaining({ quoteFare: quote }));
      expect(result).toMatchObject({ quote: QUOTE });
    });

    it('opens a new pool with the same quoter and returns the opener quote', async () => {
      const { svc, lifecycle } = makeService();
      const quote = vi.fn().mockResolvedValue(QUOTE);
      const result = await svc.findOrCreatePool(REQUEST, { quote });

      expect(lifecycle.openPool).toHaveBeenCalledWith(expect.objectContaining({ quoteFare: quote }));
      expect(result).toMatchObject({ mode: 'opened', quote: QUOTE });
    });

    it('a pricing failure inside the seat transaction propagates (no seat, no price-less success)', async () => {
      const { svc, lifecycle } = makeService({ candidates: [pool()] });
      lifecycle.joinPool.mockRejectedValueOnce(new Error('routing_unavailable'));
      await expect(svc.findOrCreatePool(REQUEST, OPTS)).rejects.toThrow('routing_unavailable');
      expect(lifecycle.openPool).not.toHaveBeenCalled();
    });

    it('passes the idempotency scope and response builder through to the seat transaction', async () => {
      const { svc, lifecycle } = makeService({ candidates: [pool()] });
      const scope = {
        principalId: 'p-joiner',
        operation: 'ride.create.shared' as const,
        key: 'k1',
      };
      const response = vi.fn().mockReturnValue({ stored: true });
      const idempotency = { scope, response };
      await svc.findOrCreatePool(REQUEST, { quote: OPTS.quote, idempotency });

      const passed = lifecycle.joinPool.mock.calls[0][0] as { idempotency: typeof idempotency };
      expect(passed.idempotency.scope).toBe(scope);
      expect(passed.idempotency.response).toBe(response);
    });
  });

  describe('seat lookups', () => {
    it('delegates exact seat lookups to the membership repository', async () => {
      const { svc, members } = makeService();
      await svc.findSeatByIdempotencyKey('p1', 'k1');
      await svc.findSeat('pool-1', 'p1');
      expect(members.findByIdempotencyKey).toHaveBeenCalledWith({}, 'p1', 'k1');
      expect(members.findSeat).toHaveBeenCalledWith({}, 'pool-1', 'p1');
    });
  });
});
