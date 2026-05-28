import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { RouteSimilarityService, type RouteInput } from './route-similarity.service';
import { SharedRideRepository, type SharedRideRow } from './shared-ride.repository';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SharedRideRequest {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

export type MatchResult =
  | { mode: 'slotted'; sharedRideId: string }
  | { mode: 'opened';  sharedRideId: string };

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
  private readonly poolSlotScript: string;

  constructor(
    private readonly repo: SharedRideRepository,
    private readonly scorer: RouteSimilarityService,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.similarityThreshold = config.get<number>('MATCHING_SIMILARITY_THRESHOLD') ?? 0.7;
    this.detourBudgetM       = config.get<number>('MATCHING_DETOUR_BUDGET_M')       ?? 800;
    this.maxSeats            = config.get<number>('MATCHING_MAX_SEATS')             ?? 3;
    this.poolSlotScript      = readFileSync(join(__dirname, 'lua', 'pool_slot.lua'), 'utf-8');
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

    // Score each candidate and collect those that pass the threshold + detour check.
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

    // Best composite score first.
    qualified.sort((a, b) => b.composite - a.composite);

    for (const { pool } of qualified) {
      if (await this.trySlot(pool)) {
        return { mode: 'slotted', sharedRideId: pool.rideId };
      }
    }

    const newPool = await this.repo.create({
      originLat:    request.originLat,
      originLng:    request.originLng,
      destLat:      request.destLat,
      destLng:      request.destLng,
      maxSeats:     this.maxSeats,
      detourBudgetM: this.detourBudgetM,
    });

    return { mode: 'opened', sharedRideId: newPool.rideId };
  }

  private async trySlot(pool: SharedRideRow): Promise<boolean> {
    const key    = `pool:${pool.rideId}:seats`;
    const result = Number(
      await this.redis.eval(
        this.poolSlotScript,
        1,
        key,
        String(pool.maxSeats),
        String(pool.seatCount),
      ),
    );

    if (result < 0) return false;

    await this.repo.incrementSeats(pool.rideId, result);
    return true;
  }
}
