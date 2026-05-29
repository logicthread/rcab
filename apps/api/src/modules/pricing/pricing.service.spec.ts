import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { PricingService } from './pricing.service';
import { addMoney, inr, mulMoney, sumMoney, type Money } from './money';
import { OsrmUnavailableException } from '../matching/osrm-unavailable.exception';

function buildHttp(impl: (url: string) => unknown) {
  return {
    get: vi.fn().mockImplementation((url: string) => of(impl(url))),
  } as unknown as Parameters<typeof makeService>[0];
}

function buildRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
  } as unknown as Parameters<typeof makeService>[1];
}

function buildConfig(overrides: Record<string, number | string> = {}) {
  return {
    get: vi.fn((k: string) => overrides[k]),
  } as unknown as Parameters<typeof makeService>[2];
}

function makeService(http: unknown, redis: unknown, config: unknown): PricingService {
  return new PricingService(http as never, redis as never, config as never);
}

function defaultOsrmResponse(distanceM: number, durationS: number) {
  return { data: { code: 'Ok', routes: [{ distance: distanceM, duration: durationS }] } };
}

describe('PricingService — money helpers', () => {
  it('inr() rounds to integer paise and stamps currency=INR', () => {
    expect(inr(123.4)).toEqual({ amount: 123, currency: 'INR' });
    expect(inr(0)).toEqual({ amount: 0, currency: 'INR' });
  });

  it('inr() rejects non-finite values', () => {
    expect(() => inr(NaN)).toThrow(/non-finite/);
    expect(() => inr(Infinity)).toThrow(/non-finite/);
  });

  it('addMoney() sums amounts, requires same currency', () => {
    expect(addMoney(inr(100), inr(50))).toEqual({ amount: 150, currency: 'INR' });
  });

  it('sumMoney() handles empty + non-empty', () => {
    expect(sumMoney([])).toEqual({ amount: 0, currency: 'INR' });
    expect(sumMoney([inr(10), inr(20), inr(30)])).toEqual({ amount: 60, currency: 'INR' });
  });

  it('mulMoney() rounds the product', () => {
    expect(mulMoney(inr(100), 0.7)).toEqual({ amount: 70, currency: 'INR' });
    expect(mulMoney(inr(100), 0.555)).toEqual({ amount: 56, currency: 'INR' }); // 55.5 → 56
  });
});

describe('PricingService — quoteSoloFromMetrics', () => {
  it('uses defaults: base 4000 + 1500/km + 200/min', () => {
    const svc = makeService(
      buildHttp(() => null),
      buildRedis(),
      buildConfig(),
    );
    // 10 km @ 1500/km = 15000; 30 min @ 200 = 6000; +base 4000 = 25000 (₹250).
    const m: Money = svc.quoteSoloFromMetrics({ distanceM: 10_000, durationS: 1800 });
    expect(m).toEqual({ amount: 25_000, currency: 'INR' });
  });

  it('respects config overrides', () => {
    const svc = makeService(
      buildHttp(() => null),
      buildRedis(),
      buildConfig({
        FARE_BASE_CENTS: 5000,
        FARE_PER_KM_CENTS: 1000,
        FARE_PER_MIN_CENTS: 100,
      }),
    );
    // 5 km @ 1000 = 5000; 10 min @ 100 = 1000; +5000 = 11000.
    const m = svc.quoteSoloFromMetrics({ distanceM: 5_000, durationS: 600 });
    expect(m).toEqual({ amount: 11_000, currency: 'INR' });
  });
});

describe('PricingService — quoteSeatFromMetrics (clamp formula)', () => {
  let svc: PricingService;
  beforeEach(() => {
    svc = makeService(
      buildHttp(() => null),
      buildRedis(),
      buildConfig(),
    );
  });

  it('2-seat ≤ 70% of solo when detour factor = 1.0', () => {
    const solo = inr(10_000);
    const q = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 2,
      directDistanceM: 10_000,
      poolDistanceM: 10_000,
    });
    expect(q.seatMultiplier).toBe(0.7);
    expect(q.detourFactor).toBe(1.0);
    expect(q.perSeatPrice.amount).toBe(7_000);
    expect(q.perSeatPrice.amount).toBeLessThanOrEqual(solo.amount * 0.7);
  });

  it('3-seat ≤ 55% of solo when detour factor = 1.0', () => {
    const solo = inr(10_000);
    const q = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 3,
      directDistanceM: 10_000,
      poolDistanceM: 10_000,
    });
    expect(q.seatMultiplier).toBe(0.55);
    expect(q.detourFactor).toBe(1.0);
    expect(q.perSeatPrice.amount).toBe(5_500);
    expect(q.perSeatPrice.amount).toBeLessThanOrEqual(solo.amount * 0.55);
  });

  it('detour > 1.3 increases per-seat price proportionally', () => {
    const solo = inr(10_000);
    const baseline = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 2,
      directDistanceM: 10_000,
      poolDistanceM: 10_000,
    });
    const detoured = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 2,
      directDistanceM: 10_000,
      poolDistanceM: 13_000, // 1.3× detour
    });
    expect(detoured.detourFactor).toBeCloseTo(1.3, 5);
    expect(detoured.perSeatPrice.amount).toBeGreaterThan(baseline.perSeatPrice.amount);
    // 10_000 × 0.70 × 1.3 = 9_100
    expect(detoured.perSeatPrice.amount).toBe(9_100);
  });

  it('cap: detour can never push seat price above solo', () => {
    const solo = inr(10_000);
    // huge detour 5x — must clamp to 1/0.70 ≈ 1.4286 so seat ≤ solo
    const q = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 2,
      directDistanceM: 10_000,
      poolDistanceM: 50_000,
    });
    expect(q.detourFactor).toBeCloseTo(1 / 0.7, 5);
    expect(q.perSeatPrice.amount).toBeLessThanOrEqual(solo.amount);
    // 10_000 × 0.70 × (1/0.70) = 10_000
    expect(q.perSeatPrice.amount).toBe(10_000);
  });

  it('detour < 1.0 is clamped to 1.0 (pool can never be cheaper via shorter route)', () => {
    const solo = inr(10_000);
    const q = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 2,
      directDistanceM: 10_000,
      poolDistanceM: 5_000,
    });
    expect(q.detourFactor).toBe(1.0);
    expect(q.perSeatPrice.amount).toBe(7_000);
  });

  it('direct distance = 0 defaults detour factor to 1.0 (defensive)', () => {
    const solo = inr(10_000);
    const q = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 3,
      directDistanceM: 0,
      poolDistanceM: 10_000,
    });
    expect(q.detourFactor).toBe(1.0);
    expect(q.perSeatPrice.amount).toBe(5_500);
  });

  it('seatCount = 1 (solo path) has multiplier 1.0', () => {
    const solo = inr(10_000);
    const q = svc.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 1,
      directDistanceM: 10_000,
      poolDistanceM: 10_000,
    });
    expect(q.seatMultiplier).toBe(1.0);
    expect(q.perSeatPrice.amount).toBe(10_000);
  });

  it('honours SEAT_MULTIPLIER config overrides', () => {
    const cfg = buildConfig({ SEAT_MULTIPLIER_2: 0.6, SEAT_MULTIPLIER_3: 0.4 });
    const svc2 = makeService(
      buildHttp(() => null),
      buildRedis(),
      cfg,
    );
    const solo = inr(10_000);
    const q2 = svc2.quoteSeatFromMetrics({
      soloPrice: solo,
      seatCount: 2,
      directDistanceM: 10_000,
      poolDistanceM: 10_000,
    });
    expect(q2.seatMultiplier).toBe(0.6);
    expect(q2.perSeatPrice.amount).toBe(6_000);
  });
});

describe('PricingService — driverPayout', () => {
  it('returns sum × (1 − commission) using default 20%', () => {
    const svc = makeService(
      buildHttp(() => null),
      buildRedis(),
      buildConfig(),
    );
    // 3 seats × 5500 = 16500; × 0.80 = 13200.
    expect(svc.driverPayout([inr(5_500), inr(5_500), inr(5_500)])).toEqual({
      amount: 13_200,
      currency: 'INR',
    });
  });

  it('respects PLATFORM_COMMISSION_RATE override', () => {
    const svc = makeService(
      buildHttp(() => null),
      buildRedis(),
      buildConfig({ PLATFORM_COMMISSION_RATE: 0.1 }),
    );
    expect(svc.driverPayout([inr(10_000)])).toEqual({ amount: 9_000, currency: 'INR' });
  });

  it('empty input → zero', () => {
    const svc = makeService(
      buildHttp(() => null),
      buildRedis(),
      buildConfig(),
    );
    expect(svc.driverPayout([])).toEqual({ amount: 0, currency: 'INR' });
  });
});

describe('PricingService — OSRM-backed methods', () => {
  const ROUTE = { originLat: 22.57, originLng: 88.36, destLat: 22.58, destLng: 88.37 } as const;

  it('quoteSolo() returns fare + distance + duration from OSRM', async () => {
    const http = buildHttp(() => defaultOsrmResponse(10_000, 1800));
    const svc = makeService(http, buildRedis(), buildConfig());
    const q = await svc.quoteSolo(ROUTE);
    expect(q.distanceM).toBe(10_000);
    expect(q.durationS).toBe(1800);
    expect(q.fare).toEqual({ amount: 25_000, currency: 'INR' });
  });

  it('quoteSolo() caches OSRM metrics in Redis (1h TTL)', async () => {
    const http = buildHttp(() => defaultOsrmResponse(5_000, 600));
    const redis = buildRedis() as unknown as {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    const svc = makeService(http, redis, buildConfig());

    await svc.quoteSolo(ROUTE);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^pricing:dist:/),
      JSON.stringify({ distanceM: 5_000, durationS: 600 }),
      'EX',
      3600,
    );

    // Second call hits cache, no second OSRM request.
    const httpGet = (http as unknown as { get: ReturnType<typeof vi.fn> }).get;
    httpGet.mockClear();
    await svc.quoteSolo(ROUTE);
    expect(httpGet).not.toHaveBeenCalled();
  });

  it('quoteSolo() throws OsrmUnavailableException on transport error', async () => {
    const http = {
      get: vi.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED'))),
    };
    const svc = makeService(http, buildRedis(), buildConfig());
    await expect(svc.quoteSolo(ROUTE)).rejects.toBeInstanceOf(OsrmUnavailableException);
  });

  it('quoteSeat() composes direct + pool OSRM calls and applies clamp', async () => {
    const http = {
      get: vi.fn().mockImplementation((url: string) => {
        // crude: pool route is the second one in the controller flow,
        // so disambiguate by which lat appears in the URL.
        const isPool = url.includes('22.6');
        return of(defaultOsrmResponse(isPool ? 13_000 : 10_000, 1800));
      }),
    };
    const svc = makeService(http, buildRedis(), buildConfig());
    const seat = await svc.quoteSeat(
      {
        rideId: 'r',
        seatCount: 2,
        maxSeats: 3,
        originLat: 22.6,
        originLng: 88.4,
        destLat: 22.61,
        destLng: 88.41,
      },
      { route: ROUTE },
    );
    expect(seat.seatMultiplier).toBe(0.7);
    expect(seat.detourFactor).toBeCloseTo(1.3, 5);
    expect(seat.perSeatPrice.amount).toBe(Math.round(25_000 * 0.7 * 1.3));
  });
});
