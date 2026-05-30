---
title: Module — dispatch
tags: [layer/backend, kind/module]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[algo-top-k-dispatch]], [[redis-usage]], [[module-realtime]], [[entity-ride-request]]
audience: both
---

# Module — `dispatch`

*Top-K offer fan-out, offer locking, retry waves.*

## Responsibilities

- For an unmatched `RideRequest`, find K nearest available drivers (via `geo`).
- Issue `ride_offer` events (WS + FCM) with a `Idempotency-Key`-backed `offer_id` and 12 s TTL.
- Atomically lock the offer on driver accept (Redis `SET NX EX`).
- Revoke outstanding offers when one wins.
- Retry with wave 2 (K=10) at 30 s, hard-fail at 60 s.

## Algorithm

See [[algo-top-k-dispatch]] for the full algorithm and parameters.

## Public providers

- `DispatchService`
  - `start(requestId): void` — fire-and-forget; enqueues wave-1 immediately
  - `cancel(requestId): void`
  - `dispatchPool(rideId): Promise<void>` — shared-ride entry point (E5.S4); fans out a multi-stop `ride_offer` to top-K drivers and schedules wave-2 + hard-fail timers.
  - `claimPool(rideId, driverId): Promise<ClaimResult>` — atomic Lua claim of a closed pool by a single driver; revokes outstanding offers and clears wave-2/hard-fail jobs on success.
  - `dispatchSolo(rideId): Promise<void>` — solo (normal) entry point (E4.S3); fans out a `ride_offer` to top-K drivers and schedules wave-2 + hard-fail timers.
  - `claimSolo(rideId, driverId): Promise<ClaimResult>` — atomic first-accept-wins claim of a solo ride (E4.S4): `claim:ride:<id>` SET NX decides the winner, then the `rides` row is bound (`accepted` + `driver_id` + `accepted_at`); revokes the other offers (excluding the winner) and clears the timers.
  - `@OnEvent('pool.closed')` listener — auto-dispatches when `PoolLifecycleService` closes a pool with reason `closed_full` or `closed_timeout`.
  - `@OnEvent('ride.requested')` listener — auto-dispatches a freshly persisted solo ride (E4.S3).
  - `@OnEvent('dispatch.ride_offer_response')` listener — driven by `RealtimeGateway`; a pool offer → `claimPool`, a solo offer (`offer:type='solo'`) → `claimSolo` (winner gets `ride_offer_accepted`, race-loser gets `ride_offer_revoked` reason `taken`). Decline → just deletes the offer lock.

## State

- Lives mostly in Redis (`offer:*`, `request:*:dispatch`). Postgres knows only the request and the final ride.
- Shared-ride dispatch (E5.S4) additionally uses:
  - `pool:<ride_id>:offered` SET — drivers already invited for this pool (used to exclude them on wave 2). TTL 10 min.
  - `pool:<ride_id>:stops` STRING JSON — cached `OfferStop[]` so the same stop order is broadcast across waves. TTL 10 min.
  - `offer:list:<ride_id>` SET — outstanding offer IDs for the pool; consumed by the revoke path on claim or hard-fail.
  - `offer:meta:<offer_id>` STRING — pool id; lets the gateway resolve `sharedRideId` when the driver client did not echo it.
  - `bull:dispatch:*` — BullMQ delayed jobs for `dispatch:wave2-timeout` and `dispatch:hard-fail`.

## Failure modes

- Redis down → `dispatch_unavailable` 503 to client.
- All offers timeout → request transitions to `failed` (see [[sm-booking-flow]]) and clients get a `request_status` event.
- Shared-ride pool exhausts all waves → `DispatchService.handleHardFail` (`kind='pool'`) calls `PoolLifecycleService.closePool(rideId, 'aborted')` and revokes outstanding offers. Re-queueing each member as an individual solo ride is a Phase-0 future enhancement (the solo path now exists, E4.S3–S4).
- Solo ride exhausts all waves → `handleHardFail` (`kind='solo'`) marks the `rides` row `no_driver`, revokes outstanding offers, and emits `ride_no_driver` to the passenger (E4.S4).

## See also
- [[algo-top-k-dispatch]] · [[redis-usage]]
- [[module-realtime]] · [[module-matching]]
- [[entity-ride-request]]
