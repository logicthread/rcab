import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { getNumber } from '../../common/utils/env';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import type { SeatFareQuoter, SeatQuote } from '../pricing/pricing.types';
import { RouteSimilarityService, type RouteInput } from './route-similarity.service';
import { SharedRideRepository, type SharedRideRow } from './shared-ride.repository';
import { PoolMembershipRepository, type SeatLookup } from './pool-membership.repository';
import {
  PoolLifecycleService,
  PoolOpenRejectedError,
  type SeatIdempotency,
  type SeatOutcome,
} from './pool-lifecycle.service';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SharedRideRequest {
  passengerId: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

/** A seat committed by THIS call, with the fare agreed (and stored) on it. */
export type SeatMatch = SeatOutcome;

export type MatchResult =
  | SeatMatch
  /**
   * The passenger already holds the seat this request is asking for: a keyless
   * duplicate in the same pool (`already_member`) or the same idempotency key
   * (`idempotent_replay`). Nothing was written.
   */
  | { mode: 'existing'; reason: 'already_member' | 'idempotent_replay'; sharedRideId: string }
  /** Nothing was written; the controller answers 409. */
  | {
      mode: 'conflict';
      reason: 'passenger_has_active_pool' | 'conflict';
      existingPoolId?: string;
    };

export interface FindOrCreateOptions {
  /**
   * Prices the seat INSIDE the seat transaction from the locked pool state
   * (SHARED_FARE_POLICY = fixed_at_join). Persisted as `agreed_fare_cents`.
   * Must throw when the fare cannot be determined: the seat is then not
   * committed and the error propagates (no seat without a price).
   */
  quote: SeatFareQuoter;
  /** Shared-create idempotency, completed inside the seat transaction. */
  idempotency?: {
    scope: SeatIdempotency['scope'];
    response: (match: SeatMatch) => unknown;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Coord = [number, number]; // [lng, lat]

function haversineM([lng1, lat1]: Coord, [lng2, lat2]: Coord): number {
  const R = 6_371_000;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLam = ((lng2 - lng1) * Math.PI) / 180;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class MatchingService {
  private readonly similarityThreshold: number;
  private readonly detourBudgetM: number;
  private readonly maxSeats: number;

  constructor(
    private readonly repo: SharedRideRepository,
    private readonly scorer: RouteSimilarityService,
    private readonly lifecycle: PoolLifecycleService,
    private readonly members: PoolMembershipRepository,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.similarityThreshold = getNumber(config, 'MATCHING_SIMILARITY_THRESHOLD', 0.7, { min: 0, max: 1 });
    this.detourBudgetM       = getNumber(config, 'MATCHING_DETOUR_BUDGET_M', 800, { min: 0 });
    this.maxSeats            = getNumber(config, 'MATCHING_MAX_SEATS', 3, { integer: true, min: 1 });
  }

  /**
   * Candidate discovery + route scoring are ADVISORY (no lock, OSRM). Each
   * qualified candidate is then tried with `joinPool`, which re-validates
   * state and capacity under the pool row lock; a pool that filled or closed
   * since it was scored is skipped. Only when no candidate accepts is a new
   * pool opened.
   */
  async findOrCreatePool(
    request: SharedRideRequest,
    opts: FindOrCreateOptions,
  ): Promise<MatchResult> {
    const candidates = await this.repo.findCandidates(
      request.originLat, request.originLng,
      request.destLat,   request.destLng,
    );

    const reqRoute: RouteInput = {
      originLat: request.originLat, originLng: request.originLng,
      destLat:   request.destLat,   destLng:   request.destLng,
    };

    type Scored = { pool: SharedRideRow; composite: number };
    const qualified: Scored[] = [];

    for (const pool of candidates) {
      const poolRoute: RouteInput = {
        originLat: pool.originLat, originLng: pool.originLng,
        destLat:   pool.destLat,   destLng:   pool.destLng,
      };

      const score = await this.scorer.scoreRoutes(reqRoute, poolRoute);
      if (score < this.similarityThreshold) continue;

      const detourOrigin = haversineM(
        [request.originLng, request.originLat],
        [pool.originLng,    pool.originLat],
      );
      const detourDest = haversineM(
        [request.destLng, request.destLat],
        [pool.destLng,    pool.destLat],
      );

      const budget = pool.detourBudgetM;
      if (detourOrigin > budget || detourDest > budget) continue;

      qualified.push({ pool, composite: score - 0.0005 * (detourOrigin + detourDest) });
    }

    qualified.sort((a, b) => b.composite - a.composite);

    const joinedAt = new Date().toISOString();

    for (const { pool } of qualified) {
      const joined = await this.lifecycle.joinPool({
        poolId: pool.rideId,
        joiner: {
          passenger_id: request.passengerId,
          origin_lat:   request.originLat,
          origin_lng:   request.originLng,
          dest_lat:     request.destLat,
          dest_lng:     request.destLng,
          joined_at:    joinedAt,
        },
        quoteFare: opts.quote,
        idempotency: opts.idempotency,
      });
      if (joined.joined) {
        return {
          mode: 'slotted',
          sharedRideId: pool.rideId,
          poolStatus: joined.closedFull ? 'closed_full' : 'open',
          seatCount: joined.seatCount,
          quote: joined.quote,
        };
      }
      switch (joined.reason) {
        case 'already_member':
        case 'idempotent_replay':
          return {
            mode: 'existing',
            reason: joined.reason,
            sharedRideId: joined.existingPoolId ?? pool.rideId,
          };
        case 'passenger_has_active_pool':
          return {
            mode: 'conflict',
            reason: 'passenger_has_active_pool',
            existingPoolId: joined.existingPoolId,
          };
        default:
          // pool_full / pool_closed / not_found / conflict: stale candidate.
          continue;
      }
    }

    const poolId = randomUUID();
    let opened: SharedRideRow & { quote: SeatQuote };
    try {
      opened = await this.lifecycle.openPool({
        poolId,
        originLat:       request.originLat,
        originLng:       request.originLng,
        destLat:         request.destLat,
        destLng:         request.destLng,
        maxSeats:        this.maxSeats,
        detourBudgetM:   this.detourBudgetM,
        passengerId:     request.passengerId,
        quoteFare:       opts.quote,
        idempotency:     opts.idempotency,
      });
    } catch (err) {
      if (!(err instanceof PoolOpenRejectedError)) throw err;
      if (err.reason === 'idempotent_replay' && err.existingPoolId) {
        return { mode: 'existing', reason: 'idempotent_replay', sharedRideId: err.existingPoolId };
      }
      return {
        mode: 'conflict',
        reason: err.reason === 'conflict' ? 'conflict' : 'passenger_has_active_pool',
        existingPoolId: err.existingPoolId,
      };
    }

    return {
      mode: 'opened',
      sharedRideId: opened.rideId,
      poolStatus: 'open',
      seatCount: opened.seatCount,
      quote: opened.quote,
    };
  }

  /** Exact seat produced by a shared-create idempotency key (reclaim path, F15). */
  async findSeatByIdempotencyKey(passengerId: string, key: string): Promise<SeatLookup | null> {
    return this.members.findByIdempotencyKey(this.db, passengerId, key);
  }

  /** The passenger's seat in a given pool, if any. */
  async findSeat(poolId: string, passengerId: string): Promise<SeatLookup | null> {
    return this.members.findSeat(this.db, poolId, passengerId);
  }
}
