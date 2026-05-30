---
title: Algorithm — Top-K dispatch
tags: [layer/algorithm, kind/algo]
status: accepted
phase: 0
depends_on: [[redis-usage]]
related: [[module-dispatch]], [[features-top-k-dispatch]], [[sm-booking-flow]]
audience: both
---

# Top-K dispatch

*For an unmatched request, notify the K nearest available drivers in parallel; first to accept wins.*

## Parameters (Phase-0)

| Symbol | Value | Meaning |
|---|---|---|
| K₁ | 5 | wave-1 fan-out size |
| K₂ | 10 | wave-2 fan-out (after 30 s without acceptance) |
| R_max | 4 km | max radius |
| TTL | 12 s | per-driver offer TTL |
| HARD_FAIL | 60 s | total time budget |

## Algorithm

```
input: request_id
candidates ← GEOSEARCH active_drivers FROMLONLAT origin BYRADIUS R_max ASC COUNT K₁
exclude   ← drivers who already saw an offer for this request
candidates ← candidates − exclude

if candidates is empty:
  schedule wave-2 in 30 s (if any time left in HARD_FAIL); else fail

for each c in candidates:
  offer_id ← uuid_v7()
  SET offer:<offer_id> driver_id NX EX 12     # reserve, but won = ZADD-on-accept later
  emit RealtimeBus.toDriver(c, "ride_offer", {…, offer_id, ttl_ms: 12000})
  FCM send (data-only, ttl=12s)
  SADD offer:list:<request_id> offer_id

await driver_accept OR offer_expiry OR client_cancel

on accept(offer_id, driver_id):
  EVAL Lua: dispatch_claim
    if first to set claim:<offer_id> = driver_id then OK
    else return ALREADY_TAKEN
  if OK:
    create Ride, transition request → matched
    EVAL Lua: dispatch_revoke for all other offer_ids
    emit "ride_offer_revoked" + FCM

on all offers expired and no accept:
  schedule wave-2 (K₂) if HARD_FAIL not reached
  else transition request → failed
```

## Why the Redis `SET … NX EX` lock

Two drivers may tap "accept" at the same millisecond. We need a single point of atomic decision. Redis is millisecond-fast; Postgres `SELECT FOR UPDATE` would also work but is heavier and brings the DB into the hot path.

## Shared-ride variant (E5.S4)

For pools closed by `closed_full` or `closed_timeout`, the same top-K machinery is reused but the offer payload is enriched and the claim is per-pool not per-offer:

- Candidates: `GEORADIUS active_drivers <pool.origin> R k+excluded ASC` then filter against `pool:<ride_id>:offered`.
- Payload: `ride_offer { offerId, sharedRideId, ttlMs, stops[], passengerCount, waveNumber }`. `stops[]` is computed once from `pool.members` (pickups sorted by proximity to `origin_centroid`, drops by proximity to `dest_centroid`) and cached at `pool:<ride_id>:stops` for stability across waves.
- Wave-1 K=5 R=2 km; wave-2 K=10 R=4 km at 30 s; hard-fail 60 s.
- Claim: `pool_claim.lua` atomically stamps `claimed_by` + `claimed_at` on `pool:<ride_id>` HASH. Result codes `1` / `0` / `-1` / `-2` (see [[redis-usage]]). On success: `setClaimed` in Postgres, revoke `offer:list:<ride_id>`, remove `dispatch:wave2-timeout:<ride_id>` + `dispatch:hard-fail:<ride_id>` BullMQ jobs.
- Hard-fail: `DispatchService.handleHardFail` closes the pool to `aborted` and revokes outstanding offers. Re-queueing aborted pool members as solo rides remains a future enhancement (the solo path itself is E4.S3–S4).

## Solo variant (E4.S3–S4)

The normal (non-pooled) ride is the direct realisation of the algorithm above:

- Candidates: `GEORADIUS active_drivers <pickup> R k+excluded ASC` filtered against `ride:<ride_id>:offered`. Wave-1 K=5 R=2 km; wave-2 K=10 R=4 km at 30 s; hard-fail 60 s.
- Payload: `ride_offer { offerId, rideId, ttlMs, pickup, dropoff, fareCents, waveNumber }`, tagged `offer:type:<offerId>='solo'`.
- Claim: `claim:ride:<ride_id>` `SET NX` is the atomic single-winner decision — one command, so no Lua is needed (unlike the pool's multi-field HASH check). The winner is then bound to the `rides` row (`status='accepted'`, `driver_id`, `accepted_at`) via a `WHERE status='requested'`-guarded UPDATE; a loser (incl. the same driver re-tapping) gets `already_taken`. On success: revoke `offer:list:<ride_id>` (excluding the winner) + remove the wave-2/hard-fail jobs.
- Hard-fail: `handleHardFail` (`kind='solo'`) marks the ride `no_driver`, revokes outstanding offers, and emits `ride_no_driver` to the passenger.
- The wave-2/hard-fail BullMQ jobs carry `kind: 'solo' | 'pool'` so the shared handlers route to the right path.

## Future ranking blend (Phase-1, gated by data)

When we have ≥ 5 ratings per driver, replace pure-distance ordering with:

```
score = α * (1 / (1 + distance_km))
      + β * driver_rating_norm
      + γ * (1 - recent_decline_rate)
```

α, β, γ tuned offline; see [[algo-rating-aggregation]] for `driver_rating_norm`.

## See also
- [[module-dispatch]] · [[features-top-k-dispatch]] · [[redis-usage]]
- [[algo-rating-aggregation]] · [[sm-booking-flow]]
