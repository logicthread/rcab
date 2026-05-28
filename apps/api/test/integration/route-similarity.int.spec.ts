import Redis from 'ioredis';
import { of } from 'rxjs';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { RouteSimilarityService, type RouteInput } from '../../src/modules/matching/route-similarity.service';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// Coordinates: two nearby points in Kolkata
const ROUTE_A: RouteInput = { originLat: 22.5726, originLng: 88.3639, destLat: 22.5760, destLng: 88.3700 };
const ROUTE_B: RouteInput = { originLat: 22.5726, originLng: 88.3640, destLat: 22.5760, destLng: 88.3701 };

// A small GeoJSON polyline fixture representing a short urban segment
const MOCK_COORDS: [number, number][] = [
  [88.3639, 22.5726],
  [88.3660, 22.5740],
  [88.3680, 22.5752],
  [88.3700, 22.5760],
];

describe.skipIf(skip)('RouteSimilarityService — integration (real Redis)', () => {
  let redis: Redis;
  let svc: RouteSimilarityService;
  let httpGet: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    redis = new Redis(process.env.TEST_REDIS_URL!);

    httpGet = vi.fn().mockReturnValue(
      of({ data: { routes: [{ geometry: { coordinates: MOCK_COORDS } }] } }),
    );

    const config = { get: vi.fn((k: string) => (k === 'OSRM_URL' ? 'http://mock-osrm' : undefined)) };
    svc = new RouteSimilarityService(redis as never, { get: httpGet } as never, config as never);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('writes polyline to Redis after first scoreRoutes call', async () => {
    httpGet.mockReturnValue(of({ data: { routes: [{ geometry: { coordinates: MOCK_COORDS } }] } }));
    await svc.scoreRoutes(ROUTE_A, ROUTE_B);

    const keys = await redis.keys('osrm:poly:*');
    expect(keys.length).toBeGreaterThanOrEqual(1);

    const stored = await redis.get(keys[0]);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('returns the same score on second call without issuing HTTP requests', async () => {
    // First call — allow any pending HTTP
    httpGet.mockReturnValue(of({ data: { routes: [{ geometry: { coordinates: MOCK_COORDS } }] } }));
    const score1 = await svc.scoreRoutes(ROUTE_A, ROUTE_B);

    // Reset mock so any new HTTP call would fail
    httpGet.mockReset();
    httpGet.mockImplementation(() => { throw new Error('unexpected HTTP call'); });

    const score2 = await svc.scoreRoutes(ROUTE_A, ROUTE_B);
    expect(score2).toBe(score1);
  });
});
