import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RouteSimilarityService, type RouteInput } from './route-similarity.service';
import { SharedRideRepository, type SharedRideRow } from './shared-ride.repository';
import { PoolLifecycleService, type PoolStatus } from './pool-lifecycle.service';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SharedRideRequest {
  passengerId: string;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

export type MatchResult =
  | { mode: 'slotted'; sharedRideId: string; poolStatus: PoolStatus }
  | { mode: 'opened';  sharedRideId: string; poolStatus: 'open' };

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
    config: ConfigService,
  ) {
    this.similarityThreshold = config.get<number>('MATCHING_SIMILARITY_THRESHOLD') ?? 0.7;
    this.detourBudgetM       = config.get<number>('MATCHING_DETOUR_BUDGET_M')       ?? 800;
    this.maxSeats            = config.get<number>('MATCHING_MAX_SEATS')             ?? 3;
  }

  async findOrCreatePool(request: SharedRideRequest): Promise<MatchResult> {
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
      const slot = await this.lifecycle.slotRequest({
        pool,
        joiner: {
          passenger_id: request.passengerId,
          origin_lat:   request.originLat,
          origin_lng:   request.originLng,
          dest_lat:     request.destLat,
          dest_lng:     request.destLng,
          joined_at:    joinedAt,
        },
      });
      if (slot.slotted) {
        return {
          mode: 'slotted',
          sharedRideId: pool.rideId,
          poolStatus: slot.closedFull ? 'closed_full' : 'open',
        };
      }
    }

    const newPool = await this.lifecycle.openPool({
      originLat:     request.originLat,
      originLng:     request.originLng,
      destLat:       request.destLat,
      destLng:       request.destLng,
      maxSeats:      this.maxSeats,
      detourBudgetM: this.detourBudgetM,
      passengerId:   request.passengerId,
    });

    return { mode: 'opened', sharedRideId: newPool.rideId, poolStatus: 'open' };
  }
}
