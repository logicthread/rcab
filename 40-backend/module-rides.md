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
- Provide `RideStateMachine.apply(rideId, event)` — the **only** way to drive a ride *forward* (driver-only).
- Provide `RideStateMachine.cancel({ rideId, actor, actorId, isNoShow, reason })` — the role-aware terminal path: client/driver cancel → `cancelled`, driver no-show (from `arrived`, after the 5-min wait) → `no_show` (RCAB-E4.S8). Guards ownership + the cancellable-from set; no-show enforces `now − arrived_at ≥ 5 min` server-side (→ `no_show_too_early`). Stamps `cancelled_at`/`cancelled_by`/`cancel_reason`. **No fee in Phase-0** (deferred). After commit it broadcasts `ride_state_changed`, clears a bound driver's `current_ride_id`, and emits `RIDE_CANCELLED_EVENT` so [[module-dispatch]] unwinds in-flight dispatch.
- Compute fares on completion.
- Provide history list queries.

## Public providers

- `RidesService` — DTO-level operations
- `RideStateMachine` — guarded forward (`apply`) + terminal (`cancel`) transitions

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
