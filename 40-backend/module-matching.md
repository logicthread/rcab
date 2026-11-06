---
title: Module — matching
tags: [layer/backend, kind/module]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[algo-shared-ride-matching]], [[algo-route-similarity]], [[entity-shared-ride]]
audience: both
---

# Module — `matching`

*Decide whether a new shared request slots into an existing pool, opens a new pool, or fails over.*

## Responsibilities

- Given a new `shared` `RideRequest`, query candidate `SharedRide`s within geohash-binned proximity.
- Score each candidate with [[algo-route-similarity]].
- Slot in the best fit if score ≥ threshold and detour ≤ budget.
- Otherwise, open a new pool (a fresh `SharedRide` with `seat_count=1`).

## Public providers

- `RouteSimilarityService` ← **implemented (E5.S1)**
  - `scoreRoutes(a: RouteInput, b: RouteInput): Promise<number>` — Phase-0 Fréchet-lite score
  - `RouteInput = { originLat, originLng, destLat, destLng }`
  - `OsrmUnavailableException` thrown on OSRM error
- `MatchingService` ← **implemented (E5.S2)**
  - `findOrCreatePool(request: SharedRideRequest): Promise<MatchResult>`
  - Decision: spatial pre-filter (1500 m) → score (≥ 0.7) → detour check (≤ 800 m) → best composite → transactional join (`pool_member`)
- `SharedRideRepository` ← **implemented (E5.S2, extended E5.S3)**
  - `findCandidates`, `create`, `incrementSeats`, `closePool`
- `PoolLifecycleService` ← **implemented (E5.S3)**
  - `openPool(params)` — creates the DB row, enqueues a delayed `pool:expire:<rideId>` BullMQ job (default 60 s), writes the Redis HASH `pool:<rideId>` projection.
  - `slotRequest(pool)` — one Postgres transaction: insert `pool_member` (capacity + duplicate-member constraints, migration 0016), bump `seat_count`, update the itinerary and `shared_rides.state_version`; on max-fill closes the pool as `closed_full` (removing the expiry job). The Lua `pool_slot.lua` and the `pool:<id>:seats` counter were removed.
  - **Fare at join (Phase-0 stand-in):** `SHARED_FARE_POLICY='fixed_at_join'`. The seat is quoted inside the join transaction from the itinerary (`quoteSeatInItinerary`, OSRM bounded by `PRICING_OSRM_TIMEOUT_MS`), stored in `pool_member.agreed_fare_cents` (migration 0017: required + immutable via triggers) and never readjusted when later riders join. Real pooled pricing is draft story RCAB-E8.S9.
  - `closePool(rideId, reason)` — writes terminal state to Postgres and refreshes the HASH projection; removes the expiry job unless the reason itself is `closed_timeout`.
- `PoolExpireProcessor` ← **implemented (E5.S3)**
  - BullMQ worker on queue `matching`; the `pool:expire` handler calls `PoolLifecycleService.closePool(rideId, 'closed_timeout')`.
- HTTP entry — `RidesController` → `POST /v1/rides` (E5.S3): handles `type=shared` only (returns 501 for `normal`/`scheduled` until E4/E6 land); response carries `{ sharedRideId, mode, poolStatus }`.

## Persistence

- Owns reads/writes of `shared_ride` and `pool_member`. Redis `pool:<id>` is a **projection** rebuilt from Postgres (boot + periodic reconcile); never authoritative. Inserts new `route` rows lazily when an open pool starts a ride.

## Tests

- Unit: route-similarity scoring with mocked HttpService + Redis (E5.S1 — 7 tests).
- Integration: real Redis via Testcontainers; cache-hit verification (E5.S1 — 2 tests).
- Integration (E5.S2): Testcontainers Postgres+Redis — slot into seeded pool, seat_count in DB, open when all full (3 tests).
- Unit (E5.S3): `pool-lifecycle.service.spec.ts` — openPool enqueue/HASH; transactional slot + auto-close at max; closePool removes job for non-timeout (8 tests).
- Integration (Stage C): `pool-membership.int.spec.ts` (concurrent joins, capacity, duplicate member, closure, immutable `agreed_fare_cents`) and the pricing specs for `fixed_at_join`.
- Integration (E5.S3): `pool-lifecycle.int.spec.ts` — Testcontainers Postgres+Redis+BullMQ; assert DB row + HASH + delayed job after openPool; closed_full transition removes the job; processor `pool:expire` handler writes `closed_timeout` (3 tests).

## See also
- [[algo-shared-ride-matching]] · [[algo-route-similarity]]
- [[entity-shared-ride]] · [[entity-route]] · [[sm-shared-ride-pool]]
