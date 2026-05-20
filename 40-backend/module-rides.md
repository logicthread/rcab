---
title: Module — rides
tags: [layer/backend, kind/module]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[sm-ride-lifecycle]], [[entity-ride]], [[module-dispatch]], [[module-matching]]
audience: both
---

# Module — `rides`

*Owner of the [[entity-ride]] table and its [[sm-ride-lifecycle]].*

## Responsibilities

- Create a `RideRequest` from a quote + idempotency check.
- Hand the request to [[module-matching]] (for shared) or [[module-dispatch]] (for normal/scheduled).
- Provide `RideStateMachine.apply(rideId, event)` — the **only** way to change a ride's state.
- Compute fares on completion.
- Provide history list queries.

## Public providers

- `RidesService` — DTO-level operations
- `RideStateMachine` — guarded state transitions

## Persistence

- Tables: `ride`, `ride_request`, `ride_location_sample`.

## Concurrency

- All state transitions wrap a `SELECT … FOR UPDATE` of the `ride` row inside a transaction.
- Emits domain events to `RealtimeBus` *after* commit, never before.

## Tests

- Unit: state machine — every legal and illegal transition.
- Integration: cancel races (client and driver cancel simultaneously).

## See also
- [[entity-ride]] · [[entity-ride-request]] · [[sm-ride-lifecycle]]
- [[module-dispatch]] · [[module-matching]] · [[module-realtime]]
