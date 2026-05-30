---
title: Journey — Client books a normal ride
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[features-normal-booking]]
related: [[algo-top-k-dispatch]], [[sm-booking-flow]], [[sm-ride-lifecycle]]
audience: both
---

# Client books a normal ride

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as rcab API
    participant D as Dispatch
    participant Dr1 as Driver A
    participant Dr2 as Driver B

    C->>API: POST /rides/quote (origin, dest, type=normal)
    API-->>C: { fare_estimate, est_eta }
    C->>API: POST /rides/requests (type=normal)
    API->>D: dispatch top-K=5
    par parallel offers
        D->>Dr1: offer (12s TTL)
        D->>Dr2: offer (12s TTL)
    end
    Dr2-->>D: accept
    D->>Dr1: offer_revoked
    D->>API: ride created with Driver B
    API-->>C: { status=matched, ride_id, driver=B }
```

## After match — live tracking (RCAB-E4.S7)

Once `status=matched`, the client is already in the `ride:<id>` room (joined at request time, re-asserted via `ride:subscribe` on reconnect). It then follows the ride live: `ride_state_changed` drives the status banner (driver assigned → en route → arrived → on trip → complete) and `driver_location` moves the driver marker on the booking map (≤ 1 Hz). The driver's first location implicitly advances `accepted → en_route`. See [[websocket-events]] · [[sm-ride-lifecycle]].

## Failure paths

- No driver in K=5 accepts within 30s → wave 2 fires K=10.
- Total elapsed 60s without acceptance → request fails with `dispatch_no_driver`. Client is shown the option to try again, schedule, or convert to shared.
- Client cancels mid-flow → all outstanding offers revoked, request marked `canceled_by_client`.

## See also
- [[features-normal-booking]] · [[algo-top-k-dispatch]]
- [[sm-booking-flow]] · [[sm-ride-lifecycle]]
- [[module-dispatch]]
