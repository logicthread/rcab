import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getNumber } from '../../common/utils/env';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { DRIZZLE_DB, type DrizzleDb, type DrizzleTx } from '../../infra/db/drizzle.module';
import { RealtimeBus } from '../realtime/realtime.bus';
import {
  RIDE_OFFER_RESPONSE_EVENT,
  type RideOfferResponseEvent,
} from '../realtime/realtime.gateway';
import {
  POOL_CLOSED_EVENT,
  type PoolClosedEventPayload,
} from '../matching/pool-lifecycle.service';
import {
  SharedRideRepository,
  type SharedRideMember,
  type SharedRideRow,
} from '../matching/shared-ride.repository';
import { RideStopRepository } from '../matching/ride-stop.repository';
import { RidesRepository, type RevokedOffer, type RideRow } from '../rides/rides.repository';
import {
  RIDE_CANCELLED_EVENT,
  type RideCancelledEventPayload,
} from '../rides/ride-state-machine.service';
import { DispatchOfferRepository, isUuid } from './offer.repository';
import {
  CLAIMABLE_POOL_STATES,
  DriverAssignmentRepository,
} from './assignment.repository';
import { DriverAssignmentProjection } from './driver-assignment.projection';
import { withTxRetry } from './tx-retry';
import {
  tripId,
  type AcceptOfferFailure,
  type AcceptOfferResult,
  type DeclineOfferResult,
  type OfferStop,
  type SharedRideOfferPayload,
  type SoloRideOfferPayload,
  type TripRef,
} from './dispatch.types';

export const DISPATCH_QUEUE = 'dispatch';
export const WAVE_TIMEOUT_JOB = 'dispatch:wave-timeout';
export const HARD_FAIL_JOB = 'dispatch:hard-fail';

/** Emitted by the rides controller when a solo ride is persisted `requested`. */
export const RIDE_REQUESTED_EVENT = 'ride.requested';

export interface RideRequestedEventPayload {
  rideId: string;
}

/** Live offer lifetime. The authoritative deadline is `dispatch_offer.expires_at`. */
export const OFFER_TTL_MS = 12_000;
/** Geo-index over-fetch so ineligible / already-offered drivers do not starve a wave. */
const CANDIDATE_HEADROOM = 4;

export interface WaveTimeoutJob {
  rideId: string;
  waveNumber: number;
  // Absent on pre-RCAB-E4.S4 in-flight jobs → treated as 'pool' by the handler.
  kind?: 'solo' | 'pool';
  /** Trip dispatch generation; absent on pre-Stage-C jobs → "current". */
  generation?: number;
}

export interface HardFailJob {
  rideId: string;
  kind?: 'solo' | 'pool';
  /** Trip dispatch generation; absent on pre-Stage-C jobs → "current". */
  generation?: number;
}

/** Wave-2 escalation timer for one trip generation (no colons: contract §1.3 rule 7). */
export function waveTwoJobId(tripRef: string, generation: number): string {
  return `dispatch-wave2-${tripRef}-g${generation}`;
}

/** No-driver hard-fail timer for one trip generation. */
export function hardFailJobId(tripRef: string, generation: number): string {
  return `dispatch-hardfail-${tripRef}-g${generation}`;
}

/** Pre-Stage-C ids still possibly in flight at deploy; removed alongside the new ones. */
export function legacyWaveTwoJobId(tripRef: string): string {
  return `dispatch:wave2-timeout:${tripRef}`;
}

export function legacyHardFailJobId(tripRef: string): string {
  return `dispatch:hard-fail:${tripRef}`;
}

interface DispatchParams {
  k1: number;
  k2: number;
  r1Meters: number;
  r2Meters: number;
  waveOneTimeoutMs: number;
  hardFailMs: number;
}

/** What the accept transaction decided, plus what to tell people after commit. */
interface AcceptOutcome {
  result: AcceptOfferResult;
  revoked: RevokedOffer[];
}

function rejected(reason: AcceptOfferFailure): AcceptOutcome {
  return { result: { ok: false, reason }, revoked: [] };
}

@Injectable()
export class DispatchService {
  private readonly log = new Logger(DispatchService.name);
  private readonly params: DispatchParams;

  constructor(
    private readonly repo: SharedRideRepository,
    private readonly ridesRepo: RidesRepository,
    private readonly stops: RideStopRepository,
    private readonly offers: DispatchOfferRepository,
    private readonly assignments: DriverAssignmentRepository,
    private readonly projection: DriverAssignmentProjection,
    private readonly bus: RealtimeBus,
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.params = {
      k1: getNumber(config, 'DISPATCH_K1', 5, { integer: true, min: 1 }),
      k2: getNumber(config, 'DISPATCH_K2', 10, { integer: true, min: 1 }),
      r1Meters: getNumber(config, 'DISPATCH_R1_METERS', 2_000, { min: 1 }),
      r2Meters: getNumber(config, 'DISPATCH_R2_METERS', 4_000, { min: 1 }),
      waveOneTimeoutMs: getNumber(config, 'DISPATCH_WAVE_ONE_TIMEOUT_MS', 30_000, {
        integer: true,
        min: 1,
      }),
      hardFailMs: getNumber(config, 'DISPATCH_HARD_FAIL_MS', 60_000, { integer: true, min: 1 }),
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

  /**
   * The gateway's `ride_offer_response`, already shape-checked (UUID offer id,
   * strict boolean). Registered synchronously (no `async` listener option) so
   * the gateway's `emitAsync` receives this result as the Socket.IO ack.
   */
  @OnEvent(RIDE_OFFER_RESPONSE_EVENT)
  async onRideOfferResponse(
    event: RideOfferResponseEvent,
  ): Promise<AcceptOfferResult | DeclineOfferResult> {
    const input = { offerId: event.offerId, driverId: event.driverId };
    return event.accept ? this.acceptOffer(input) : this.declineOffer(input);
  }

  /**
   * Accept an offer (F05 / F06). The trip is derived from the authoritative
   * `dispatch_offer` row — never from the client — and the whole decision is
   * one Postgres transaction in the contract lock order: trip row → offer row →
   * assignment guard. Expiry is judged on the DB clock after the locks are
   * held. A previously committed acceptance is recognised before any expiry
   * rule and replayed; an acceptance whose assignment was since released
   * (completed / cancelled) is never re-created. Deadlock / serialization
   * victims are retried twice, then answered `conflict`.
   *
   * After commit (best effort, never turning success into failure): project
   * `current_ride_id`, drop the wave-2 + hard-fail timers, ack the winner,
   * revoke the other drivers, tell the solo ride room it was accepted.
   */
  async acceptOffer(input: { offerId: string; driverId: string }): Promise<AcceptOfferResult> {
    const { offerId, driverId } = input;
    if (!isUuid(offerId) || !isUuid(driverId)) {
      this.notifyAcceptRejected(driverId, offerId, null, 'offer_not_found');
      return { ok: false, reason: 'offer_not_found' };
    }
    const seen = await this.offers.findForDriver(this.db, offerId, driverId);
    if (!seen) {
      this.notifyAcceptRejected(driverId, offerId, null, 'offer_not_found');
      return { ok: false, reason: 'offer_not_found' };
    }

    const outcome = await withTxRetry(
      () => this.db.transaction((tx) => this.acceptInTx(tx, offerId, driverId, seen.trip)),
      () => rejected('conflict'),
    );

    const { result } = outcome;
    if (result.ok) {
      await this.afterAccepted(driverId, offerId, result, outcome.revoked);
    } else if (result.reason !== 'conflict') {
      // A lost lock race leaves the offer live: the ack says retry, no revoke.
      this.notifyAcceptRejected(driverId, offerId, seen.trip, result.reason);
    }
    return result;
  }

  /** One guarded UPDATE: only the caller's own live offer is declined. */
  async declineOffer(input: { offerId: string; driverId: string }): Promise<DeclineOfferResult> {
    return this.offers.decline(this.db, input.offerId, input.driverId);
  }

  private async acceptInTx(
    tx: DrizzleTx,
    offerId: string,
    driverId: string,
    trip: TripRef,
  ): Promise<AcceptOutcome> {
    // 1. Trip row lock (contract §1.3 step 1) — serializes against other
    //    accepts, cancel, hard-fail and completion of the same trip.
    const locked =
      trip.kind === 'solo'
        ? await this.assignments.lockSoloTrip(tx, trip.rideId)
        : await this.assignments.lockSharedTrip(tx, trip.sharedRideId);
    if (!locked) return rejected('trip_not_claimable');
    const takenBy = 'status' in locked ? locked.driverId : locked.claimedByDriverId;

    // 2. Offer row lock, re-validated now that the trip is held.
    const offer = await this.offers.lockForUpdate(tx, offerId);
    if (!offer || offer.driverId !== driverId) return rejected('offer_not_found');

    // 3. A committed acceptance replays before any first-use rule.
    if (offer.state === 'accepted') {
      const guard = await this.assignments.findByTrip(tx, trip);
      if (guard && guard.driverId === driverId && guard.generation === offer.generation) {
        return {
          result: { ok: true, trip, generation: offer.generation, replay: true },
          revoked: [],
        };
      }
      // Released since (completed / cancelled): never re-create it.
      return rejected('trip_not_claimable');
    }
    if (offer.state !== 'offered') {
      // Revoked because another driver won: say so rather than a bare revoke.
      if (offer.state === 'revoked' && takenBy && takenBy !== driverId) {
        return rejected('trip_taken');
      }
      return rejected(`offer_${offer.state}`);
    }

    // 4. Deadline on the DB clock, after the locks.
    if (offer.lapsed) {
      await this.offers.resolveLive(tx, offerId, 'expired');
      return rejected('offer_expired');
    }
    if (offer.generation !== locked.dispatchGeneration) {
      await this.offers.resolveLive(tx, offerId, 'revoked');
      return rejected('offer_stale');
    }

    // 5. Trip state.
    let seatsNeeded = 1;
    if ('status' in locked) {
      if (locked.driverId) return rejected('trip_taken');
      if (locked.status !== 'requested') return rejected('trip_not_claimable');
    } else {
      if (locked.claimedByDriverId) return rejected('trip_taken');
      if (!(CLAIMABLE_POOL_STATES as readonly string[]).includes(locked.poolState)) {
        return rejected('trip_not_claimable');
      }
      const stopCount = await this.stops.countAll(locked.rideId, tx);
      if (locked.seatCount < 1 || stopCount !== 2 * locked.seatCount) {
        return rejected('itinerary_missing');
      }
      seatsNeeded = locked.seatCount;
    }

    // 6. Account + vehicle eligibility at the decision.
    const eligibility = await this.assignments.driverEligibility(tx, driverId, seatsNeeded);
    if (eligibility !== 'ok') return rejected(eligibility);

    // 7. The exclusivity guard (savepoint; typed on conflict).
    const guard = await this.assignments.acquire(tx, {
      driverId,
      trip,
      offerId,
      generation: offer.generation,
    });
    if (!guard.ok) return rejected(guard.reason);

    // 8. Bind the trip, resolve the offer, revoke the rest.
    if (trip.kind === 'solo') {
      await this.assignments.claimSoloRow(tx, trip.rideId, driverId, offer.generation);
    } else {
      await this.assignments.claimSharedRow(tx, trip.sharedRideId, driverId, offer.generation);
    }
    await this.offers.markAccepted(tx, offerId);
    const revoked = await this.offers.revokeLiveForTrip(tx, trip, offerId);
    return { result: { ok: true, trip, generation: offer.generation, replay: false }, revoked };
  }

  private async afterAccepted(
    driverId: string,
    offerId: string,
    result: Extract<AcceptOfferResult, { ok: true }>,
    revoked: RevokedOffer[],
  ): Promise<void> {
    const id = tripId(result.trip);
    await this.projection.set(driverId, id);
    if (!result.replay) await this.removeTimers(id, result.generation);

    this.safely('ride_offer_accepted', () =>
      this.bus.toDriver(driverId, 'ride_offer_accepted', {
        offerId,
        rideId: id,
        ...(result.trip.kind === 'shared' ? { sharedRideId: id } : {}),
      }),
    );
    if (result.replay) return;
    this.notifyRevoked(result.trip, revoked, 'taken');
    if (result.trip.kind === 'solo') {
      // The booking client joined `ride:<id>` at request time (E4.S6).
      this.safely('ride_state_changed', () =>
        this.bus.toRide(id, 'ride_state_changed', { rideId: id, state: 'accepted', by: 'driver' }),
      );
    }
  }

  /**
   * Legacy clients do not read the ack yet, so a refused accept also gets the
   * `ride_offer_revoked` they already handle. The trip id is only echoed for
   * the caller's own offer (no leak for an unknown / foreign offer id).
   */
  private notifyAcceptRejected(
    driverId: string,
    offerId: string,
    trip: TripRef | null,
    reason: AcceptOfferFailure,
  ): void {
    if (!isUuid(driverId)) return;
    const id = trip ? tripId(trip) : undefined;
    this.safely('ride_offer_revoked', () =>
      this.bus.toDriver(driverId, 'ride_offer_revoked', {
        offerId,
        ...(id ? { rideId: id, sharedRideId: id } : {}),
        reason: reason === 'trip_taken' ? 'taken' : 'unavailable',
        detail: reason,
      }),
    );
  }

  private notifyRevoked(trip: TripRef, revoked: RevokedOffer[], reason: 'taken' | 'revoked'): void {
    const id = tripId(trip);
    for (const r of revoked) {
      this.safely('ride_offer_revoked', () =>
        this.bus.toDriver(r.driverId, 'ride_offer_revoked', {
          offerId: r.offerId,
          ...(trip.kind === 'solo' ? { rideId: id } : {}),
          sharedRideId: id,
          reason,
        }),
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
    await this.runPoolWave(pool, 1);
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

  /**
   * Offer one wave of a solo ride's generation to the nearest eligible
   * drivers. Throws on infrastructure failure (Postgres, Redis geo, queue.add)
   * so the calling job retries; idempotent within a generation — the offer
   * unique constraints skip drivers already offered and the timer job ids are
   * deterministic per generation. Wave 1 also arms the wave-2 escalation and
   * the hard-fail timer (`DISPATCH_WAVE_ONE_TIMEOUT_MS` / `DISPATCH_HARD_FAIL_MS`,
   * unchanged — flag F-1).
   */
  async runSoloWave(
    ride: RideRow,
    waveNumber: 1 | 2,
    generation: number = ride.dispatchGeneration,
  ): Promise<void> {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new Error(`runSoloWave: ride ${ride.id} has no dispatch generation (${generation})`);
    }
    const trip: TripRef = { kind: 'solo', rideId: ride.id };
    const { k, radiusMeters } = this.waveParams(waveNumber);
    const candidates = await this.selectCandidates(trip, generation, ride.originLat, ride.originLng, {
      k,
      radiusMeters,
      seatsNeeded: 1,
    });
    if (candidates.length === 0) {
      this.log.warn(
        { rideId: ride.id, waveNumber, radiusMeters },
        'no fresh candidates this wave (solo)',
      );
    }

    for (const driverId of candidates) {
      const offer = await this.offers.createOffer(this.db, {
        trip,
        driverId,
        generation,
        waveNumber,
        ttlMs: OFFER_TTL_MS,
      });
      if (!offer) continue;
      const payload: SoloRideOfferPayload = {
        offerId: offer.offerId,
        rideId: ride.id,
        ttlMs: OFFER_TTL_MS,
        expiresAt: offer.expiresAt.toISOString(),
        pickup: { lat: ride.originLat, lng: ride.originLng },
        dropoff: { lat: ride.destLat, lng: ride.destLng },
        fareCents: ride.fareCents,
        waveNumber,
      };
      this.safely('ride_offer', () => this.bus.toDriver(driverId, 'ride_offer', payload));
    }

    if (waveNumber === 1) await this.scheduleTimers(ride.id, 'solo', generation);
  }

  /**
   * Offer one wave of a closed pool's generation. The itinerary comes from the
   * persisted `ride_stops` (written by pool closure) and `passengerCount` is
   * the derived `seat_count`; a pool without a complete itinerary gets no
   * offers (its accept could only answer `itinerary_missing`) but still gets
   * its timers, so the hard-fail aborts it. Same throw / idempotency contract
   * as `runSoloWave`.
   */
  async runPoolWave(
    pool: SharedRideRow,
    waveNumber: 1 | 2,
    generation: number = pool.dispatchGeneration,
  ): Promise<void> {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new Error(`runPoolWave: pool ${pool.rideId} has no dispatch generation (${generation})`);
    }
    const trip: TripRef = { kind: 'shared', sharedRideId: pool.rideId };
    const rows = await this.stops.findByRideId(pool.rideId);
    const stops: OfferStop[] = rows.map((s) => ({
      type: s.type,
      lat: s.lat,
      lng: s.lng,
      passengerId: s.passengerId,
      sequenceIndex: s.sequenceIndex,
    }));

    if (pool.seatCount < 1 || stops.length !== 2 * pool.seatCount) {
      this.log.error(
        { rideId: pool.rideId, seatCount: pool.seatCount, stops: stops.length },
        'runPoolWave: pool itinerary missing or incomplete; no offers',
      );
    } else {
      const { k, radiusMeters } = this.waveParams(waveNumber);
      const candidates = await this.selectCandidates(
        trip,
        generation,
        pool.originLat,
        pool.originLng,
        { k, radiusMeters, seatsNeeded: pool.seatCount },
      );
      if (candidates.length === 0) {
        this.log.warn(
          { rideId: pool.rideId, waveNumber, radiusMeters },
          'no fresh candidates this wave',
        );
      }
      for (const driverId of candidates) {
        const offer = await this.offers.createOffer(this.db, {
          trip,
          driverId,
          generation,
          waveNumber,
          ttlMs: OFFER_TTL_MS,
        });
        if (!offer) continue;
        const payload: SharedRideOfferPayload = {
          offerId: offer.offerId,
          sharedRideId: pool.rideId,
          ttlMs: OFFER_TTL_MS,
          expiresAt: offer.expiresAt.toISOString(),
          stops,
          passengerCount: pool.seatCount,
          waveNumber,
        };
        this.safely('ride_offer', () => this.bus.toDriver(driverId, 'ride_offer', payload));
      }
    }

    if (waveNumber === 1) await this.scheduleTimers(pool.rideId, 'pool', generation);
  }

  async handleWaveTimeout(job: Job<WaveTimeoutJob>): Promise<void> {
    const { rideId, kind, generation } = job.data;
    const waveNumber = job.data.waveNumber === 1 ? 1 : 2;

    if (kind === 'solo') {
      const ride = await this.ridesRepo.findById(rideId);
      // Already claimed / cancelled / no_driver / re-dispatched → stale no-op.
      if (!ride || ride.status !== 'requested' || ride.driverId) return;
      const g = generation ?? ride.dispatchGeneration;
      if (g !== ride.dispatchGeneration || g < 1) return;
      await this.runSoloWave(ride, waveNumber, g);
      return;
    }

    const pool = await this.repo.findById(rideId);
    if (!pool || pool.claimedByDriverId) return;
    if (!(CLAIMABLE_POOL_STATES as readonly string[]).includes(pool.poolState)) return;
    const g = generation ?? pool.dispatchGeneration;
    if (g !== pool.dispatchGeneration || g < 1) return;
    await this.runPoolWave(pool, waveNumber, g);
  }

  async handleHardFail(job: Job<HardFailJob>): Promise<void> {
    const { rideId, kind, generation } = job.data;

    if (kind === 'solo') {
      // One transaction (ride lock → no_driver → revoke live offers); a ride
      // claimed / cancelled / re-dispatched in the same instant is untouched.
      const failed = await this.ridesRepo.markNoDriver(rideId, generation);
      if (!failed) return;
      this.log.warn({ rideId }, 'dispatch hard-fail → no_driver (solo)');
      this.notifyRevoked({ kind: 'solo', rideId }, failed.revokedOffers, 'revoked');
      this.safely('ride_no_driver', () =>
        this.bus.toUser(failed.row.passengerId, 'ride_no_driver', { rideId }),
      );
      await this.removeTimers(rideId, failed.row.dispatchGeneration);
      return;
    }

    const trip: TripRef = { kind: 'shared', sharedRideId: rideId };
    const aborted = await this.db.transaction(async (tx) => {
      const pool = await this.assignments.lockSharedTrip(tx, rideId);
      if (!pool) return null;
      const g = generation ?? pool.dispatchGeneration;
      if (g !== pool.dispatchGeneration || g < 1) return null;
      // Members are released by the 0016 trigger in the same statement.
      if (!(await this.assignments.abortUnclaimedPool(tx, rideId, g))) return null;
      return { generation: g, revoked: await this.offers.revokeLiveForTrip(tx, trip) };
    });
    if (!aborted) return;
    this.log.warn({ rideId }, 'dispatch hard-fail → aborting pool');
    this.notifyRevoked(trip, aborted.revoked, 'revoked');
    await this.removeTimers(rideId, aborted.generation);
    // Phase-0: an aborted pool is terminal. Re-queueing each member as an
    // individual solo ride is a future enhancement (owner decision F-5).
  }

  /**
   * A solo ride was cancelled / marked no-show. The cancel transaction already
   * revoked its live offers and released any guard; this only drops the timers
   * so nothing fires on a terminal ride.
   */
  @OnEvent(RIDE_CANCELLED_EVENT, { async: true })
  async onRideCancelled(payload: RideCancelledEventPayload): Promise<void> {
    await this.releaseDispatch(payload.rideId, payload.generation);
  }

  /**
   * Post-commit cleanup only: remove the wave-2 + hard-fail timers (current
   * generation and legacy ids). Safe no-op when nothing is in flight; the
   * handlers' state + generation guards are the real protection.
   */
  async releaseDispatch(rideId: string, generation?: number): Promise<void> {
    let g = generation;
    if (g === undefined) {
      const ride = await this.ridesRepo.findById(rideId).catch(() => null);
      g = ride?.dispatchGeneration;
    }
    await this.removeTimers(rideId, g);
  }

  private async removeTimers(tripRef: string, generation: number | undefined): Promise<void> {
    const ids = [legacyWaveTwoJobId(tripRef), legacyHardFailJobId(tripRef)];
    if (generation !== undefined && generation >= 1) {
      ids.push(waveTwoJobId(tripRef, generation), hardFailJobId(tripRef, generation));
    }
    for (const id of ids) {
      await this.queue.remove(id).catch((err: unknown) => {
        this.log.warn({ err, jobId: id }, 'dispatch timer removal failed');
      });
    }
  }

  private async scheduleTimers(
    tripRef: string,
    kind: 'solo' | 'pool',
    generation: number,
  ): Promise<void> {
    await this.queue.add(
      WAVE_TIMEOUT_JOB,
      { rideId: tripRef, waveNumber: 2, kind, generation } satisfies WaveTimeoutJob,
      {
        jobId: waveTwoJobId(tripRef, generation),
        delay: this.params.waveOneTimeoutMs,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    await this.queue.add(
      HARD_FAIL_JOB,
      { rideId: tripRef, kind, generation } satisfies HardFailJob,
      {
        jobId: hardFailJobId(tripRef, generation),
        delay: this.params.hardFailMs,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  private waveParams(waveNumber: 1 | 2): { k: number; radiusMeters: number } {
    return waveNumber === 1
      ? { k: this.params.k1, radiusMeters: this.params.r1Meters }
      : { k: this.params.k2, radiusMeters: this.params.r2Meters };
  }

  /**
   * Nearest drivers from the advisory geo index, minus those already offered
   * this trip generation, filtered by Postgres eligibility (active driver, no
   * active assignment, no live offer, vehicle capacity). The accept
   * transaction stays authoritative against stale candidates.
   */
  private async selectCandidates(
    trip: TripRef,
    generation: number,
    originLat: number,
    originLng: number,
    opts: { k: number; radiusMeters: number; seatsNeeded: number },
  ): Promise<string[]> {
    const offered = new Set(await this.offers.offeredDriverIds(this.db, trip, generation));
    const raw = (await this.redis.georadius(
      'active_drivers',
      originLng,
      originLat,
      opts.radiusMeters,
      'm',
      'ASC',
      'COUNT',
      opts.k * CANDIDATE_HEADROOM + offered.size,
    )) as string[];
    const fresh = raw.filter((id) => !offered.has(id));
    const eligible = await this.offers.eligibleCandidates(this.db, fresh, opts.seatsNeeded);
    return eligible.slice(0, opts.k);
  }

  /** A delivery failure after commit is logged, never surfaced as a failed command. */
  private safely(what: string, emit: () => void): void {
    try {
      emit();
    } catch (err) {
      this.log.warn({ err, what }, 'post-commit realtime delivery failed');
    }
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function computeStops(pool: SharedRideRow): OfferStop[] {
  const pickups = sortPickupsByDistance(pool.members, pool.originLng, pool.originLat);
  // Dropoffs follow nearest-neighbour from the last pickup: the driver heads to
  // the closest remaining destination each time instead of driving to the one
  // nearest the anchor's destination first and backtracking.
  const last = pickups[pickups.length - 1];
  const dropoffs = last
    ? orderDropoffsNearestNeighbour(pickups, last.origin_lat, last.origin_lng)
    : [];

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

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLam = ((lng2 - lng1) * Math.PI) / 180;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Deterministic tie-break so equal distances never depend on input order.
function byPassengerId(a: SharedRideMember, b: SharedRideMember): number {
  return a.passenger_id < b.passenger_id ? -1 : a.passenger_id > b.passenger_id ? 1 : 0;
}

function sortPickupsByDistance(
  members: SharedRideMember[],
  refLng: number,
  refLat: number,
): SharedRideMember[] {
  return [...members].sort((a, b) => {
    const da = haversineM(refLat, refLng, a.origin_lat, a.origin_lng);
    const db = haversineM(refLat, refLng, b.origin_lat, b.origin_lng);
    return da - db || byPassengerId(a, b);
  });
}

// Greedy nearest-neighbour over the members' destinations, starting from the
// last pickup (F16 follow-up).
function orderDropoffsNearestNeighbour(
  members: SharedRideMember[],
  startLat: number,
  startLng: number,
): SharedRideMember[] {
  const remaining = [...members].sort(byPassengerId);
  const ordered: SharedRideMember[] = [];
  let curLat = startLat;
  let curLng = startLng;
  while (remaining.length > 0) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineM(curLat, curLng, remaining[i].dest_lat, remaining[i].dest_lng);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const [next] = remaining.splice(best, 1);
    ordered.push(next);
    curLat = next.dest_lat;
    curLng = next.dest_lng;
  }
  return ordered;
}
