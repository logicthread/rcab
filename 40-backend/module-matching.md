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

- `MatchingService`
  - `placeShared(requestId): { mode: 'slotted', sharedRideId } | { mode: 'opened', sharedRideId }`

## Persistence

- Owns reads/writes of `shared_ride`. Inserts new `route` rows lazily when an open pool starts a ride.

## Tests

- Unit: route-similarity scoring on a fixture corpus.
- Integration: slot vs. open decisions under simulated load.

## See also
- [[algo-shared-ride-matching]] · [[algo-route-similarity]]
- [[entity-shared-ride]] · [[entity-route]] · [[sm-shared-ride-pool]]
