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
import { RideStopRepository } from '../matching/ride-stop.repository';
import { RidesRepository, type RideRow } from '../rides/rides.repository';
import type {
  ClaimResult,
  OfferStop,
  SharedRideOfferPayload,
  SoloRideOfferPayload,
} from './dispatch.types';

export const DISPATCH_QUEUE = 'dispatch';
export const WAVE_TIMEOUT_JOB = 'dispatch:wave-timeout';
export const HARD_FAIL_JOB = 'dispatch:hard-fail';

/** Emitted by the rides controller when a solo ride is persisted `requested`. */
export const RIDE_REQUESTED_EVENT = 'ride.requested';

export interface RideRequestedEventPayload {
  rideId: string;
}

const STOPS_CACHE_TTL_S = 600;
const OFFER_TTL_MS = 12_000;
/** TTL on claim:ride:<id>; only needs to outlive the dispatch contention window. */
const SOLO_CLAIM_TTL_S = 3_600;

export interface WaveTimeoutJob {
  rideId: string;
  waveNumber: number;
  // Absent on pre-RCAB-E4.S4 in-flight jobs → treated as 'pool' by the handler.
  kind?: 'solo' | 'pool';
}

export interface HardFailJob {
  rideId: string;
  kind?: 'solo' | 'pool';
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
    private readonly ridesRepo: RidesRepository,
    private readonly stops: RideStopRepository,
    private readonly lifecycle: PoolLifecycleService,
    private readonly bus: RealtimeBus,
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly events: EventEmitter2,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.poolClaimScript = readFileSync(join(__dirname, 'lua', 'pool_claim.lua'), 'utf-8');

    this.params = {
      k1: config.get<number>('DISPATCH_K1') ?? 5,
      k2: config.get<number>('DISPATCH_K2') ?? 10,
      r1Meters: config.get<number>('DISPATCH_R1_METERS') ?? 2_000,
      r2Meters: config.get<number>('DISPATCH_R2_METERS') ?? 4_000,
      waveOneTimeoutMs: config.get<number>('DISPATCH_WAVE_ONE_TIMEOUT_MS') ?? 30_000,
      hardFailMs: config.get<number>('DISPATCH_HARD_FAIL_MS') ?? 60_000,
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
        'ride_offer_response: no rideId resolvable; ignoring',
      );
      return;
    }

    // Solo offers carry a type tag and claim the rides row directly (not the
    // pool Lua). First-accept-wins; the loser is told the ride is taken.
    const offerType = await this.redis.get(`offer:type:${event.offerId}`);
    if (offerType === 'solo') {
      const result = await this.claimSolo(rideId, event.driverId);
      if (result.ok) {
        this.bus.toDriver(event.driverId, 'ride_offer_accepted', {
          offerId: event.offerId,
          rideId,
        });
        // The booking client joined `ride:<id>` at request time (E4.S6); tell it
        // a driver was assigned so its live-tracking view lights up before the
        // first location packet (E4.S7). The richer driver/vehicle payload is
        // deferred — this thin signal is enough to flip the rider's UI.
        this.bus.toRide(rideId, 'ride_state_changed', {
          rideId,
          state: 'accepted',
          by: 'driver',
        });
      } else {
        this.bus.toDriver(event.driverId, 'ride_offer_revoked', {
          offerId: event.offerId,
          rideId,
          reason: result.reason === 'already_taken' ? 'taken' : 'unavailable',
        });
      }
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

  @OnEvent(RIDE_REQUESTED_EVENT, { async: true })
  async onRideRequested(payload: RideRequestedEventPayload): Promise<void> {
    this.log.log({ rideId: payload.rideId }, 'ride.requested → dispatchSolo');
    try {
      await this.dispatchSolo(payload.rideId);
    } catch (err) {
      this.log.error({ err, rideId: payload.rideId }, 'dispatchSolo failed');
    }
  }

  async dispatchSolo(rideId: string): Promise<void> {
    const ride = await this.ridesRepo.findById(rideId);
    if (!ride) {
      this.log.warn({ rideId }, 'dispatchSolo: ride not found');
      return;
    }
    if (ride.status !== 'requested') {
      this.log.warn(
        { rideId, status: ride.status },
        'dispatchSolo: ride not in requested state; skipping',
      );
      return;
    }
    await this.runSoloWave(ride, 1);
  }

  async runSoloWave(ride: RideRow, waveNumber: number): Promise<void> {
    const { k, radiusMeters } =
      waveNumber === 1
        ? { k: this.params.k1, radiusMeters: this.params.r1Meters }
        : { k: this.params.k2, radiusMeters: this.params.r2Meters };

    const offeredSetKey = `ride:${ride.id}:offered`;
    const fresh = await this.selectCandidates(
      ride.originLat,
      ride.originLng,
      k,
      radiusMeters,
      offeredSetKey,
    );

    if (fresh.length === 0) {
      this.log.warn(
        { rideId: ride.id, waveNumber, radiusMeters },
        'no fresh candidates this wave (solo)',
      );
    }

    for (const driverId of fresh) {
      const offerId = await this.reserveOffer(ride.id, driverId, offeredSetKey, { solo: true });
      if (!offerId) continue;

      const payload: SoloRideOfferPayload = {
        offerId,
        rideId: ride.id,
        ttlMs: OFFER_TTL_MS,
        pickup: { lat: ride.originLat, lng: ride.originLng },
        dropoff: { lat: ride.destLat, lng: ride.destLng },
        fareCents: ride.fareCents,
        waveNumber,
      };

      this.bus.toDriver(driverId, 'ride_offer', payload);
    }

    if (waveNumber === 1) {
      // Schedule the wave-2 escalation + 60 s hard-fail; the handlers branch on
      // job.kind='solo' to re-offer (wave 2) or mark the ride no_driver.
      await this.queue.add(
        WAVE_TIMEOUT_JOB,
        { rideId: ride.id, waveNumber: 2, kind: 'solo' } satisfies WaveTimeoutJob,
        {
          jobId: waveTimeoutJobId(ride.id, 2),
          delay: this.params.waveOneTimeoutMs,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      await this.queue.add(HARD_FAIL_JOB, { rideId: ride.id, kind: 'solo' } satisfies HardFailJob, {
        jobId: hardFailJobId(ride.id),
        delay: this.params.hardFailMs,
        removeOnComplete: true,
        removeOnFail: 100,
      });
    }
  }

  async runWave(pool: SharedRideRow, waveNumber: number): Promise<void> {
    const stops = await this.getOrComputeStops(pool);
    const { k, radiusMeters } =
      waveNumber === 1
        ? { k: this.params.k1, radiusMeters: this.params.r1Meters }
        : { k: this.params.k2, radiusMeters: this.params.r2Meters };

    const offeredSetKey = `pool:${pool.rideId}:offered`;
    const fresh = await this.selectCandidates(
      pool.originLat,
      pool.originLng,
      k,
      radiusMeters,
      offeredSetKey,
    );

    if (fresh.length === 0) {
      this.log.warn(
        { rideId: pool.rideId, waveNumber, radiusMeters },
        'no fresh candidates this wave',
      );
    }

    for (const driverId of fresh) {
      const offerId = await this.reserveOffer(pool.rideId, driverId, offeredSetKey);
      if (!offerId) continue;

      const payload: SharedRideOfferPayload = {
        offerId,
        sharedRideId: pool.rideId,
        ttlMs: OFFER_TTL_MS,
        stops,
        passengerCount: pool.members.length,
        waveNumber,
      };

      this.bus.toDriver(driverId, 'ride_offer', payload);
    }

    if (waveNumber === 1) {
      await this.queue.add(
        WAVE_TIMEOUT_JOB,
        { rideId: pool.rideId, waveNumber: 2, kind: 'pool' } satisfies WaveTimeoutJob,
        {
          jobId: waveTimeoutJobId(pool.rideId, 2),
          delay: this.params.waveOneTimeoutMs,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      await this.queue.add(
        HARD_FAIL_JOB,
        { rideId: pool.rideId, kind: 'pool' } satisfies HardFailJob,
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
    const { rideId, waveNumber, kind } = job.data;

    if (kind === 'solo') {
      const ride = await this.ridesRepo.findById(rideId);
      // Already claimed / cancelled / no_driver → the timer is a stale no-op.
      if (!ride || ride.status !== 'requested') return;
      await this.runSoloWave(ride, waveNumber);
      return;
    }

    const pool = await this.repo.findById(rideId);
    if (!pool || pool.claimedByDriverId) return;
    await this.runWave(pool, waveNumber);
  }

  async handleHardFail(job: Job<HardFailJob>): Promise<void> {
    const { rideId, kind } = job.data;

    if (kind === 'solo') {
      // Guarded UPDATE: returns null if the ride was claimed in the same instant.
      const failed = await this.ridesRepo.markNoDriver(rideId);
      if (!failed) return;
      this.log.warn({ rideId }, 'dispatch hard-fail → no_driver (solo)');
      await this.revokeAllOffers(rideId);
      this.bus.toUser(failed.passengerId, 'ride_no_driver', { rideId });
      return;
    }

    const pool = await this.repo.findById(rideId);
    if (!pool || pool.claimedByDriverId) return;
    this.log.warn({ rideId }, 'dispatch hard-fail → aborting pool');
    await this.lifecycle.closePool(rideId, 'aborted');
    await this.revokeAllOffers(rideId);
    // Phase-0: an aborted pool is terminal. Re-queueing each member as an
    // individual solo ride (the solo path now exists) is a future enhancement.
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
    if (code === 0) return { ok: false, reason: 'already_taken' };

    await this.repo.setClaimed(rideId, driverId, claimedAt);
    await this.persistStops(rideId);
    await this.redis.hset(`driver:state:${driverId}`, 'current_ride_id', rideId).catch(() => {
      this.log.warn({ rideId, driverId }, 'failed to set driver:state.current_ride_id');
    });
    await this.revokeAllOffers(rideId);
    await this.queue.remove(waveTimeoutJobId(rideId, 2)).catch(() => {});
    await this.queue.remove(hardFailJobId(rideId)).catch(() => {});

    return { ok: true, reason: 'claimed' };
  }

  /**
   * Atomic first-accept-wins claim for a solo ride. The Redis `claim:ride:<id>`
   * SET NX is the single point of decision (per the accepted top-K algo — keeps
   * Postgres out of the contention hot path); the winning driver is then bound
   * to the rides row. Losers (incl. the same driver re-tapping) get already_taken.
   */
  async claimSolo(rideId: string, driverId: string): Promise<ClaimResult> {
    const claimKey = `claim:ride:${rideId}`;
    const won = await this.redis.set(claimKey, driverId, 'EX', SOLO_CLAIM_TTL_S, 'NX');
    if (won !== 'OK') {
      const holder = await this.redis.get(claimKey);
      // Idempotent: the same driver's at-least-once redelivery re-confirms.
      if (holder === driverId) return { ok: true, reason: 'claimed' };
      return { ok: false, reason: 'already_taken' };
    }

    const accepted = await this.ridesRepo.claimSolo(rideId, driverId, new Date());
    if (!accepted) {
      // Ride moved on (cancelled / no_driver) between the Redis claim and the
      // DB write — release the claim so nothing is stuck holding it.
      await this.redis.del(claimKey).catch(() => {});
      return { ok: false, reason: 'not_claimable' };
    }

    await this.redis.hset(`driver:state:${driverId}`, 'current_ride_id', rideId).catch(() => {
      this.log.warn({ rideId, driverId }, 'failed to set driver:state.current_ride_id');
    });
    // Revoke every other outstanding offer; exclude the winner so they do not
    // get a spurious ride_offer_revoked alongside their acceptance.
    await this.revokeAllOffers(rideId, driverId);
    await this.queue.remove(waveTimeoutJobId(rideId, 2)).catch(() => {});
    await this.queue.remove(hardFailJobId(rideId)).catch(() => {});

    return { ok: true, reason: 'claimed' };
  }

  private async persistStops(rideId: string): Promise<void> {
    const cached = await this.redis.get(`pool:${rideId}:stops`);
    if (!cached) {
      this.log.warn({ rideId }, 'persistStops: no cached stops; cannot seed ride_stops');
      return;
    }
    let parsed: OfferStop[];
    try {
      parsed = JSON.parse(cached) as OfferStop[];
    } catch (err) {
      this.log.warn({ err, rideId }, 'persistStops: malformed stops cache');
      return;
    }
    try {
      await this.stops.seed(
        rideId,
        parsed.map((s) => ({
          sequenceIndex: s.sequenceIndex,
          passengerId: s.passengerId,
          type: s.type,
          lat: s.lat,
          lng: s.lng,
        })),
      );
    } catch (err) {
      this.log.error({ err, rideId }, 'persistStops: ride_stops seed failed');
    }
  }

  private async revokeAllOffers(rideId: string, exceptDriverId?: string): Promise<void> {
    const offerIds = await this.redis.smembers(`offer:list:${rideId}`);
    if (offerIds.length === 0) return;

    for (const offerId of offerIds) {
      const driverId = await this.redis.get(`offer:${offerId}`);
      await Promise.all([
        this.redis.del(`offer:${offerId}`),
        this.redis.del(`offer:meta:${offerId}`),
        this.redis.del(`offer:type:${offerId}`),
      ]);
      if (driverId && driverId !== exceptDriverId) {
        this.bus.toDriver(driverId, 'ride_offer_revoked', {
          offerId,
          sharedRideId: rideId,
          reason: 'revoked',
        });
      }
    }
    await this.redis.del(`offer:list:${rideId}`);
  }

  /** Nearest available drivers within radius, excluding any already offered. Shared by pool + solo. */
  private async selectCandidates(
    originLat: number,
    originLng: number,
    k: number,
    radiusMeters: number,
    offeredSetKey: string,
  ): Promise<string[]> {
    const seen = new Set(await this.redis.smembers(offeredSetKey));
    const raw = (await this.redis.georadius(
      'active_drivers',
      originLng,
      originLat,
      radiusMeters,
      'm',
      'ASC',
      'COUNT',
      // request K + already-seen so we have headroom after filtering.
      k + seen.size,
    )) as string[];
    return raw.filter((id) => !seen.has(id)).slice(0, k);
  }

  /**
   * Atomically reserve an offer slot for one driver and record the offer keys.
   * Returns the offerId, or null if the driver already holds an unexpired offer.
   * Shared by pool + solo; `opts.solo` tags the offer so the response handler
   * routes its claim to the solo path (RCAB-E4.S4).
   */
  private async reserveOffer(
    rideId: string,
    driverId: string,
    offeredSetKey: string,
    opts: { solo?: boolean } = {},
  ): Promise<string | null> {
    const offerId = randomUUID();
    const reserved = await this.redis.set(
      `offer:${offerId}`,
      driverId,
      'EX',
      Math.ceil(OFFER_TTL_MS / 1000),
      'NX',
    );
    if (reserved !== 'OK') return null;

    const ops: Promise<unknown>[] = [
      this.redis.sadd(`offer:list:${rideId}`, offerId),
      this.redis.expire(`offer:list:${rideId}`, STOPS_CACHE_TTL_S),
      this.redis.sadd(offeredSetKey, driverId),
      this.redis.expire(offeredSetKey, STOPS_CACHE_TTL_S),
      this.redis.set(`offer:meta:${offerId}`, rideId, 'EX', STOPS_CACHE_TTL_S),
    ];
    if (opts.solo) {
      ops.push(this.redis.set(`offer:type:${offerId}`, 'solo', 'EX', STOPS_CACHE_TTL_S));
    }
    await Promise.all(ops);
    return offerId;
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
  const pickups = sortMembersByDistance(pool.members, pool.originLng, pool.originLat);
  const dropoffs = sortMembersByDistance(pool.members, pool.destLng, pool.destLat);

  const stops: OfferStop[] = [];
  let seq = 0;
  for (const m of pickups) {
    stops.push({
      type: 'pickup',
      lat: m.origin_lat,
      lng: m.origin_lng,
      passengerId: m.passenger_id,
      sequenceIndex: seq++,
    });
  }
  for (const m of dropoffs) {
    stops.push({
      type: 'dropoff',
      lat: m.dest_lat,
      lng: m.dest_lng,
      passengerId: m.passenger_id,
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
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
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
