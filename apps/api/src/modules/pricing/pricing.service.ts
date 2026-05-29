import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { OsrmUnavailableException } from '../matching/osrm-unavailable.exception';
import { inr, mulMoney, sumMoney, type Money } from './money';
import type {
  PoolForPricing,
  RouteMetrics,
  RouteSpec,
  SeatContext,
  SeatQuote,
  SoloQuote,
} from './pricing.types';

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function geohash7(lat: number, lng: number): string {
  let idx = 0,
    bit = 0,
    even = true,
    hash = '';
  let latMin = -90,
    latMax = 90,
    lngMin = -180,
    lngMax = 180;
  while (hash.length < 7) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        idx = (idx << 1) | 1;
        lngMin = mid;
      } else {
        idx <<= 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = (idx << 1) | 1;
        latMin = mid;
      } else {
        idx <<= 1;
        latMax = mid;
      }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

interface OsrmRouteResponse {
  code: string;
  routes: Array<{ distance: number; duration: number }>;
}

interface FareParams {
  baseCents: number;
  perKmCents: number;
  perMinCents: number;
}

interface SharedParams {
  seatMultiplier2: number;
  seatMultiplier3: number;
  commissionRate: number;
}

@Injectable()
export class PricingService {
  private readonly log = new Logger(PricingService.name);
  private readonly osrmBase: string;
  private readonly fare: FareParams;
  private readonly shared: SharedParams;

  constructor(
    private readonly http: HttpService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.osrmBase =
      config.get<string>('OSRM_BASE_URL') ?? config.get<string>('OSRM_URL') ?? 'http://osrm:5000';

    this.fare = {
      baseCents: config.get<number>('FARE_BASE_CENTS') ?? 4000,
      perKmCents: config.get<number>('FARE_PER_KM_CENTS') ?? 1500,
      perMinCents: config.get<number>('FARE_PER_MIN_CENTS') ?? 200,
    };

    this.shared = {
      seatMultiplier2: config.get<number>('SEAT_MULTIPLIER_2') ?? 0.7,
      seatMultiplier3: config.get<number>('SEAT_MULTIPLIER_3') ?? 0.55,
      commissionRate: config.get<number>('PLATFORM_COMMISSION_RATE') ?? 0.2,
    };
  }

  // ── Pure helpers (testable without OSRM) ───────────────────────────────────

  quoteSoloFromMetrics(metrics: RouteMetrics): Money {
    const km = metrics.distanceM / 1000;
    const min = metrics.durationS / 60;
    return inr(this.fare.baseCents + this.fare.perKmCents * km + this.fare.perMinCents * min);
  }

  /**
   * Seat price = solo × seatMultiplier × clamp(detourFactor, 1.0, 1.0/seatMultiplier).
   * - detour ≤ 1.0 means no detour penalty (factor pinned to 1.0).
   * - detour > 1.0 scales price up but is capped so the seat never costs more than solo.
   */
  quoteSeatFromMetrics(input: {
    soloPrice: Money;
    seatCount: number;
    directDistanceM: number;
    poolDistanceM: number;
  }): SeatQuote {
    const seatMultiplier = this.seatMultiplierFor(input.seatCount);
    const rawDetour = input.directDistanceM > 0 ? input.poolDistanceM / input.directDistanceM : 1.0;
    const cap = 1.0 / seatMultiplier;
    const detourFactor = clamp(rawDetour, 1.0, cap);
    const perSeatPrice = mulMoney(input.soloPrice, seatMultiplier * detourFactor);
    return { perSeatPrice, seatMultiplier, detourFactor };
  }

  driverPayout(seatPrices: Money[]): Money {
    const gross = sumMoney(seatPrices);
    return mulMoney(gross, 1 - this.shared.commissionRate);
  }

  seatMultiplierFor(seatCount: number): number {
    if (seatCount <= 1) return 1.0;
    if (seatCount === 2) return this.shared.seatMultiplier2;
    return this.shared.seatMultiplier3;
  }

  // ── I/O helpers (call OSRM) ────────────────────────────────────────────────

  async quoteSolo(route: RouteSpec): Promise<SoloQuote> {
    const metrics = await this.getRouteMetrics(route);
    return { fare: this.quoteSoloFromMetrics(metrics), ...metrics };
  }

  async quoteSeat(pool: PoolForPricing, seat: SeatContext): Promise<SeatQuote> {
    const [direct, poolMetrics] = await Promise.all([
      this.getRouteMetrics(seat.route),
      this.getRouteMetrics({
        originLat: pool.originLat,
        originLng: pool.originLng,
        destLat: pool.destLat,
        destLng: pool.destLng,
      }),
    ]);
    const soloPrice = this.quoteSoloFromMetrics(direct);
    return this.quoteSeatFromMetrics({
      soloPrice,
      seatCount: pool.seatCount,
      directDistanceM: direct.distanceM,
      poolDistanceM: poolMetrics.distanceM,
    });
  }

  async getRouteMetrics(route: RouteSpec): Promise<RouteMetrics> {
    const key =
      `pricing:dist:${geohash7(route.originLat, route.originLng)}:` +
      `${geohash7(route.destLat, route.destLng)}`;
    const cached = await this.redis.get(key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as RouteMetrics;
      } catch {
        // fall through and refetch
      }
    }

    const url =
      `${this.osrmBase}/route/v1/driving/` +
      `${route.originLng},${route.originLat};${route.destLng},${route.destLat}` +
      `?overview=false`;

    let distanceM: number, durationS: number;
    try {
      const { data } = await firstValueFrom(this.http.get<OsrmRouteResponse>(url));
      distanceM = data.routes[0].distance;
      durationS = data.routes[0].duration;
    } catch (err) {
      this.log.warn({ err, url }, 'OSRM unreachable for pricing');
      throw new OsrmUnavailableException();
    }

    const metrics: RouteMetrics = { distanceM, durationS };
    await this.redis.set(key, JSON.stringify(metrics), 'EX', 3600);
    return metrics;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
