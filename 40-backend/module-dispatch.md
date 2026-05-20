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

## State

- Lives mostly in Redis (`offer:*`, `request:*:dispatch`). Postgres knows only the request and the final ride.

## Failure modes

- Redis down → `dispatch_unavailable` 503 to client.
- All offers timeout → request transitions to `failed` (see [[sm-booking-flow]]) and clients get a `request_status` event.

## See also
- [[algo-top-k-dispatch]] · [[redis-usage]]
- [[module-realtime]] · [[module-matching]]
- [[entity-ride-request]]
