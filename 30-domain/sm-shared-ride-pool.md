---
title: State machine — SharedRide pool
tags: [layer/domain, kind/state-machine]
status: accepted
phase: 0
depends_on: [[entity-shared-ride]]
related: [[algo-shared-ride-matching]], [[features-shared-rides]]
audience: both
---

# SharedRide pool

*The life of a [[entity-shared-ride]] from open to closed-to-joins.*

```mermaid
stateDiagram-v2
    [*] --> open: created on first shared request
    open --> open: another compatible request slotted in
    open --> closed_full: seat_count == max_seats
    open --> closed_started: driver started the ride
    open --> closed_timeout: pool_closed_at reached
    open --> aborted: pool failed to find driver (became solo or failed)
    closed_full --> closed_started: driver starts ride
    closed_timeout --> closed_started: driver starts ride (last passengers only)
    closed_started --> [*]
    aborted --> [*]
```

## Notes

- A pool can be `closed_*` (no more joiners) yet **not yet started**, while the driver is en route.
- The state of the *ride itself* once it starts is governed by [[sm-ride-lifecycle]]. The pool state machine ends when the ride begins.

## Implementation (E5.S3)

- Owned by `PoolLifecycleService` (see [[module-matching]]).
- `open → closed_full` fires inline when the last seat is claimed (Lua atomic counter ↑ in `pool:<id>:seats`).
- `open → closed_timeout` fires from a BullMQ delayed job (`matching` queue, name `pool:expire`, default delay 60 s). The job ID format is `pool:expire:<ride_id>` so non-timeout transitions can `queue.remove()` it.
- Terminal-state writes mirror to Postgres (`shared_rides.pool_state` + `pool_closed_at`) and to Redis HASH `pool:<id>` (`state`, `closed_at`) — see [[redis-usage]].
- `closed_started` and `aborted` are emitted by E5.S4 (dispatch outcome), not by lifecycle itself.

## See also
- [[entity-shared-ride]] · [[features-shared-rides]]
- [[algo-shared-ride-matching]] · [[sm-ride-lifecycle]]
