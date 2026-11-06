import { Inject, Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { getNumber } from '../../common/utils/env';
import { firstValueFrom } from 'rxjs';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { OsrmUnavailableException } from '../matching/osrm-unavailable.exception';
import { inr, mulMoney, sumMoney, type Money } from './money';
import { SHARED_FARE_POLICY } from './shared-fare-policy';
import type {
  RouteMetrics,
  RouteSpec,
  SeatFareContext,
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
  routes: Array<{
    distance: number;
    duration: number;
    legs?: Array<{ distance: number; duration: number }>;
  }>;
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
  /**
   * Bound on one OSRM call. Seat pricing runs INSIDE the join transaction
   * (holding the pool row lock), so an unbounded routing call would stall every
   * other joiner of that pool.
   */
  private readonly osrmTimeoutMs: number;

  constructor(
    private readonly http: HttpService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.osrmBase =
      config.get<string>('OSRM_BASE_URL') ?? config.get<string>('OSRM_URL') ?? 'http://osrm:5000';

    this.osrmTimeoutMs = getNumber(config, 'PRICING_OSRM_TIMEOUT_MS', 3000, {
      integer: true,
      min: 1,
    });

    this.fare = {
      baseCents: getNumber(config, 'FARE_BASE_CENTS', 4000, { min: 0 }),
      perKmCents: getNumber(config, 'FARE_PER_KM_CENTS', 1500, { min: 0 }),
      perMinCents: getNumber(config, 'FARE_PER_MIN_CENTS', 200, { min: 0 }),
    };

    this.shared = {
      seatMultiplier2: getNumber(config, 'SEAT_MULTIPLIER_2', 0.7, { min: 0.01, max: 1 }),
      seatMultiplier3: getNumber(config, 'SEAT_MULTIPLIER_3', 0.55, { min: 0.01, max: 1 }),
      commissionRate: getNumber(config, 'PLATFORM_COMMISSION_RATE', 0.2, { min: 0, max: 1 }),
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
    return { perSeatPrice, seatMultiplier, detourFactor, policy: SHARED_FARE_POLICY };
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

  /**
   * Fare for one seat under the Phase-0 stand-in policy (SHARED_FARE_POLICY).
   * Detour is the passenger's own ride along the ACTUAL ordered itinerary: the
   * routed distance from this passenger's pickup stop, through every
   * intermediate stop, to their dropoff stop, divided by their direct routed
   * distance. (Previously: pool endpoints route vs direct, which ignored the
   * stops the passenger actually rides through.) Throws on any routing failure;
   * it never yields an absent price.
   */
  async quoteSeatInItinerary(ctx: SeatFareContext): Promise<SeatQuote> {
    const pickupIdx = ctx.stops.findIndex(
      (s) => s.type === 'pickup' && s.passengerId === ctx.passengerId,
    );
    const dropoffIdx = ctx.stops.findIndex(
      (s) => s.type === 'dropoff' && s.passengerId === ctx.passengerId,
    );
    if (pickupIdx < 0 || dropoffIdx <= pickupIdx) {
      throw new Error(
        `quoteSeatInItinerary: passenger ${ctx.passengerId} needs a pickup before a dropoff in the itinerary`,
      );
    }
    const direct = await this.getRouteMetrics(ctx.directRoute);
    let rideDistanceM = direct.distanceM;
    // A one-passenger itinerary IS the direct route; otherwise route the legs.
    if (ctx.stops.length > 2) {
      const legs = await this.getItineraryLegs(ctx.stops);
      rideDistanceM = legs
        .slice(pickupIdx, dropoffIdx)
        .reduce((sum, leg) => sum + leg.distanceM, 0);
    }
    return this.quoteSeatFromMetrics({
      soloPrice: this.quoteSoloFromMetrics(direct),
      seatCount: ctx.seatCount,
      directDistanceM: direct.distanceM,
      poolDistanceM: rideDistanceM,
    });
  }

  /**
   * Routed distance/duration of each consecutive leg of an ordered stop list
   * (one OSRM call). Malformed or missing legs are an OsrmUnavailableException,
   * never a partial price.
   */
  async getItineraryLegs(stops: ReadonlyArray<{ lat: number; lng: number }>): Promise<RouteMetrics[]> {
    if (stops.length < 2) return [];
    const coords = stops.map((s) => `${s.lng},${s.lat}`).join(';');
    const url = `${this.osrmBase}/route/v1/driving/${coords}?overview=false`;
    try {
      const { data } = await firstValueFrom(
        this.http.get<OsrmRouteResponse>(url, { timeout: this.osrmTimeoutMs }),
      );
      const legs = data.routes?.[0]?.legs;
      if (data.code !== 'Ok' || !Array.isArray(legs) || legs.length !== stops.length - 1) {
        throw new Error(`unexpected OSRM itinerary response (code=${String(data.code)})`);
      }
      return legs.map((leg) => {
        if (!Number.isFinite(leg.distance) || leg.distance < 0 || !Number.isFinite(leg.duration)) {
          throw new Error('non-finite OSRM leg');
        }
        return { distanceM: leg.distance, durationS: leg.duration };
      });
    } catch (err) {
      this.log.warn({ err, url }, 'OSRM unreachable for itinerary pricing');
      throw new OsrmUnavailableException();
    }
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
      const { data } = await firstValueFrom(
        this.http.get<OsrmRouteResponse>(url, { timeout: this.osrmTimeoutMs }),
      );
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
