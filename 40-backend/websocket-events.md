---
title: WebSocket events (Socket.IO)
tags: [layer/backend, kind/api]
status: accepted
phase: 0
depends_on: [[api-conventions]]
related: [[module-realtime]], [[ADR-0008-socketio-realtime]]
audience: both
---

# WebSocket events

*Transport: Socket.IO with Redis adapter. Auth: JWT in handshake.*

## Connection

```
GET /socket.io  (Sec-WebSocket-Protocol: rcab)
Handshake auth: { token: <rcab_jwt> }
```

On connect, server places the socket in personal + role rooms:

- `user:<user_id>` — all events for this user
- `driver:<driver_id>` — driver-specific events
- `ride:<ride_id>` — joined when a ride starts; left when it ends

## Server → Client events

### Driver
| Event | Payload | When |
|---|---|---|
| `driver_state` | `{ availability, current_ride_id }` | Replayed to driver on WS reconnect (from `driver:state:<id>` Redis hash) |
| `ride_offer` | `{ offer_id, request, ttl_ms, pickup, fare_est, est_pickup_eta_s }` | Top-K dispatch reaches this driver |
| `ride_offer_revoked` | `{ offer_id, reason }` | Someone else accepted / client canceled |
| `ride_state_changed` | `{ ride_id, state, by }` | Any state transition |
| `passenger_added` | `{ ride_id, request, new_route_polyline }` | Shared-ride: new joiner slotted |
| `force_offline` | `{ reason }` | Ops or server-side eviction |

### Client
| Event | Payload | When |
|---|---|---|
| `request_status` | `{ request_id, status, ... }` | Booking-flow state changes |
| `driver_assigned` | `{ ride_id, driver: {...}, vehicle: {...}, eta_s }` | Match made |
| `driver_location` | `{ ride_id, lat, lng, heading }` | Throttled 1Hz while ride is live |
| `ride_state_changed` | `{ ride_id, state }` | Ride lifecycle |
| `pool_update` | `{ request_id, pool_size, pool_closed_at }` | Shared-ride pooling |

## Client → Server events

| Event | Payload | Notes |
|---|---|---|
| `driver:location` | `{ lat, lng, heading, speed }` | sent every ~5s while online |
| `ping` | `{}` | for liveness; server replies `pong` |

## Throttling and back-pressure

- Driver location updates are accepted at most every 3 s; excess are dropped server-side with `429`-like soft signal.
- `driver_location` fan-out to client is rate-limited to 1 Hz with a server-side debouncer.

## Reconnect contract

- Client reconnects with the same JWT.
- Server replays critical state on reconnect: current ride (if any), pending offer (if any), driver state.

## See also
- [[module-realtime]] · [[ADR-0008-socketio-realtime]]
- [[api-conventions]] · [[rest-endpoints]]
