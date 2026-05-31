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
| `ride_offer` | `{ offerId, rideId, ttlMs, pickup:{lat,lng}, dropoff:{lat,lng}, fareCents, waveNumber }` (solo, E4.S3) or `{ offerId, sharedRideId, ttlMs, stops[], passengerCount, waveNumber }` (shared, E5.S4) | Top-K dispatch reaches this driver. The two are distinguished by the presence of `stops[]`. `stops[].type` ∈ `pickup`/`dropoff`; `stops[]` is ordered: pickups first (by proximity to pool origin centroid), then drops (by proximity to dest centroid). Each entry carries `passengerId` + `sequenceIndex`. |
| `ride_offer_accepted` | `{ offerId, rideId }` | Solo (E4.S4): the winning driver's first-accept-wins claim (`claim:ride:<id>`) succeeded — the driver app routes to the active ride. |
| `ride_offer_revoked` | `{ offerId, rideId?, reason }` | Someone else accepted / client canceled. Solo (E4.S4) `reason` ∈ `taken` / `unavailable`. |
| `ride_state_changed` | `{ rideId, state, by }` | Solo ride lifecycle transition (RCAB-E4.S6/S8). Emitted to room `ride:<id>` by `RideStateMachine` after each `POST /v1/rides/:id/state` *or* `POST /v1/rides/:id/cancel` commit. `state` ∈ `accepted`/`en_route`/`arrived`/`in_progress`/`completed` plus terminal `cancelled`/`no_show` (RCAB-E4.S8); `by` ∈ `driver`/`client` (the acting party — a client cancel carries `by: 'client'`). |
| `passenger_added` | `{ ride_id, request, new_route_polyline }` | Shared-ride: new joiner slotted |
| `force_offline` | `{ reason }` | Ops or server-side eviction |

### Client
| Event | Payload | When |
|---|---|---|
| `request_status` | `{ request_id, status, ... }` | Booking-flow state changes |
| `driver_assigned` | `{ ride_id, driver: {...}, vehicle: {...}, eta_s }` | Match made |
| `driver_location` | `{ rideId, lat, lng, heading }` | RCAB-E4.S7. Live driver position, emitted to room `ride:<id>` **only while the driver is bound to that ride** (`driver:state.current_ride_id` set), rate-limited to **1 Hz per ride**. camelCase, matching `ride_state_changed`. |
| `ride_state_changed` | `{ rideId, state, by }` | Ride lifecycle (RCAB-E4.S6). The same event + room (`ride:<id>`) as the driver side; the booking client joins `ride:<id>` at request time so it follows the ride live. **RCAB-E4.S7** also emits `state: 'accepted'` at solo-claim time (from `DispatchService`) so the rider's tracking view activates the instant a driver accepts, and the driver's first location packet auto-emits `state: 'en_route'` (implicit `start_en_route`). **RCAB-E4.S8** adds the terminal `state: 'cancelled'` / `'no_show'` (with `by` = the acting party) — the rider's tracking view shows the terminal banner and stops following. |
| `pool:update` | `{ sharedRideId, seatCount, poolStatus }` | Shared-ride pool transitions (RCAB-E5.S6). `poolStatus` ∈ `open` / `closed_full` / `closed_timeout`. Targeted at room `pool:<shared_ride_id>`. Emitted by `PoolLifecycleService` after `openPool`, `slotRequest`, and `closePool('closed_timeout' \| 'closed_full')`. |

## Client → Server events

| Event | Payload | Notes |
|---|---|---|
| `driver:location` | `{ lat, lng, heading, speed }` | sent at the foreground-service cadence while online; the server applies two independent gates (see Throttling). |
| `ride:subscribe` | `{ rideId }` | RCAB-E4.S7. Client (or driver) asks to (re)join `ride:<id>`. The gateway emits a domain event; `module-rides` validates the caller is the ride's passenger or bound driver (`RidesRepository.findById`) then `RealtimeBus.joinRide`. Re-emitted on every (re)connect — covers the create-time join race + full page reloads. |
| `ride_offer_response` | `{ offerId, sharedRideId?, accept }` | E5.S4. `accept=true` w/ `sharedRideId` triggers `DispatchService.claimPool` (atomic Lua); decline just releases the offer lock. If `sharedRideId` is omitted the server resolves it via `offer:meta:<offerId>`. **Solo (E4.S4):** no `sharedRideId` — `accept=true` → `claimSolo` (`claim:ride:<id>` SET NX, then bind the `rides` row); `accept=false` → `DEL offer:<offerId>` (releases the lock, no claim). |
| `stop:pickup_confirmed` | `{ rideId, sequenceIndex }` | RCAB-E5.S7. Driver-only. Validated against `shared_rides.claimed_by_driver_id`. Must target the next pending stop with `type='pickup'`. Server updates `ride_stops.confirmed_at`, transitions `shared_rides.pool_state` to `closed_started` on the first pickup, and echoes the same event name back to the driver socket with `{ rideId, sequenceIndex, passengerId, type, confirmedAt, rideCompleted }`. |
| `stop:drop_confirmed` | `{ rideId, sequenceIndex }` | RCAB-E5.S7. Same validation as `stop:pickup_confirmed` but for `type='dropoff'`. When the last pending stop is confirmed: `shared_rides.pool_state='completed'` + `completed_at` set, `driver:state:<driverId>.current_ride_id` cleared, and `ride:completed { rideId, completedAt }` broadcast to room `ride:<rideId>`. |
| `ping` | `{}` | for liveness; server replies `pong` |

## Throttling and back-pressure

The inbound `driver:location` stream feeds **two independent gates** (RCAB-E4.S7), both off the raw packet stream:

- **Geo-index freshness** — `GEOADD active_drivers` + `HSET driver:state last_seen` are gated per-driver at most once every **3 s** (presence freshness; excess dropped).
- **Client fan-out** — `driver_location` to the ride room is gated per-ride at **1 Hz** with a server-side debouncer (the smooth-dot rate). The driver may stream faster than either gate; the gates decouple presence cost from client smoothness.

## Reconnect contract

- Client reconnects with the same JWT.
- Server replays critical state on reconnect: current ride (if any), pending offer (if any), driver state.
- **Shared rides (RCAB-E5.S7):** the `driver_state` replay carries `current_ride_id`. The driver app then issues `GET /v1/rides/:id/stops` to hydrate stop statuses + `currentStopIndex` deterministically rather than receiving them through the socket. `ride:completed` is not replayed; if a ride completed while the driver was offline, the REST stop list returns all stops with `confirmed=true` and `poolStatus='completed'`.

## See also
- [[module-realtime]] · [[ADR-0008-socketio-realtime]]
- [[api-conventions]] · [[rest-endpoints]]
