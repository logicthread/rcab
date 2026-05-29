---
title: RCAB-E5.S5 — Shared-ride pricing per seat
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e5-shared-booking]]
demo: 4
estimate: s
hitl: no
depends_on: [[story-rcab-e5-s2-matching-service-slot-vs-open]], [[features-shared-rides]], [[entity-shared-ride]], [[integration-osrm]]
affected_notes: [[features-shared-rides]], [[rest-endpoints]]
owner: claude
audience: both
---

# RCAB-E5.S5 — Shared-ride pricing per seat

## Goal

A shared seat must cost less than a solo ride while ensuring the driver earns at least as much (often more) than a solo fare. This story implements the per-seat pricing formula from [[features-shared-rides]] § Pricing, wires it into the `POST /v1/rides` quote response for `type=shared`, and adds a detour multiplier that adjusts the price when the driver's total route is longer than the direct path.

## User-facing acceptance criteria

- `Given` a 2-seat shared request, `When` the client requests a quote, `Then` `per_seat_price` is ≤ 70% of the equivalent solo fare for the same origin-destination.
- `Given` a 3-seat shared request, `When` the client requests a quote, `Then` `per_seat_price` is ≤ 55% of the equivalent solo fare.
- `Given` the pool's OSRM route distance exceeds the direct distance by > 30% (detour factor > 1.3), `When` the seat is priced, `Then` `per_seat_price` is scaled up proportionally by the detour factor (capped at 1× solo).
- `Given` the driver completes a 3-seat shared ride, `When` the trip is settled, `Then` the driver receives the sum of all seat fares minus the platform commission percentage.

## Technical acceptance criteria

- `apps/api/src/modules/pricing/pricing.service.ts` — add `quoteSeat(pool: SharedRide, seat: SeatContext): Money`:
  - `seat_multiplier`: `2 seats → 0.70`, `3 seats → 0.55` (read from config `SEAT_MULTIPLIER_2` / `SEAT_MULTIPLIER_3`).
  - `detour_factor = pool_osrm_distance_m / direct_osrm_distance_m` — fetch direct distance from OSRM for the single passenger's origin-dest; pool distance from the pool's cached polyline total arc-length.
  - `seat_price = solo_price × seat_multiplier × min(detour_factor, 1.0)` — detour factor ≤ 1 by construction (detouring costs more, so `min` not `max`; a detour exceeding 1× solo is capped to protect the client).
  - Wait — per spec the detour multiplier _increases_ price. So: `seat_price = solo_price × seat_multiplier × max(1.0, min(detour_factor, 1.0 / seat_multiplier))`.
  - Correction: `seat_price = solo_price × seat_multiplier × clamp(detour_factor, 1.0, 1.0/seat_multiplier)` — price increases with detour but can never exceed solo price.
- `GET /v1/rides/quote?type=shared&...` and `POST /v1/rides` response for `type=shared` include `perSeatPrice: Money` and `seatMultiplier: number`.
- Driver payout: `sum(seat_prices) × (1 - PLATFORM_COMMISSION_RATE)`.

## Test plan

- **Unit (Vitest):** `pricing.service.spec.ts` — assert 2-seat price ≤ 0.7× solo; assert 3-seat price ≤ 0.55× solo; assert detour factor > 1.3 increases price; assert cap never exceeds solo price; assert driver payout calculation correct.
- **Integration:** not required for this story — purely computational with mocked OSRM distances.

## Out of scope

- Dynamic surge pricing for shared rides — Phase-1.
- Driver-side earnings display — that is E7.S4.
- Fare dispute resolution — out of scope for Phase-0.

## Notes / questions

- All monetary values use integer cents (`Money = { amount: number, currency: 'USD' }`) per [[conventions]]. Never use floats for money.
- `PLATFORM_COMMISSION_RATE` is in [[secrets-management]]; default 0.20 (20%).

## See also

- [[epic-e5-shared-booking]] · [[features-shared-rides]] · [[entity-shared-ride]]
- [[integration-osrm]] · [[rest-endpoints]]
- [[story-rcab-e5-s2-matching-service-slot-vs-open]] · [[epic-e7-rating-dashboards]]
