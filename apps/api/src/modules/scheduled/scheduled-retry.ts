import { Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../infra/db/drizzle.module';
import { rides } from '../../db/schema';
import { dispatchOutcome } from '../../metrics';
import { DispatchOfferRepository } from '../dispatch/offer.repository';
import { enqueueOutbox } from '../outbox/outbox.writer';
import { OutboxTopic } from '../outbox/outbox.types';
import { scheduledRetryUntil } from './scheduled-window';

/**
 * Retry policy for scheduled rides that never got a driver (RCAB-E8.S8, owner
 * decision: RETRY; RCAB-E8.S13: bounded by a cutoff after the pickup time).
 *
 * A normal ride whose window closes with no acceptance becomes `no_driver`. A
 * scheduled ride is booked for a future pickup, so an empty window is not a
 * verdict: the ride stays `requested` and is re-armed under a NEW dispatch
 * generation with a fresh window. There is no retry COUNT cap, but retrying
 * stops once `now > scheduled_for + scheduled.retryCutoffAfterPickupMs`
 * (default 30 min, env `SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS`): the window
 * that closes after that moment ends the ride as `no_driver` (same terminal
 * state as a normal ride) instead of re-arming. Before that the ride leaves the
 * loop only by being accepted or cancelled. The retry count is observable as
 * `dispatch_generation - 1` (the wake is generation 1), logged on every re-arm
 * and counted in `rcab_dispatch_outcome_total{outcome="scheduled_retry"}`; the
 * cutoff end is counted as `outcome="scheduled_no_driver"`.
 *
 * Passenger notification policy (one per re-arm at most): the caller tells the
 * passenger only on the FIRST re-arm (`firstRetry`); later windows retry
 * silently so an unattended ride cannot spam the passenger every 4 minutes.
 */

const log = new Logger('ScheduledRetry');
const offers = new DispatchOfferRepository();

export interface ScheduledRetryResult {
  outcome: 'rearmed';
  rideId: string;
  passengerId: string;
  /** Generation whose window just closed. */
  previousGeneration: number;
  /** The new generation (its `ride.dispatch.requested` intent is in the outbox). */
  generation: number;
  /** 1 for the first re-arm, 2 for the second, ... (== generation - 1). */
  retryCount: number;
  firstRetry: boolean;
  /** When retrying stops (scheduled_for + cutoff); sent to the passenger so the UI can say "until <time>". */
  retryUntil: Date;
  /** Live offers revoked by the re-arm; their drivers must be told after commit. */
  revokedOffers: Array<{ offerId: string; driverId: string }>;
}

/** The retry cutoff passed: the ride was ended as `no_driver` in the same transaction. */
export interface ScheduledNoDriverResult {
  outcome: 'no_driver';
  rideId: string;
  passengerId: string;
  /** The generation whose window just closed (and which was ended). */
  generation: number;
  retryUntil: Date;
  /** Live offers revoked by the termination; their drivers must be told after commit. */
  revokedOffers: Array<{ offerId: string; driverId: string }>;
}

export interface ScheduledRetryOptions {
  /** `scheduled.retryCutoffAfterPickupMs` from the policy. */
  cutoffAfterPickupMs: number;
  /** Clock override for tests (epoch ms). Defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * Re-arm a scheduled ride whose current generation's window closed. ONE
 * transaction: lock the ride (the cancel and accept paths take the same lock
 * first, so exactly one of them wins), require a still-unassigned `requested`
 * scheduled ride at `expectedGeneration` (omitted, for a legacy hard-fail job,
 * means "current"), bump the generation, revoke the old generation's live
 * offers and write the `ride.dispatch.requested` outbox intent for the new
 * generation. The relay publishes it; `DispatchStartService.startSolo` then
 * runs wave 1, which arms the fresh window.
 *
 * Once the retry cutoff has passed (`now > scheduled_for + cutoffAfterPickupMs`,
 * judged after the lock is held) the same transaction instead moves the ride to
 * `no_driver` and revokes its live offers, so cancel / accept / cutoff are
 * mutually exclusive by the one row lock. The caller notifies the passenger.
 *
 * Returns null when there is nothing to retry (cancelled, claimed, not
 * scheduled, not yet woken, or a stale generation), so calling it twice for the
 * same window re-arms (or ends) once.
 */
export async function rearmScheduledRide(
  db: DrizzleDb,
  rideId: string,
  expectedGeneration: number | undefined,
  opts: ScheduledRetryOptions,
): Promise<ScheduledRetryResult | ScheduledNoDriverResult | null> {
  const result = await db.transaction(async (tx) => {
    const [ride] = await tx.select().from(rides).where(eq(rides.id, rideId)).for('update').limit(1);
    if (!ride || ride.type !== 'scheduled' || ride.status !== 'requested' || ride.driverId) {
      return null;
    }
    // generation 0 = not woken yet; the wake path owns that transition.
    if (ride.dispatchGeneration < 1) return null;
    if (expectedGeneration !== undefined && expectedGeneration !== ride.dispatchGeneration) {
      return null;
    }

    const previousGeneration = ride.dispatchGeneration;
    // A scheduled ride always has scheduled_for; if a corrupt row lacks it, fall
    // back to the epoch so it can only be ended, never retried forever.
    const retryUntil = scheduledRetryUntil(ride.scheduledFor ?? new Date(0), opts.cutoffAfterPickupMs);
    if ((opts.nowMs ?? Date.now()) > retryUntil.getTime()) {
      await tx
        .update(rides)
        .set({ status: 'no_driver', updatedAt: sql`now()` })
        .where(and(eq(rides.id, rideId), eq(rides.dispatchGeneration, previousGeneration)));
      const revokedOffers = await offers.revokeLiveForTrip(tx, { kind: 'solo', rideId });
      return {
        outcome: 'no_driver',
        rideId,
        passengerId: ride.passengerId,
        generation: previousGeneration,
        retryUntil,
        revokedOffers,
      } satisfies ScheduledNoDriverResult;
    }
    const generation = previousGeneration + 1;
    await tx
      .update(rides)
      .set({ dispatchGeneration: generation, updatedAt: sql`now()` })
      .where(and(eq(rides.id, rideId), eq(rides.dispatchGeneration, previousGeneration)));
    const revokedOffers = await offers.revokeLiveForTrip(tx, { kind: 'solo', rideId });
    await enqueueOutbox(tx, {
      topic: OutboxTopic.RideDispatchRequested,
      aggregateType: 'ride',
      aggregateId: rideId,
      generation,
      payload: { rideId },
    });
    return {
      outcome: 'rearmed',
      rideId,
      passengerId: ride.passengerId,
      previousGeneration,
      generation,
      retryCount: generation - 1,
      firstRetry: generation === 2,
      retryUntil,
      revokedOffers,
    } satisfies ScheduledRetryResult;
  });
  if (result?.outcome === 'no_driver') {
    dispatchOutcome.inc({ outcome: 'scheduled_no_driver' });
    log.warn(
      { rideId, generation: result.generation, retryUntil: result.retryUntil.toISOString() },
      'scheduled ride unanswered past its retry cutoff; ended as no_driver',
    );
  } else if (result) {
    dispatchOutcome.inc({ outcome: 'scheduled_retry' });
    log.warn(
      { rideId, generation: result.generation, retryCount: result.retryCount },
      'scheduled ride had no driver this window; re-armed with a fresh window',
    );
  }
  return result;
}
