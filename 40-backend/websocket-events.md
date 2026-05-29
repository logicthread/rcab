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
- `pool:<shared_ride_id>` — joined when the client opens or joins a shared-ride pool (server-side via `RealtimeBus.joinPool`); left implicitly when the socket disconnects

## Server → Client events

### Driver
| Event | Payload | When |
|---|---|---|
| `driver_state` | `{ availability, current_ride_id }` | Replayed to driver on WS reconnect (from `driver:state:<id>` Redis hash) |
| `ride_offer` | `{ offer_id, request?, ttl_ms, pickup, fare_est, est_pickup_eta_s }` (solo) or `{ offerId, sharedRideId, ttlMs, stops[], passengerCount, waveNumber }` (shared, E5.S4) | Top-K dispatch reaches this driver. `stops[].type` ∈ `pickup`/`dropoff`; `stops[]` is ordered: pickups first (by proximity to pool origin centroid), then drops (by proximity to dest centroid). Each entry carries `passengerId` + `sequenceIndex`. |
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
| `pool:update` | `{ sharedRideId, seatCount, poolStatus }` | Shared-ride pool transitions (RCAB-E5.S6). `poolStatus` ∈ `open` / `closed_full` / `closed_timeout`. Targeted at room `pool:<shared_ride_id>`. Emitted by `PoolLifecycleService` after `openPool`, `slotRequest`, and `closePool('closed_timeout' \| 'closed_full')`. |

## Client → Server events

| Event | Payload | Notes |
|---|---|---|
| `driver:location` | `{ lat, lng, heading, speed }` | sent every ~5s while online |
| `ride_offer_response` | `{ offerId, sharedRideId?, accept }` | E5.S4. `accept=true` w/ `sharedRideId` triggers `DispatchService.claimPool` (atomic Lua); decline just releases the offer lock. If `sharedRideId` is omitted the server resolves it via `offer:meta:<offerId>`. |
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
