/**
 * PHASE-0 STAND-IN shared fare policy (F15 fare half, R10).
 *
 * `fixed_at_join`: each passenger's per-seat fare is quoted ONCE, at the moment
 * of seat allocation, inside the join transaction, from the locked pool state
 * (seat count AFTER this join) and the ordered multi-stop itinerary including
 * this passenger. It is persisted on the member (`pool_member.agreed_fare_cents`)
 * and returned in the create response. It is never readjusted: later joins do
 * not change an earlier member's fare (so a pool growing from 2 to 3 seats does
 * not refund or re-discount the first two passengers). A pricing failure fails
 * the join; a seat is never committed without its fare.
 *
 * RCAB-E8.S9 ("Shared fare readjustment policy") replaces this constant with a
 * real policy (discount as the pool grows, refunds/adjustments, member
 * cancellation, settlement record). Grep for SHARED_FARE_POLICY to find every
 * place that encodes the stand-in.
 */
export const SHARED_FARE_POLICY = 'fixed_at_join' as const;

export type SharedFarePolicy = typeof SHARED_FARE_POLICY;
