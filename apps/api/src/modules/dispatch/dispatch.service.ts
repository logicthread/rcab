import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { POLICY, type Policy } from '../../config/policy/policy';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import { sql } from 'drizzle-orm';
import { Queue, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS } from '../../infra/redis/redis.module';
import { DRIZZLE_DB, type DrizzleDb, type DrizzleTx } from '../../infra/db/drizzle.module';
import { RealtimeBus } from '../realtime/realtime.bus';
import { RealtimeSnapshotService } from '../realtime/realtime-snapshot.service';
import {
  RIDE_OFFER_OUTCOME,
  outcomeForAcceptFailure,
  rideStatusVersion,
  type OfferOutcome,
  type RideOfferOutcomePayload,
} from '../realtime/realtime.protocol';
import {
  RIDE_OFFER_RESPONSE_EVENT,
  type RideOfferResponseEvent,
} from '../realtime/realtime.gateway';
import { SharedRideRepository, type SharedRideRow } from '../matching/shared-ride.repository';
import { RideStopRepository } from '../matching/ride-stop.repository';
import { PoolProjectionService } from '../matching/pool-projection.service';
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
  observeDispatchLatency,
  recordDispatchOutcome,
  recordRideTransition,
  type TripKindLabel,
} from '../../metrics';
import { OutboxTopic, outboxDedupeKey } from '../outbox/outbox.types';
import { rearmScheduledRide, type ScheduledRetryOptions } from '../scheduled/scheduled-retry';
import { scheduledWindowFromPolicy, type ScheduledDispatchWindow } from '../scheduled/scheduled-window';
import {
  wave2JobId as waveTwoJobId,
  hardFailJobId,
  legacyWave2JobId as legacyWaveTwoJobId,
  legacyHardFailJobId,
} from '../outbox/outbox.jobs';
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

// Timer job ids are owned by the dependency-free outbox.jobs module so the
// dispatch service, the reconciler and the relay can never drift apart
// (generation-scoped, colon-free: contract §1.3 rule 7). Re-exported under the
// dispatch-side names.
export {
  wave2JobId as waveTwoJobId,
  hardFailJobId,
  legacyWave2JobId as legacyWaveTwoJobId,
  legacyHardFailJobId,
} from '../outbox/outbox.jobs';

interface DispatchParams {
  k1: number;
  k2: number;
  r1Meters: number;
  r2Meters: number;
  waveOneTimeoutMs: number;
  hardFailMs: number;
  /** Live offer lifetime. The authoritative deadline is `dispatch_offer.expires_at`. */
  offerTtlMs: number;
  /** Geo-index over-fetch so ineligible / already-offered drivers do not starve a wave. */
  candidateHeadroom: number;
  /** Window for scheduled rides (RCAB-E8.S8): 4 min by default, see scheduled-window.ts. */
  scheduled: ScheduledDispatchWindow;
  /** Scheduled retry cutoff (RCAB-E8.S13), see scheduled-retry.ts. */
  scheduledRetry: ScheduledRetryOptions;
}

/** What the accept transaction decided, plus what to tell people after commit. */
interface AcceptOutcome {
  result: AcceptOfferResult;
  revoked: RevokedOffer[];
  /** When the accepted offer was created (DB clock); absent on a rejection. */
  offeredAt?: Date;
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
    @Inject(POLICY) policy: Policy,
    private readonly poolProjection: PoolProjectionService,
    // R09: Postgres snapshots for the post-commit outcome / pool broadcasts.
    // Optional so a harness without realtime still builds the service.
    @Optional() private readonly snapshots?: RealtimeSnapshotService,
  ) {
    const d = policy.dispatch;
    this.params = {
      k1: d.k1,
      k2: d.k2,
      r1Meters: d.r1Meters,
      r2Meters: d.r2Meters,
      waveOneTimeoutMs: d.waveOneTimeoutMs,
      hardFailMs: d.hardFailMs,
      offerTtlMs: d.offerTtlMs,
      candidateHeadroom: d.candidateHeadroom,
      scheduled: scheduledWindowFromPolicy(policy),
      scheduledRetry: { cutoffAfterPickupMs: policy.scheduled.retryCutoffAfterPickupMs },
    };
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
      this.recordAccepted(result, outcome.offeredAt);
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
    return {
      result: { ok: true, trip, generation: offer.generation, replay: false },
      revoked,
      offeredAt: offer.offeredAt,
    };
  }

  /**
   * Business metrics for a COMMITTED accept (strictly after the transaction;
   * a replay of an earlier commit is not counted again).
   */
  private recordAccepted(
    result: Extract<AcceptOfferResult, { ok: true }>,
    offeredAt: Date | undefined,
  ): void {
    if (result.replay) return;
    const kind: TripKindLabel = result.trip.kind === 'solo' ? 'solo' : 'pool';
    recordDispatchOutcome('assigned', kind);
    if (result.trip.kind === 'solo') recordRideTransition('requested', 'accepted');
    if (offeredAt) observeDispatchLatency('offer_to_accept', kind, (Date.now() - offeredAt.getTime()) / 1000);
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
    // The `pool:<id>` hash is a projection of the committed claim (F09).
    if (result.trip.kind === 'shared') await this.projectPool(id);

    this.safely('ride_offer_accepted', () =>
      this.bus.toDriver(driverId, 'ride_offer_accepted', {
        offerId,
        rideId: id,
        ...(result.trip.kind === 'shared' ? { sharedRideId: id } : {}),
      }),
    );
    // R09: the explicit positive acknowledgement, carrying the committed
    // assignment (itinerary for shared) so the driver never infers "assigned"
    // from having received an offer. Replays re-send it (lost-ack recovery).
    const assignment = await this.assignmentView(driverId, id);
    this.emitOutcome(driverId, {
      offerId,
      outcome: 'assigned',
      tripKind: result.trip.kind,
      tripId: id,
      generation: result.generation,
      assignment,
    });
    if (result.replay) return;
    this.notifyRevoked(result.trip, revoked, 'taken');
    if (result.trip.kind === 'solo') {
      // Passengers follow `ride:<id>` via an authorized `ride:subscribe`.
      this.safely('ride_state_changed', () =>
        this.bus.toRide(id, 'ride_state_changed', {
          rideId: id,
          state: 'accepted',
          by: 'driver',
          version: rideStatusVersion('accepted'),
        }),
      );
    } else {
      // Members learn the committed claim (versioned) on `pool:<id>`.
      await this.snapshots?.publishPoolUpdate(id);
    }
  }

  /** The committed assignment for the outcome payload; null when unreadable. */
  private async assignmentView(
    driverId: string,
    tripRef: string,
  ): Promise<RideOfferOutcomePayload['assignment']> {
    if (!this.snapshots) return undefined;
    try {
      const snap = await this.snapshots.driverAssignment(driverId);
      return snap.assignment && snap.assignment.tripId === tripRef ? snap.assignment : null;
    } catch (err) {
      this.log.warn({ err, driverId }, 'assignment snapshot for outcome failed');
      return null;
    }
  }

  private emitOutcome(driverId: string, payload: RideOfferOutcomePayload): void {
    this.safely(RIDE_OFFER_OUTCOME, () => this.bus.toDriver(driverId, RIDE_OFFER_OUTCOME, payload));
  }

  /** Best-effort `pool:<id>` projection refresh; boot / next write repairs a miss. */
  private async projectPool(poolId: string): Promise<void> {
    try {
      await this.poolProjection.project(poolId);
    } catch (err) {
      this.log.warn({ err, poolId }, 'pool projection failed; rebuild will repair');
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
    this.emitOutcome(driverId, {
      offerId,
      outcome: outcomeForAcceptFailure(reason),
      ...(trip ? { tripKind: trip.kind, tripId: tripId(trip) } : {}),
      reason,
    });
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
      // The winner's offer is never in `revoked` (revokeLiveForTrip excludes it).
      const outcome: OfferOutcome = reason === 'taken' ? 'lost' : 'revoked';
      this.emitOutcome(r.driverId, {
        offerId: r.offerId,
        outcome,
        tripKind: trip.kind,
        tripId: id,
        reason,
      });
    }
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
    const { drivers: candidates, priorOffers } = await this.selectCandidates(
      trip,
      generation,
      ride.originLat,
      ride.originLng,
      { k, radiusMeters, seatsNeeded: 1 },
    );
    if (candidates.length === 0) {
      this.log.warn(
        { rideId: ride.id, waveNumber, radiusMeters },
        'no fresh candidates this wave (solo)',
      );
    }

    let created = 0;
    for (const driverId of candidates) {
      const offer = await this.offers.createOffer(this.db, {
        trip,
        driverId,
        generation,
        waveNumber,
        ttlMs: this.params.offerTtlMs,
      });
      if (!offer) continue;
      created++;
      const payload: SoloRideOfferPayload = {
        offerId: offer.offerId,
        rideId: ride.id,
        ttlMs: this.params.offerTtlMs,
        expiresAt: offer.expiresAt.toISOString(),
        pickup: { lat: ride.originLat, lng: ride.originLng },
        dropoff: { lat: ride.destLat, lng: ride.destLng },
        fareCents: ride.fareCents,
        waveNumber,
      };
      this.safely('ride_offer', () => this.bus.toDriver(driverId, 'ride_offer', payload));
    }

    if (waveNumber === 1 && priorOffers === 0 && created > 0) {
      await this.observeIntentToFirstOffer(trip, generation, 'solo');
    }
    if (waveNumber === 1) {
      await this.scheduleTimers(ride.id, 'solo', generation, ride.type === 'scheduled');
    }
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
      const { drivers: candidates, priorOffers } = await this.selectCandidates(
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
      let created = 0;
      for (const driverId of candidates) {
        const offer = await this.offers.createOffer(this.db, {
          trip,
          driverId,
          generation,
          waveNumber,
          ttlMs: this.params.offerTtlMs,
        });
        if (!offer) continue;
        created++;
        const payload: SharedRideOfferPayload = {
          offerId: offer.offerId,
          sharedRideId: pool.rideId,
          ttlMs: this.params.offerTtlMs,
          expiresAt: offer.expiresAt.toISOString(),
          stops,
          passengerCount: pool.seatCount,
          waveNumber,
        };
        this.safely('ride_offer', () => this.bus.toDriver(driverId, 'ride_offer', payload));
      }
      if (waveNumber === 1 && priorOffers === 0 && created > 0) {
        await this.observeIntentToFirstOffer(trip, generation, 'pool');
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
      // A scheduled ride whose window closed with no driver is RETRIED under a
      // new generation, never expired (RCAB-E8.S8; see scheduled-retry.ts).
      const current = await this.ridesRepo.findById(rideId);
      if (current?.type === 'scheduled') {
        await this.retryScheduledRide(rideId, generation);
        return;
      }
      // One transaction (ride lock → no_driver → revoke live offers); a ride
      // claimed / cancelled / re-dispatched in the same instant is untouched.
      const failed = await this.ridesRepo.markNoDriver(rideId, generation);
      if (!failed) return;
      this.log.warn({ rideId }, 'dispatch hard-fail → no_driver (solo)');
      this.notifyRevoked({ kind: 'solo', rideId }, failed.revokedOffers, 'revoked');
      this.safely('ride_no_driver', () =>
        this.bus.toUser(failed.row.passengerId, 'ride_no_driver', { rideId }),
      );
      this.safely('ride_state_changed', () =>
        this.bus.toRide(rideId, 'ride_state_changed', {
          rideId,
          state: 'no_driver',
          by: 'system',
          version: rideStatusVersion('no_driver'),
        }),
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
    recordDispatchOutcome('pool_aborted', 'pool');
    this.log.warn({ rideId }, 'dispatch hard-fail → aborting pool');
    this.notifyRevoked(trip, aborted.revoked, 'revoked');
    await this.removeTimers(rideId, aborted.generation);
    await this.projectPool(rideId);
    // Members see the terminal `aborted` (versioned) instead of a silent pool.
    await this.snapshots?.publishPoolUpdate(rideId);
    // Phase-0: an aborted pool is terminal. Re-queueing each member as an
    // individual solo ride is a future enhancement (owner decision F-5).
  }

  /**
   * The scheduled window closed with no acceptance: re-arm under a new
   * generation (one transaction, outbox intent for the relay) and clean up after
   * commit. The passenger hears about it on the first re-arm only.
   */
  private async retryScheduledRide(rideId: string, generation: number | undefined): Promise<void> {
    const retried = await rearmScheduledRide(this.db, rideId, generation, this.params.scheduledRetry);
    if (!retried) return;
    if (retried.outcome === 'no_driver') {
      // Past the retry cutoff: the ride ended as no_driver in the same
      // transaction. Same passenger-facing tail as a normal ride's no_driver.
      await this.afterScheduledNoDriver(rideId, retried.passengerId, retried.revokedOffers, retried.generation);
      return;
    }
    this.notifyRevoked({ kind: 'solo', rideId }, retried.revokedOffers, 'revoked');
    if (retried.firstRetry) {
      this.safely('ride_dispatch_retry', () =>
        this.bus.toUser(retried.passengerId, 'ride_dispatch_retry', {
          rideId,
          retryCount: retried.retryCount,
          retryUntil: retried.retryUntil.toISOString(),
        }),
      );
    }
    await this.removeTimers(rideId, retried.previousGeneration);
  }

  /**
   * Post-commit tail of a scheduled ride that ended `no_driver` at its retry
   * cutoff. Mirrors the normal hard-fail tail above (same events, same payloads):
   * revoke the live offers on the drivers' side, tell the passenger and the ride
   * room, drop the timers.
   */
  private async afterScheduledNoDriver(
    rideId: string,
    passengerId: string,
    revokedOffers: RevokedOffer[],
    generation: number,
  ): Promise<void> {
    this.notifyRevoked({ kind: 'solo', rideId }, revokedOffers, 'revoked');
    this.safely('ride_no_driver', () => this.bus.toUser(passengerId, 'ride_no_driver', { rideId }));
    this.safely('ride_state_changed', () =>
      this.bus.toRide(rideId, 'ride_state_changed', {
        rideId,
        state: 'no_driver',
        by: 'system',
        version: rideStatusVersion('no_driver'),
      }),
    );
    await this.removeTimers(rideId, generation);
  }

  /**
   * Notify + clean up after the reconciler ended a scheduled ride past its retry
   * cutoff (the DB transition already committed in `rearmScheduledRide`).
   */
  async onScheduledNoDriver(ended: {
    rideId: string;
    passengerId: string;
    generation: number;
    revokedOffers: RevokedOffer[];
  }): Promise<void> {
    await this.afterScheduledNoDriver(ended.rideId, ended.passengerId, ended.revokedOffers, ended.generation);
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
    scheduled = false,
  ): Promise<void> {
    const { waveOneTimeoutMs, hardFailMs } = scheduled
      ? { waveOneTimeoutMs: this.params.scheduled.waveOneMs, hardFailMs: this.params.scheduled.hardFailMs }
      : this.params;
    await this.queue.add(
      WAVE_TIMEOUT_JOB,
      { rideId: tripRef, waveNumber: 2, kind, generation } satisfies WaveTimeoutJob,
      {
        jobId: waveTwoJobId(tripRef, generation),
        delay: waveOneTimeoutMs,
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    await this.queue.add(
      HARD_FAIL_JOB,
      { rideId: tripRef, kind, generation } satisfies HardFailJob,
      {
        jobId: hardFailJobId(tripRef, generation),
        delay: hardFailMs,
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
  ): Promise<{ drivers: string[]; priorOffers: number }> {
    const offered = new Set(await this.offers.offeredDriverIds(this.db, trip, generation));
    const raw = (await this.redis.georadius(
      'active_drivers',
      originLng,
      originLat,
      opts.radiusMeters,
      'm',
      'ASC',
      'COUNT',
      opts.k * this.params.candidateHeadroom + offered.size,
    )) as string[];
    const fresh = raw.filter((id) => !offered.has(id));
    const eligible = await this.offers.eligibleCandidates(this.db, fresh, opts.seatsNeeded);
    return { drivers: eligible.slice(0, opts.k), priorOffers: offered.size };
  }

  /**
   * `dispatch latency, intent to first offer`: the durable dispatch intent
   * (outbox row of this generation) to the first offer of the generation having
   * committed, on the DB clock. Includes relay and queue delay by design. A
   * generation with no intent row (a scheduled ride's first wake) is skipped.
   * Observability must never fail dispatch, so every error is swallowed.
   */
  private async observeIntentToFirstOffer(
    trip: TripRef,
    generation: number,
    kind: TripKindLabel,
  ): Promise<void> {
    try {
      const key =
        trip.kind === 'solo'
          ? outboxDedupeKey(OutboxTopic.RideDispatchRequested, trip.rideId, generation)
          : outboxDedupeKey(OutboxTopic.PoolDispatchRequested, trip.sharedRideId, generation);
      const res = await this.db.execute<{ age_s: string }>(sql`
        SELECT extract(epoch FROM clock_timestamp() - created_at) AS age_s
          FROM outbox WHERE dedupe_key = ${key}`);
      const age = res.rows[0]?.age_s;
      if (age !== undefined) observeDispatchLatency('intent_to_first_offer', kind, Number(age));
    } catch (err) {
      this.log.debug({ err }, 'dispatch latency observation skipped');
    }
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
// The itinerary helpers moved to matching/itinerary.ts (Stage C / R08): stops are
// computed once at pool closure and persisted to ride_stops. Re-exported here
// for existing importers.
import { computeStops } from '../matching/itinerary';
export { computeStops };
