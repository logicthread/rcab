---
title: Journey — Driver goes online
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[personas-driver]]
related: [[sm-driver-availability]], [[driver-background-location]], [[module-realtime]], [[redis-usage]]
audience: both
---

# Driver goes online

```mermaid
sequenceDiagram
    autonumber
    participant Dr as Driver app
    participant API as rcab API
    participant R as Redis (GEO index)

    Dr->>API: POST /drivers/online
    API->>R: GEOADD active_drivers <lng,lat> <driver_id>
    API-->>Dr: { ok, session_id }
    Dr-->>API: WS connect (auth)
    loop every ~5s while online
        Dr->>API: WS event "location" { lat, lng, heading, speed }
        API->>R: GEOADD active_drivers <lng,lat> <driver_id>
    end
```

## Background behavior

The Flutter app declares a foreground service while online so Android does not kill the location stream. See [[driver-background-location]] for OS-specific handling.

## Going offline

- Manual toggle → `POST /drivers/offline` + WS disconnect.
- Auto-offline if no location update for 60s → server `ZREM` from the geo index. App is told via WS or, if disconnected, via FCM.

## See also
- [[sm-driver-availability]] · [[driver-background-location]]
- [[redis-usage]] · [[module-realtime]]
