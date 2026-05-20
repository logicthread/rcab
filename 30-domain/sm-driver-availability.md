---
title: State machine — Driver availability
tags: [layer/domain, kind/state-machine]
status: accepted
phase: 0
depends_on: [[entity-driver]]
related: [[redis-usage]], [[journey-driver-go-online]], [[module-realtime]]
audience: both
---

# Driver availability

*The states a driver flows through while operating.*

```mermaid
stateDiagram-v2
    [*] --> offline
    offline --> online: POST /drivers/online (+location)
    online --> on_ride: ride accepted ([[sm-ride-lifecycle]])
    on_ride --> online: ride completed/canceled/no_show
    online --> offline: POST /drivers/offline
    online --> offline: 60s without location update
    on_ride --> on_ride: shared — additional pickups
```

## Where the state lives

- **Postgres** `driver.availability` — denormalized, eventually consistent (for dashboards).
- **Redis** `driver:state:<driver_id>` — authoritative for dispatch eligibility.
- **Redis** `active_drivers` GEO set — only contains drivers whose Redis state is `online`.

Dispatch reads only Redis; Postgres is for analytics.

## Why drop the geo entry the moment a driver goes `on_ride`?

Dispatch should never see a busy driver. The `on_ride` driver continues to send location updates, but those go to the **ride's** location stream (for tracking), not to the dispatch pool.

## Reconnect handling

If the driver app reconnects after a brief dropout (network glitch), Redis state is restored from the WS handshake (`driver_id` + last known position). If state was `on_ride` before the drop, the app rejoins the ride channel.

## See also
- [[entity-driver]] · [[redis-usage]]
- [[journey-driver-go-online]] · [[module-realtime]] · [[module-dispatch]]
