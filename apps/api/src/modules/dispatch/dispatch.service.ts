import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Queue, type Job } from 'bullmq';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { RealtimeBus } from '../realtime/realtime.bus';
import {
  RIDE_OFFER_RESPONSE_EVENT,
  type RideOfferResponseEvent,
} from '../realtime/realtime.gateway';
import {
  POOL_CLOSED_EVENT,
  PoolLifecycleService,
  type PoolClosedEventPayload,
} from '../matching/pool-lifecycle.service';
import {
  SharedRideRepository,
  type SharedRideMember,
  type SharedRideRow,
} from '../matching/shared-ride.repository';
import type {
  ClaimResult,
  OfferStop,
  SharedRideOfferPayload,
} from './dispatch.types';

export const DISPATCH_QUEUE = 'dispatch';
export const WAVE_TIMEOUT_JOB   = 'dispatch:wave-timeout';
export const HARD_FAIL_JOB      = 'dispatch:hard-fail';

const STOPS_CACHE_TTL_S = 600;
const OFFER_TTL_MS      = 12_000;

interface WaveTimeoutJob {
  rideId:     string;
  waveNumber: number;
}

interface HardFailJob {
  rideId: string;
}

interface DispatchParams {
  k1: number;
  k2: number;
  r1Meters: number;
  r2Meters: number;
  waveOneTimeoutMs: number;
  hardFailMs: number;
}

@Injectable()
export class DispatchService {
  private readonly log = new Logger(DispatchService.name);
  private readonly poolClaimScript: string;
  private readonly params: DispatchParams;

  constructor(
    private readonly repo: SharedRideRepository,
    private readonly lifecycle: PoolLifecycleService,
    private readonly bus: RealtimeBus,
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly events: EventEmitter2,
    config: ConfigService,
  ) {
    this.poolClaimScript = readFileSync(
      join(__dirname, 'lua', 'pool_claim.lua'),
      'utf-8',
    );

    this.params = {
      k1:               config.get<number>('DISPATCH_K1')                 ?? 5,
      k2:               config.get<number>('DISPATCH_K2')                 ?? 10,
      r1Meters:         config.get<number>('DISPATCH_R1_METERS')          ?? 2_000,
      r2Meters:         config.get<number>('DISPATCH_R2_METERS')          ?? 4_000,
      waveOneTimeoutMs: config.get<number>('DISPATCH_WAVE_ONE_TIMEOUT_MS') ?? 30_000,
      hardFailMs:       config.get<number>('DISPATCH_HARD_FAIL_MS')        ?? 60_000,
    };
  }

  @OnEvent(POOL_CLOSED_EVENT, { async: true })
  async onPoolClosed(payload: PoolClosedEventPayload): Promise<void> {
    this.log.log({ rideId: payload.rideId, reason: payload.reason }, 'pool.closed → dispatchPool');
    try {
      await this.dispatchPool(payload.rideId);
    } catch (err) {
      this.log.error({ err, rideId: payload.rideId }, 'dispatchPool failed');
    }
  }

  @OnEvent(RIDE_OFFER_RESPONSE_EVENT, { async: true })
  async onRideOfferResponse(event: RideOfferResponseEvent): Promise<void> {
    if (!event.accept) {
      await this.redis.del(`offer:${event.offerId}`).catch(() => {});
      return;
    }

    let rideId = event.sharedRideId;
    if (!rideId) {
      rideId = (await this.redis.get(`offer:meta:${event.offerId}`)) ?? undefined;
    }

    if (!rideId) {
      this.log.warn(
        { offerId: event.offerId, driverId: event.driverId },
        'ride_offer_response: no rideId resolvable; ignoring (solo path TODO RCAB-E4.S5)',
      );
      return;
    }

    const result = await this.claimPool(rideId, event.driverId);
    if (!result.ok) {
      this.log.warn(
        { rideId, driverId: event.driverId, reason: result.reason },
        'claimPool failed',
      );
    }
  }

  async dispatchPool(rideId: string): Promise<void> {
    const pool = await this.repo.findById(rideId);
    if (!pool) {
      this.log.warn({ rideId }, 'dispatchPool: pool not found');
      return;
    }
    if (pool.claimedByDriverId) {
      this.log.warn({ rideId }, 'dispatchPool: pool already claimed; skipping');
      return;
    }
    await this.runWave(pool, 1);
  }

  async runWave(pool: SharedRideRow, waveNumber: number): Promise<void> {
    const stops = await this.getOrComputeStops(pool);
    const { k, radiusMeters } =
      waveNumber === 1
        ? { k: this.params.k1, radiusMeters: this.params.r1Meters }
        : { k: this.params.k2, radiusMeters: this.params.r2Meters };

    const excluded = await this.redis.smembers(`pool:${pool.rideId}:offered`);
    const seen = new Set(excluded);

    const candidatesRaw = (await this.redis.georadius(
      'active_drivers',
      pool.originLng,
      pool.originLat,
      radiusMeters,
      'm',
      'ASC',
      'COUNT',
      // request K + already-seen so we have headroom after filtering.
      k + seen.size,
    )) as string[];

    const fresh = candidatesRaw.filter((id) => !seen.has(id)).slice(0, k);

    if (fresh.length === 0) {
      this.log.warn(
        { rideId: pool.rideId, waveNumber, radiusMeters },
        'no fresh candidates this wave',
      );
    }

    for (const driverId of fresh) {
      const offerId = randomUUID();
      const reserved = await this.redis.set(
        `offer:${offerId}`,
        driverId,
        'EX',
        Math.ceil(OFFER_TTL_MS / 1000),
        'NX',
      );
      if (reserved !== 'OK') continue;

      await Promise.all([
        this.redis.sadd(`offer:list:${pool.rideId}`, offerId),
        this.redis.expire(`offer:list:${pool.rideId}`, STOPS_CACHE_TTL_S),
        this.redis.sadd(`pool:${pool.rideId}:offered`, driverId),
        this.redis.expire(`pool:${pool.rideId}:offered`, STOPS_CACHE_TTL_S),
        this.redis.set(`offer:meta:${offerId}`, pool.rideId, 'EX', STOPS_CACHE_TTL_S),
      ]);

      const payload: SharedRideOfferPayload = {
        offerId,
        sharedRideId:   pool.rideId,
        ttlMs:          OFFER_TTL_MS,
        stops,
        passengerCount: pool.members.length,
        waveNumber,
      };

      this.bus.toDriver(driverId, 'ride_offer', payload);
    }

    if (waveNumber === 1) {
      await this.queue.add(
        WAVE_TIMEOUT_JOB,
        { rideId: pool.rideId, waveNumber: 2 } satisfies WaveTimeoutJob,
        {
          jobId: waveTimeoutJobId(pool.rideId, 2),
          delay: this.params.waveOneTimeoutMs,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      await this.queue.add(
        HARD_FAIL_JOB,
        { rideId: pool.rideId } satisfies HardFailJob,
        {
          jobId: hardFailJobId(pool.rideId),
          delay: this.params.hardFailMs,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    }
  }

  async handleWaveTimeout(job: Job<WaveTimeoutJob>): Promise<void> {
    const { rideId, waveNumber } = job.data;
    const pool = await this.repo.findById(rideId);
    if (!pool || pool.claimedByDriverId) return;
    await this.runWave(pool, waveNumber);
  }

  async handleHardFail(job: Job<HardFailJob>): Promise<void> {
    const { rideId } = job.data;
    const pool = await this.repo.findById(rideId);
    if (!pool || pool.claimedByDriverId) return;
    this.log.warn({ rideId }, 'dispatch hard-fail → aborting pool');
    await this.lifecycle.closePool(rideId, 'aborted');
    await this.revokeAllOffers(rideId);
    // TODO(RCAB-E4.S3): re-queue each member as a solo RideRequest once the
    // solo dispatch path exists. For Phase-0 we only flip the pool to aborted.
  }

  async claimPool(rideId: string, driverId: string): Promise<ClaimResult> {
    const claimedAt = new Date();
    const code = Number(
      await this.redis.eval(
        this.poolClaimScript,
        1,
        `pool:${rideId}`,
        driverId,
        claimedAt.toISOString(),
      ),
    );

    if (code === -2) return { ok: false, reason: 'not_found' };
    if (code === -1) return { ok: false, reason: 'not_closed' };
    if (code === 0)  return { ok: false, reason: 'already_taken' };

    await this.repo.setClaimed(rideId, driverId, claimedAt);
    await this.revokeAllOffers(rideId);
    await this.queue.remove(waveTimeoutJobId(rideId, 2)).catch(() => {});
    await this.queue.remove(hardFailJobId(rideId)).catch(() => {});

    return { ok: true, reason: 'claimed' };
  }

  private async revokeAllOffers(rideId: string): Promise<void> {
    const offerIds = await this.redis.smembers(`offer:list:${rideId}`);
    if (offerIds.length === 0) return;

    for (const offerId of offerIds) {
      const driverId = await this.redis.get(`offer:${offerId}`);
      await Promise.all([
        this.redis.del(`offer:${offerId}`),
        this.redis.del(`offer:meta:${offerId}`),
      ]);
      if (driverId) {
        this.bus.toDriver(driverId, 'ride_offer_revoked', {
          offerId,
          sharedRideId: rideId,
          reason: 'revoked',
        });
      }
    }
    await this.redis.del(`offer:list:${rideId}`);
  }

  private async getOrComputeStops(pool: SharedRideRow): Promise<OfferStop[]> {
    const key = `pool:${pool.rideId}:stops`;
    const cached = await this.redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as OfferStop[];
      } catch {
        // fall through to recompute
      }
    }
    const stops = computeStops(pool);
    await this.redis.set(key, JSON.stringify(stops), 'EX', STOPS_CACHE_TTL_S);
    return stops;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function computeStops(pool: SharedRideRow): OfferStop[] {
  const pickups = sortMembersByDistance(
    pool.members,
    pool.originLng,
    pool.originLat,
  );
  const dropoffs = sortMembersByDistance(
    pool.members,
    pool.destLng,
    pool.destLat,
  );

  const stops: OfferStop[] = [];
  let seq = 0;
  for (const m of pickups) {
    stops.push({
      type:          'pickup',
      lat:           m.origin_lat,
      lng:           m.origin_lng,
      passengerId:   m.passenger_id,
      sequenceIndex: seq++,
    });
  }
  for (const m of dropoffs) {
    stops.push({
      type:          'dropoff',
      lat:           m.dest_lat,
      lng:           m.dest_lng,
      passengerId:   m.passenger_id,
      sequenceIndex: seq++,
    });
  }
  return stops;
}

function sortMembersByDistance(
  members: SharedRideMember[],
  refLng: number,
  refLat: number,
): SharedRideMember[] {
  const haversine = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6_371_000;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLam = ((lng2 - lng1) * Math.PI) / 180;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const a =
      Math.sin(dPhi / 2) ** 2 +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  return [...members].sort((a, b) => {
    const da = haversine(refLat, refLng, a.origin_lat, a.origin_lng);
    const db = haversine(refLat, refLng, b.origin_lat, b.origin_lng);
    return da - db;
  });
}

function waveTimeoutJobId(rideId: string, _waveNumber: number): string {
  // BullMQ rejects custom IDs with more than 2 colons (split(':').length must
  // be 3). Phase-0 only schedules one wave-2 timeout per pool, so the wave
  // number is dropped from the job id.
  return `dispatch:wave2-timeout:${rideId}`;
}

function hardFailJobId(rideId: string): string {
  return `dispatch:hard-fail:${rideId}`;
}
