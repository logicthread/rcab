---
title: Module — realtime
tags: [layer/backend, kind/module]
status: accepted
phase: 0
depends_on: [[nestjs-structure]]
related: [[websocket-events]], [[redis-usage]], [[ADR-0008-socketio-realtime]]
audience: both
---

# Module — `realtime`

*Socket.IO gateway + `RealtimeBus` provider.*

## Responsibilities

- Authenticate WS handshakes (JWT verify).
- Maintain socket → user mapping and room membership.
- Expose a typed `RealtimeBus` that other modules call to emit events.
- Use **Redis adapter from day one** (single-node usage is fine; the adapter is no-op overhead but enables multi-node later with zero code change).
- Handle `driver:location` events from drivers with a **per-driver 3 s in-memory throttle** (`Map<driverId, lastAcceptedMs>`); accepted events call `GEOADD active_drivers` and `HSET driver:state:<id> last_seen`.
- **Live fan-out (RCAB-E4.S7):** independent of the geo-index gate, when the sender is bound to a ride (`driver:state.current_ride_id`), mirror the position to room `ride:<id>` as `driver_location` at a **per-ride 1 Hz** debounce. The first packet per ride emits `DRIVER_FIRST_LOCATION_EVENT`, which `module-rides` turns into the implicit `start_en_route`. The gateway stays free of a `RidesRepository` dependency — it only emits domain events.
- Handle `ride:subscribe { rideId }` (RCAB-E4.S7): emit `RIDE_SUBSCRIBE_REQUEST_EVENT`; `module-rides` validates ownership then `RealtimeBus.joinRide`s the caller's sockets into `ride:<id>`.
- On WS reconnect of a known driver, **replay `driver_state { availability, current_ride_id }`** from `driver:state:<id>` Redis hash back to the connecting socket.

## Public providers

- `RealtimeBus`
  - `toUser(userId, event, payload)`
  - `toDriver(driverId, event, payload)`
  - `toRide(rideId, event, payload)`
  - `joinRide(userId, rideId)` / `joinPool(userId, rideId)` — place a user's sockets into a room
  - `broadcast(event, payload)` — rare, ops-only

## Why a bus and not call the gateway directly?

Modules should not import the WebSocket gateway. The bus is the seam — when we split realtime into its own process, the bus implementation swaps to "publish to Redis pub/sub" and nothing else changes.

## Rooms

| Room | Membership |
|---|---|
| `user:<user_id>` | the user's own sockets |
| `driver:<driver_id>` | driver's sockets |
| `ride:<ride_id>` | both parties (and any pooled passengers) for the live ride |

## See also
- [[websocket-events]] · [[redis-usage]]
- [[ADR-0008-socketio-realtime]]
