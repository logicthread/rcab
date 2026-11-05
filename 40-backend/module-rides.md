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

## Idempotency contract

`POST /v1/rides` honors `Idempotency-Key` (1-128 visible ASCII; 400 `idempotency_key_required` / `idempotency_key_invalid`). Required for solo/scheduled, optional for shared until the web client always sends it.

- **Scope** is `(passenger, operation, key)`; operation is the ride type. Another account or operation using the same key is an independent request and never sees the first result.
- **Fingerprint:** SHA-256 of the business intent (route at 6 dp, `scheduledFor` as epoch ms; **not** the quote token, so a re-quoted retry of the same intent replays the original ride; never the access token). Same scope + same intent replays the stored result; same scope + different intent returns **422 `idempotency_key_conflict`** with no mutation.
- **Durable, not cached:** replay is served from Postgres (`rides.idempotency_operation`, `rides.request_fingerprint`, composite UNIQUE; legacy rows have NULL fingerprint and are replayable by their owner only). The Redis `idem:rides:*` cache is removed, so a cold cache or restart behaves identically.
- **Stale pending reclaim:** a `pending` claim older than 60 s (`PENDING_RECLAIM_AFTER_MS`) can be taken over by a same-fingerprint retry; shared create first returns a seat the dead attempt already holds (best effort until R08).
- Replay is resolved **before** quote verification and the scheduled-window check, so a late retry recovers an already-accepted booking.
- **Shared create** claims the key in `idempotency_record` (pending) before seat allocation, completes it with the replayable response, and releases it if allocation throws. A retried identical request replays the original seat; a concurrent duplicate gets **409 `idempotency_request_in_progress`**.
- Migration: `0013_idempotency_scope.sql`. Known gap: dispatch hand-off after commit is not yet durable (F08, Stage C).

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
