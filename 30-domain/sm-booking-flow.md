---
title: State machine — Booking flow (RideRequest)
tags: [layer/domain, kind/state-machine]
status: accepted
phase: 0
depends_on: [[entity-ride-request]]
related: [[sm-ride-lifecycle]], [[sm-shared-ride-pool]], [[algo-top-k-dispatch]], [[module-dispatch]]
audience: both
---

# Booking flow

*A [[entity-ride-request]] from `created` to terminal.*

```mermaid
stateDiagram-v2
    [*] --> quoted: POST /rides/quote
    quoted --> created: POST /rides/requests
    created --> scheduled_pending: type=scheduled and wake time > now
    scheduled_pending --> created: wake-up at scheduled_for - 10m
    created --> matching: enter dispatch (top-K)
    created --> pooling: type=shared and slot/open pool
    pooling --> matching: pool reached driver dispatch step
    matching --> matched: driver accepts → linked to Ride
    matching --> failed: no driver after retries
    pooling --> failed: pool expired + no co-rider + no consent fallback
    pooling --> matching: fallback to normal dispatch (with consent)
    matched --> [*]
    failed --> [*]
    created --> canceled: client cancels
    pooling --> canceled: client cancels
    matching --> canceled: client cancels (offers revoked)
    canceled --> [*]
```

## Notes

- `quoted` is not persisted. It is the OSRM-routed estimate the API returned and the client retained.
- `scheduled_pending` rides are persisted but parked. They are kicked back to `created` by the BullMQ job at `scheduled_for - 10m`.
- Cancellation transitions are valid until `matched`. After `matched`, cancellation moves to the [[sm-ride-lifecycle]].

## See also
- [[entity-ride-request]] · [[sm-ride-lifecycle]] · [[sm-shared-ride-pool]]
- [[algo-top-k-dispatch]] · [[module-dispatch]]
