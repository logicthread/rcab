import { Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../infra/db/drizzle.module';
import { rides } from '../../db/schema';
import { recordDispatchOutcome } from '../../metrics';
import { enqueueOutbox } from '../outbox/outbox.writer';
import { OutboxTopic } from '../outbox/outbox.types';
import { DispatchOfferRepository } from './offer.repository';

/**
 * Matching rounds for a normal (immediate) ride. One round is one dispatch
 * generation: wave 1, wave 2, hard-fail. When a round's window closes with no
 * driver and fewer than `rounds` rounds have run, the ride stays `requested` and
 * a NEW generation starts (wave 1 again, every driver offer-able once more);
 * only the last round ends the ride as `no_driver`. The generation number is the
 * round number (a normal ride starts at generation 1).
 */

const log = new Logger('NormalRounds');
const offers = new DispatchOfferRepository();

export interface NormalRoundRearmed {
  rideId: string;
  /** Generation (round) whose window just closed. */
  previousGeneration: number;
  /** The new generation == the round now starting (its dispatch intent is in the outbox). */
  generation: number;
  /** Live offers revoked by the re-arm; their drivers must be told after commit. */
  revokedOffers: Array<{ offerId: string; driverId: string }>;
}

/**
 * Start the next round in ONE transaction: lock the ride (cancel / accept take
 * the same lock first), require a still-unassigned `requested` normal ride at
 * `expectedGeneration` with a round left, bump the generation, revoke the closed
 * round's live offers and write the dispatch intent for the new generation.
 * Returns null when there is nothing to re-arm (cancelled, claimed, stale, or the
 * last round was already played), in which case the caller ends the ride.
 */
export async function rearmNormalRide(
  db: DrizzleDb,
  rideId: string,
  expectedGeneration: number | undefined,
  rounds: number,
): Promise<NormalRoundRearmed | null> {
  const result = await db.transaction(async (tx) => {
    const [ride] = await tx.select().from(rides).where(eq(rides.id, rideId)).for('update').limit(1);
    if (!ride || ride.type !== 'normal' || ride.status !== 'requested' || ride.driverId) return null;
    if (ride.dispatchGeneration < 1 || ride.dispatchGeneration >= rounds) return null;
    if (expectedGeneration !== undefined && expectedGeneration !== ride.dispatchGeneration) return null;

    const previousGeneration = ride.dispatchGeneration;
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
    return { rideId, previousGeneration, generation, revokedOffers } satisfies NormalRoundRearmed;
  });
  if (result) {
    recordDispatchOutcome('round_retry', 'solo');
    log.warn(
      { rideId, round: result.generation, rounds },
      'normal ride had no driver this round; restarting matching',
    );
  }
  return result;
}
