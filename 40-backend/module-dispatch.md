---
title: Module — dispatch
tags: [layer/backend, kind/module]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[algo-top-k-dispatch]], [[module-rides]], [[redis-usage]], [[module-realtime]], [[entity-ride-request]]
audience: both
---

# Module — `dispatch`

*Top-K offer fan-out, Postgres-authoritative offers and assignment, outbox-driven start, retry waves.*

## Responsibilities

- Start dispatch **only** from durable outbox intents (never from in-memory events): `OutboxRelay` publishes `ride.dispatch.requested`, `ride.wake.schedule` and `pool.*` rows; `DispatchStartService` runs the first wave; `DispatchReconciler` re-arms anything that was committed but never started.
- For an unmatched trip, find K nearest eligible drivers (via `geo`, active vehicle with enough seats) and persist one `dispatch_offer` row per driver (generation-stamped, DB-clock expiry, 12 s TTL).
- Validate an accept authoritatively in **one Postgres transaction** (offer owner, expiry, generation, trip state, eligibility) and bind the trip; the `driver_active_assignment` guard allows at most one active trip (solo or shared) per driver.
- Revoke the remaining offers when one wins; retry with wave 2 (K=10) at 30 s, hard-fail at 60 s.
- Scheduled rides use a longer accept window (see Scheduled below).

## Algorithm

See [[algo-top-k-dispatch]] for the full algorithm and parameters.

## Public providers

- `OutboxRelay` / `OutboxService` — transactional outbox (`outbox`, migration 0015); the booking/pool commit writes the intent in the same transaction. BullMQ jobs complete only after the dispatch work ran, so a failed wave is retried.
- `DispatchStartService` — idempotent first-wave start per generation (`runSoloWave` / `runPoolWave`); both **throw** on infrastructure failure so the job retries.
- `DispatchReconciler` — boot + periodic sweep that re-arms undispatched `requested`/closed-pool trips.
- `DispatchService`
  - `dispatchSolo(rideId)` / `dispatchPool(rideId)` — wave runners; the `dispatch_offer` UNIQUE constraints skip already-offered drivers, timer job ids are deterministic per generation.
  - accept path (`ride_offer_response`) — single-transaction validation against the stored `dispatch_offer` row (the client `sharedRideId` is ignored). Replies with a `ride_offer_response` ack and emits `ride_offer_outcome` (`assigned` / `lost` / `expired` / `revoked` / `rejected`).
  - `releaseDispatch(rideId)` — unwinds in-flight dispatch on cancel (`ride.cancelled`): revokes offers, removes wave-2/hard-fail jobs. Safe no-op when nothing is in flight.

## State

- **Postgres is the source of truth**: `dispatch_offer`, `driver_active_assignment`, `outbox`, `rides`/`shared_rides` (see [[schema-postgres]]). Migration 0014 added offers + the guard (with a backfill and a `migration_conflict` inventory for pre-existing double assignments).
- Redis holds only projections and timers: `driver:state:<id>.current_ride_id` (reconciled from Postgres at boot and periodically), the `active_drivers` geo index and `bull:dispatch:*` delayed jobs (`dispatch:wave2-timeout`, `dispatch:hard-fail`). The former `claim:ride:*`, `offer:*`, `ride:*:offered`, `pool:*:offered/stops` keys and the Lua claim scripts were **removed**.

## Scheduled rides (E6 + Stage C)

- Wake fires at T−10 min (`SCHEDULED_WAKE_LEAD_MS`) via a `ride.wake.schedule` outbox intent.
- Accept window is **4 minutes** (`SCHEDULED_DISPATCH_WINDOW_MS=240000`); wave one is `SCHEDULED_DISPATCH_WAVE_ONE_MS` (default half the window). Normal rides keep 30 s / 60 s.
- An unanswered scheduled ride is re-armed with a new generation (no retry cap); the passenger is told once (`ride_dispatch_retry`) and never gets `no_driver` from the scheduled path.

## Failure modes

- Redis geo down → the wave throws and the job/outbox retries; Postgres down → accept is rejected, nothing is half-bound.
- All offers timeout → request transitions to `failed` (see [[sm-booking-flow]]) and clients get a `request_status` event.
- Shared-ride pool exhausts all waves → `DispatchService.handleHardFail` (`kind='pool'`) calls `PoolLifecycleService.closePool(rideId, 'aborted')` and revokes outstanding offers. Re-queueing each member as an individual solo ride is a Phase-0 future enhancement (the solo path now exists, E4.S3–S4).
- Solo ride exhausts all waves → `handleHardFail` (`kind='solo'`) marks the `rides` row `no_driver`, revokes outstanding offers, and emits `ride_no_driver` to the passenger (E4.S4).

## See also
- [[algo-top-k-dispatch]] · [[redis-usage]]
- [[module-realtime]] · [[module-matching]]
- [[entity-ride-request]]
