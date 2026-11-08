import { getPolicy, type Policy } from '../../config/policy/policy';

/**
 * PHASE-0 STAND-IN shared fare policy (F15 fare half, R10).
 *
 * `fixed_at_join`: each passenger's per-seat fare is quoted ONCE, at the moment
 * of seat allocation, from an unlocked snapshot of the pool (seat count AFTER
 * this join, ordered multi-stop itinerary including this passenger) that the
 * join transaction re-validates under the pool lock before persisting it
 * (optimistic: re-quote on concurrent change, `matching.joinPriceRetries`). It
 * is persisted on the member (`pool_member.agreed_fare_cents`) and returned in the create response. It is never readjusted: later joins do
 * not change an earlier member's fare (so a pool growing from 2 to 3 seats does
 * not refund or re-discount the first two passengers). A pricing failure fails
 * the join; a seat is never committed without its fare.
 *
 * RCAB-E8.S9 ("Shared fare readjustment policy") replaces this constant with a
 * real policy (discount as the pool grows, refunds/adjustments, member
 * cancellation, settlement record). Grep for SHARED_FARE_POLICY to find every
 * place that encodes the stand-in.
 */
export type SharedFarePolicy = Policy['pricing']['sharedFarePolicy'];

/** Code-fixed knob `pricing.sharedFarePolicy` (see config/policy/policy.schema.ts). */
export const SHARED_FARE_POLICY: SharedFarePolicy = getPolicy().pricing.sharedFarePolicy;
