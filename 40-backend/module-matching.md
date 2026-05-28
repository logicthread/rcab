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
  - Decision: spatial pre-filter (1500 m) → score (≥ 0.7) → detour check (≤ 800 m) → best composite → Lua slot
- `SharedRideRepository` ← **implemented (E5.S2)**
  - `findCandidates`, `create`, `incrementSeats`

## Persistence

- Owns reads/writes of `shared_ride`. Inserts new `route` rows lazily when an open pool starts a ride.

## Tests

- Unit: route-similarity scoring with mocked HttpService + Redis (E5.S1 — 7 tests).
- Integration: real Redis via Testcontainers; cache-hit verification (E5.S1 — 2 tests).
- Integration (E5.S2): Testcontainers Postgres+Redis — slot into seeded pool, seat_count in DB, open when all full (3 tests).

## See also
- [[algo-shared-ride-matching]] · [[algo-route-similarity]]
- [[entity-shared-ride]] · [[entity-route]] · [[sm-shared-ride-pool]]
