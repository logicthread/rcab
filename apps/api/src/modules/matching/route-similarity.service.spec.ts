import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { AxiosError } from 'axios';
import { RouteSimilarityService, type RouteInput } from './route-similarity.service';
import { OsrmUnavailableException } from './osrm-unavailable.exception';

// ── Mocks ─────────────────────────────────────────────────────────────────────

function buildRedis() {
  return {
    get: vi.fn().mockResolvedValue(null) as ReturnType<typeof vi.fn> & ((key: string) => Promise<string | null>),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

function buildHttp(coords: [number, number][][]) {
  const get = vi.fn();
  for (const c of coords) {
    get.mockReturnValueOnce(of({ data: { routes: [{ geometry: { coordinates: c } }] } }));
  }
  return { get };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn((key: string) => overrides[key] ?? undefined),
  };
}

function makeService(
  redis: ReturnType<typeof buildRedis>,
  http: ReturnType<typeof buildHttp>,
  configOverrides: Record<string, unknown> = {},
) {
  return new RouteSimilarityService(
    redis as never,
    http as never,
    buildConfig(configOverrides) as never,
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Kolkata corridor: ~500m stretch along the same east-west street
const CORRIDOR: [number, number][] = Array.from({ length: 10 }, (_, i) => [88.36 + i * 0.0005, 22.57]);

// Two routes far apart: ~111 km north (1 degree lat)
const CORRIDOR_FAR: [number, number][] = Array.from({ length: 10 }, (_, i) => [88.36 + i * 0.0005, 23.57]);

const ROUTE_A: RouteInput = { originLat: 22.57, originLng: 88.36, destLat: 22.57, destLng: 88.364 };
const ROUTE_B_SAME: RouteInput = { originLat: 22.57, originLng: 88.3601, destLat: 22.57, destLng: 88.3641 };
const ROUTE_B_FAR: RouteInput = { originLat: 23.57, originLng: 88.36, destLat: 23.57, destLng: 88.364 };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RouteSimilarityService', () => {
  let redis: ReturnType<typeof buildRedis>;

  beforeEach(() => {
    redis = buildRedis();
  });

  describe('scoreRoutes — formula', () => {
    it('returns ≥ 0.8 when both routes share the same corridor', async () => {
      const http = buildHttp([CORRIDOR, CORRIDOR]);
      const svc = makeService(redis, http);
      const score = await svc.scoreRoutes(ROUTE_A, ROUTE_B_SAME);
      expect(score).toBeGreaterThanOrEqual(0.8);
    });

    it('returns ≤ 0.2 when routes are ~111 km apart', async () => {
      const http = buildHttp([CORRIDOR, CORRIDOR_FAR]);
      const svc = makeService(redis, http);
      const score = await svc.scoreRoutes(ROUTE_A, ROUTE_B_FAR);
      expect(score).toBeLessThanOrEqual(0.2);
    });

    it('clamps to 0 for d̄ beyond saturation distance', async () => {
      // Use 100 m saturation so even a modest distance returns 0
      const http = buildHttp([CORRIDOR, CORRIDOR_FAR]);
      const svc = makeService(redis, http, { ROUTE_SIMILARITY_SATURATION_M: 100 });
      const score = await svc.scoreRoutes(ROUTE_A, ROUTE_B_FAR);
      expect(score).toBe(0);
    });
  });

  describe('scoreRoutes — caching', () => {
    it('calls OSRM once and writes to Redis on first call', async () => {
      const http = buildHttp([CORRIDOR, CORRIDOR]);
      const svc = makeService(redis, http);
      await svc.scoreRoutes(ROUTE_A, ROUTE_B_SAME);
      expect(http.get).toHaveBeenCalledTimes(2); // one per route
      expect(redis.set).toHaveBeenCalledTimes(2);
      const [key, , exFlag, ttl] = redis.set.mock.calls[0];
      expect(key).toMatch(/^osrm:poly:[a-z0-9]{7}:[a-z0-9]{7}$/);
      expect(exFlag).toBe('EX');
      expect(ttl).toBe(3600);
    });

    it('returns cached polyline on second call without HTTP', async () => {
      const serialised = JSON.stringify(CORRIDOR);
      redis.get.mockResolvedValue(serialised);
      const http = buildHttp([]);
      const svc = makeService(redis, http);
      await svc.scoreRoutes(ROUTE_A, ROUTE_B_SAME);
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe('scoreRoutes — error handling', () => {
    it('throws OsrmUnavailableException when OSRM returns an HTTP error', async () => {
      const http = { get: vi.fn().mockReturnValue(throwError(() => new AxiosError('connect EREFUSED'))) };
      const svc = makeService(redis, http as never);
      await expect(svc.scoreRoutes(ROUTE_A, ROUTE_B_SAME)).rejects.toBeInstanceOf(OsrmUnavailableException);
    });

    it('does not cache the polyline when OSRM errors', async () => {
      const http = { get: vi.fn().mockReturnValue(throwError(() => new AxiosError('timeout'))) };
      const svc = makeService(redis, http as never);
      await expect(svc.scoreRoutes(ROUTE_A, ROUTE_B_SAME)).rejects.toBeInstanceOf(OsrmUnavailableException);
      expect(redis.set).not.toHaveBeenCalled();
    });
  });
});
