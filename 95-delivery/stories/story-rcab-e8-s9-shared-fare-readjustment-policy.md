---
title: RCAB-E8.S9 — Shared fare readjustment policy
tags: [layer/delivery, kind/story]
status: draft
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S9
demo: 7
estimate: m
hitl: yes
depends_on: [[story-rcab-e8-s8-review-remediation-stage-c]]
blocks:
affected_notes: [[features-shared-rides]], [[module-matching]], [[module-rides]], [[algo-shared-ride-matching]], [[entity-shared-ride]]
owner: both
audience: both
---

# RCAB-E8.S9 — Shared fare readjustment policy

## Goal

Replace the Phase-0 **stand-in** shared fare policy with a real, owner-approved one. Today (RCAB-E8.S8, review finding F15 fare half, guide R10) each passenger's shared fare is **fixed at join** and never readjusted. That made the fare explainable and reproducible (no seat without a persisted price) but it is deliberately not the final business rule: it ignores that a pool getting fuller should plausibly make everyone's ride cheaper, and it has no answer for refunds, a member leaving, or a settlement record. This story decides those rules and implements them. A pricing owner decision is required before it can be marked `ready`.

## Current behaviour (the stand-in being replaced)

- Code constant `SHARED_FARE_POLICY = 'fixed_at_join'` in `apps/api/src/modules/pricing/shared-fare-policy.ts`. Grep for it to find every place the stand-in is encoded; this story removes/replaces it.
- A passenger's per-seat fare is quoted **once**, at seat allocation, **inside the join transaction**, from the locked pool state: the seat count *after* this join (multiplier 1 seat = 1.0, 2 = `SEAT_MULTIPLIER_2`, 3+ = `SEAT_MULTIPLIER_3`) and the **ordered multi-stop itinerary including that passenger** (`matching/itinerary.ts` `computeStops`). Detour = the passenger's own routed ride along the itinerary (pickup stop to dropoff stop, through intermediate stops) over their direct routed distance, clamped so a seat never costs more than solo.
- Persisted per member in `pool_member.agreed_fare_cents` (integer paise, migration `0017_pool_member_agreed_fare.sql`); NOT NULL for new members and **immutable** once set (DB trigger `pool_member_agreed_fare_guard`). Returned as `perSeatPrice` (+ `farePolicy: 'fixed_at_join'`) in the shared create response; a pricing/routing failure fails the booking (503), never a seat with an absent price.
- Earlier members **keep** their agreed fare when more members join. The first passenger pays the 1-seat price even if the pool later fills to 3; the third pays the 3-seat price. There is no refund, no adjustment, and no settlement record beyond the stored agreed fare.

## Open product questions (must be answered before `ready`)

1. **Discount as the pool grows.** Should earlier members benefit when later members join (e.g. everyone converges to the final seat-count multiplier), or is the join-time price final? If they benefit, is it a refund after completion, a lower final charge, or a credit? Is there a floor?
2. **Refunds / adjustment.** If the final fare is lower than the agreed fare, who is refunded and how (cash rides: driver gives change? platform credit?). If the itinerary changes so a passenger's route is materially longer than agreed, may the fare go up at all, or does the passenger get a maximum guarantee (the agreed fare as a cap)? When is renewed consent required (R10: "reprice / obtain renewed consent when an itinerary change exceeds that agreement")?
3. **Cancellation of a member.** If a member cancels or no-shows after others joined: do the remaining members' fares change, does the leaver pay anything (Phase-0 currently has no cancel fee), and what happens to a pool that drops to one passenger (priced as solo?).
4. **Settlement record.** What authoritative record backs the amount actually collected per passenger and the driver payout (`PricingService.driverPayout`, `PLATFORM_COMMISSION_RATE`)? Fare agreement, receipt and history must read the same stored data, not recompute with today's tariff. Does the record carry tariff/quote version, route/itinerary version and routing inputs, as R10 asks?
5. **When does the fare lock?** At join (today), at pool close, or at trip start? What does the passenger see before and after?

## User-facing acceptance criteria (to be rewritten once the policy is decided)

- Given a passenger who joined a pool at agreed fare F, When more members join, Then the system applies the decided policy (unchanged / discounted / credited) and the passenger can see both the agreed fare and the final fare.
- Given a member cancels, Then the remaining members' fares follow the decided rule and every change is explainable from stored data.
- Given a completed shared ride, Then a settlement record per passenger (agreed, final, adjustment, currency/unit, tariff/quote version) exists and matches what the driver collected.

## Technical acceptance criteria (draft)

- `SHARED_FARE_POLICY` stand-in is removed or replaced by a versioned policy; no code path still assumes "fixed at join".
- Migration revises `pool_member_agreed_fare_guard` (it currently forbids any change to `agreed_fare_cents`) and adds the settlement/adjustment storage decided above; fare units remain integer paise.
- The fare is still computed in the same transaction as the membership change, from locked pool state, and any adjustment commits atomically with the event that caused it (join, leave, close).
- Client surfaces (web booking, driver app earnings) show the agreed fare and any adjustment.

## Test plan (draft)

- Unit: policy function across seat counts 1-3, rounding at the final calculation boundary, floor/cap behaviour, tariff update between join and settlement.
- Integration (Testcontainers): concurrent joins/leaves keep every member's fare consistent with the policy; adjustment and membership change are atomic; a routing outage fails cleanly; migration upgrade from `0017` data.
- E2E: web shared booking showing agreed then adjusted fare.

## HITL stops

- Product owner decides questions 1-5 above (this is a pricing policy decision; review `95-delivery/hitl-touchpoints.md` before acting) and signs off the resulting acceptance criteria before the story moves to `ready`.

## Out of scope

- Normal (solo) and scheduled fares: unchanged.
- Payment collection/gateway integration (cash-only in Phase-0).
- Surge/dynamic pricing.

## Notes / questions

- Replaces the stand-in introduced in RCAB-E8.S8 (commit "shared fare fixed at join", slice `rem-d/pricing`). Review finding F15 (fare half) and guide R10 are the origin; this story completes the "decide whether discounts can improve after later joins and when the final fare locks" instruction.
- `GET /v1/rides/quote` still returns an *indicative* 2-seat estimate (`sharedEstimate`) that assumes no detour; it should be aligned with the decided policy.

## See also

- [[epic-e8-production-hardening]] · [[story-rcab-e8-s8-review-remediation-stage-c]]
- [[features-shared-rides]] · [[module-matching]] · [[module-rides]] · [[algo-shared-ride-matching]] · [[entity-shared-ride]]
- [[story-template]] · [[hitl-touchpoints]] · [[impact-analysis]]
