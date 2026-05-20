---
title: Journey — Driver accepts a ride
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[personas-driver]]
related: [[algo-top-k-dispatch]], [[sm-ride-lifecycle]], [[driver-google-maps-handoff]], [[integration-fcm]]
audience: both
---

# Driver accepts a ride

```mermaid
sequenceDiagram
    autonumber
    participant D as Dispatch
    participant Dr as Driver app
    participant FCM as FCM
    participant API as rcab API

    D->>FCM: high-priority data msg "ride_offer"
    D->>Dr: WS event "ride_offer" (if connected)
    Note over Dr: ringing UI, 12s TTL
    Dr->>API: POST /rides/offers/:id/accept
    API->>D: lock — first to accept wins
    alt won
        API-->>Dr: { ride, pickup, dropoff, client_phone }
        API->>D: revoke other offers
    else lost / expired
        API-->>Dr: 409 offer_expired
    end
```

## Why both FCM and WebSocket

WebSocket is the happy path when the app is in foreground / recently active. FCM data messages cover the case where the WS has gone stale (background, doze, weak network). The two are idempotent on the driver app — whichever arrives first opens the offer screen.

## After accept

- Driver app shows pickup card with a **"Navigate"** button → opens Google Maps deeplink ([[driver-google-maps-handoff]]).
- Driver app stays foreground via the location service. Ride moves to `accepted → en_route_pickup` in [[sm-ride-lifecycle]].

## See also
- [[algo-top-k-dispatch]] · [[sm-ride-lifecycle]]
- [[driver-google-maps-handoff]] · [[integration-fcm]]
- [[module-realtime]] · [[module-dispatch]]
