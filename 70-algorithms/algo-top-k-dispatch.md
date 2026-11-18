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
| K₁, K₂, K₃ | 20 each | fan-out per wave |
| R₁ / R₂ / R_max = R₃ | 3 km / 5 km / 7 km | search radius of waves 1 / 2 / 3 |
| wave starts | 0 s / 30 s / 45 s | wave 3 starts halfway between wave 2 and HARD_FAIL (`waveThreeDelayMs`) |
| TTL | 12 s | per-driver offer TTL |
| HARD_FAIL | 60 s | time budget of ONE round |
| ROUNDS | 3 | normal rides: a round with no acceptance restarts at wave 1 (new generation); only the last round fails (`DISPATCH_ROUNDS`) |
| HOLD | 5 s | normal rides: delay between booking and the first offers, so an accidental booking can be cancelled (`DISPATCH_BOOKING_HOLD_MS`) |
| BUSY_ETA | 10 min | a driver on an in-progress solo ride within this road ETA of its drop-off may be offered one next ride (`DISPATCH_BUSY_DRIVER_ETA_MS`) |

## Algorithm

```
input: request_id
candidates ← GEOSEARCH active_drivers FROMLONLAT origin BYRADIUS R_wave ASC COUNT K_wave × headroom   # wave 1 uses R₁, K₁
exclude   ← drivers who already saw an offer for this request
candidates ← candidates − exclude

if candidates is empty:
  the next wave is already armed (30 s, 45 s); a miss in the last wave ends at HARD_FAIL

for each c in candidates:
  offer_id ← uuid_v7()
  INSERT dispatch_offer(offer_id, driver_id, generation, expires_at=now()+12s)   # Postgres; UNIQUE skips re-offers
  emit RealtimeBus.toDriver(c, "ride_offer", {…, offer_id, ttl_ms: 12000})
  FCM send (data-only, ttl=12s)

await driver_accept OR offer_expiry OR client_cancel

on accept(offer_id, driver_id):
  BEGIN tx: validate stored offer (owner, expiry, generation, trip state, eligibility)
    + insert driver_active_assignment (one active trip per driver) + bind trip
    else return lost/expired/rejected
  if OK:
    create Ride, transition request → matched
    mark other offers revoked (same tx); emit ride_offer_outcome
    emit "ride_offer_revoked" + FCM

on all offers expired and no accept:
  wave 2 (K₂, R₂) at 30 s and wave 3 (K₃, R₃) at 45 s, both armed when wave 1 runs
  else transition request → failed
```

## Why Postgres decides (Stage C)

Two drivers may tap "accept" at the same millisecond. The decision is a Postgres transaction (row lock on the trip + unique `driver_active_assignment`), so it survives Redis loss and is the same for solo and shared. The earlier Redis `SET NX` / Lua claim scheme was removed. Dispatch itself is started from outbox intents, never from in-memory events ([[module-dispatch]]).

## Shared-ride variant (E5.S4)

For pools closed by `closed_full` or `closed_timeout`, the same top-K machinery is reused but the offer payload is enriched and the claim is per-pool not per-offer:

- Candidates: `GEORADIUS active_drivers <pool.origin> R k+excluded ASC` then exclude drivers who already have a `dispatch_offer` row for this pool.
- Payload: `ride_offer { offerId, sharedRideId, ttlMs, stops[], passengerCount, waveNumber }`. `stops[]` is computed once from `pool.members` (pickups sorted by proximity to `origin_centroid`, drops by proximity to `dest_centroid`) and read from the persisted itinerary for stability across waves.
- Waves: K=20 each; R 3 km / 5 km / 7 km at 0 s / 30 s / 45 s; hard-fail 60 s (RCAB-E8.S23).
- Claim: the transactional accept binds the pool (`claimed_by_driver_id`) and the driver guard in Postgres (see [[redis-usage]] for what was removed). On success: revoke the other offers, remove the wave-2, wave-3 and hard-fail BullMQ jobs (`dispatch-wave2-…`, `dispatch-wave3-…`, `dispatch-hardfail-…`, per generation).
- Hard-fail: `DispatchService.handleHardFail` closes the pool to `aborted` and revokes outstanding offers. Re-queueing aborted pool members as solo rides remains a future enhancement (the solo path itself is E4.S3–S4).

## Solo variant (E4.S3–S4)

The normal (non-pooled) ride is the direct realisation of the algorithm above:

- Candidates: `GEORADIUS active_drivers <pickup> R k+excluded ASC` excluding drivers who already have a `dispatch_offer` row. Scheduled rides use a 4-minute window (`SCHEDULED_DISPATCH_WINDOW_MS`) and are re-armed uncapped when unanswered. Per round: K=20 per wave; R 3 km / 5 km / 7 km at 0 s / 30 s / 45 s; hard-fail 60 s (RCAB-E8.S23).
- Payload: `ride_offer { offerId, rideId, ttlMs, pickup, dropoff, fareCents, waveNumber, pickupDistanceM?, pickupDurationS?, nextRide? }`.
- Claim: the single winner is decided by the accept transaction. The winner is bound to the `rides` row (`status='accepted'`, `driver_id`, `accepted_at`) via a `WHERE status='requested'`-guarded UPDATE; a loser gets `ride_offer_outcome` `lost`. On success: revoke the other offers + remove the wave-2/wave-3/hard-fail jobs.
- **Hold (RCAB-E8.S16):** the `ride.dispatch.requested` intent of a normal ride is written with `available_at = now + 5 s`; cancelling inside that window leaves nothing to dispatch. Offers of a wave are written and sent in parallel.
- **Rounds (RCAB-E8.S16):** the generation is the round number. At hard-fail, a normal ride below `DISPATCH_ROUNDS` is re-armed under `generation + 1` (`rearmNormalRide`: ride lock, revoke live offers, new outbox intent), so every driver can be offered again from wave 1. Scheduled rides keep their own uncapped re-arm.
- **Next-ride queue (RCAB-E8.S16):** after the idle candidates, spare slots go to busy drivers whose active trip is a solo `in_progress` ride with nothing queued and whose OSRM ETA to its drop-off is within BUSY_ETA (`nextRide: true` on the offer). Accepting queues the ride in `driver_queued_assignment` (the ride is `accepted` + `driver_id`, but not the driver's active trip); the transaction that ends the active ride promotes it into `driver_active_assignment`. A queued ride cannot be advanced; cancelling it drops it from the queue.
- **Offer payload** carries `pickupDistanceM` / `pickupDurationS`: road distance and time from the driver's CURRENT position (`DriverEtaService`, one OSRM `/table` call per wave, straight-line fallback).
- Hard-fail: `handleHardFail` (`kind='solo'`) on the last round marks the ride `no_driver`, revokes outstanding offers, and emits `ride_no_driver` to the passenger.
- The wave-2/wave-3/hard-fail BullMQ jobs carry `kind: 'solo' | 'pool'` so the shared handlers route to the right path.

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
