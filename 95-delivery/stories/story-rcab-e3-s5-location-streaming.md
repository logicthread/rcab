---
title: RCAB-E3.S5 — Location streaming (WS) + Redis GEOADD
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e3-driver-presence]]
demo: 2
estimate: m
hitl: no
depends_on: [[story-rcab-e3-s4-driver-online-toggle]], [[module-realtime]], [[websocket-events]], [[redis-usage]], [[driver-background-location]], [[driver-state-management]]
affected_notes: [[module-realtime]], [[websocket-events]], [[redis-usage]], [[driver-background-location]]
owner: claude
audience: both
---

# RCAB-E3.S5 — Location streaming (WS) + Redis GEOADD

## Goal

Connect the foreground service stub from RCAB-E3.S4 to real work: the Flutter app emits `driver:location` events over WebSocket every 5 seconds while online, and the API gateway updates `active_drivers` in Redis via `GEOADD` on each accepted event. With this story done, an ops dashboard can watch `GEOPOS active_drivers <driver_id>` and see it move in real time — fulfilling the "location stream visible in ops dashboard" part of Demo 2.

## User-facing acceptance criteria

- `Given` a driver is online and moving, `When` the foreground service runs, `Then` a `driver:location` WS event is emitted approximately every 5 seconds with current lat, lng, heading, and speed.
- `Given` the driver has moved less than 10 m since the last emission, `When` the timer fires, `Then` the event is skipped (no WS message sent) — but the local position indicator still updates.
- `Given` the driver emits location faster than every 3 seconds, `When` the server receives excess events, `Then` they are silently dropped server-side and the Redis `GEOADD` is called at most once per 3 s per driver.
- `Given` the WS connection drops and reconnects, `When` reconnected, `Then` location emission resumes automatically and the server restores the driver's state from `driver:state:<id>`.

## Technical acceptance criteria

### API

- `RealtimeGateway` in `modules/realtime/realtime.gateway.ts` — adds `@SubscribeMessage('driver:location')` handler:
  - Validates JWT identity matches a driver role (already enforced on WS handshake per [[module-realtime]]).
  - Throttle: maintains a per-driver `Map<string, number>` of last-accepted timestamps; drops the event (no action, no error) if `now - lastAccepted < 3000 ms`.
  - On accepted event: `GEOADD active_drivers <lng> <lat> <driver_id>` and `HSET driver:state:<driver_id> last_seen <epoch_ms>`.
  - Payload shape per [[websocket-events]]: `{ lat: number, lng: number, heading: number, speed: number }`.
- `RealtimeGateway.handleConnection()` — on WS connect from a known driver (JWT has `sub` with a matching `driver:state:<id>` HASH in Redis), replay current state to the connecting socket: emit `driver_state { availability, current_ride_id }` back to the socket.

### Flutter

- `lib/core/location/foreground_service.dart` — fill in the `FlutterForegroundTask` task callback stub from S4: on each 5-second tick, calls `geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.balanced)`, applies the 10 m debounce (compare against `_lastEmittedPosition`), and if not debounced calls `socketProvider.emit('driver:location', { lat, lng, heading, speed })`.
- `lib/di/providers.dart` — `locationStreamProvider` (`StreamProvider<Position>`) wraps `Geolocator.getPositionStream(locationSettings: LocationSettings(accuracy: LocationAccuracy.balanced, distanceFilter: 0))`. Used for local UI (position dot on future map); the foreground task uses one-shot `getCurrentPosition()` to keep battery usage deterministic.
- The foreground task and the main Isolate communicate via `FlutterForegroundTask`'s `sendDataToMain` / `receiveDataFromTask` channels — the task sends `{ lat, lng }` to the main isolate to update `locationStreamProvider`.
- The `socketProvider` is accessed inside the foreground task via a `MethodChannel` bridge — see [[driver-flutter-structure]] for the `core/realtime/` wiring pattern. The WS socket is owned by the main isolate; the foreground task requests an emit via the channel.

## Test plan

- Unit (Vitest): `RealtimeGateway` location handler — mock Redis client; assert `GEOADD` called on first event; assert second event within 3 s is dropped (no `GEOADD`); assert `last_seen` HSET called on accepted events.
- Integration (Testcontainers Redis): connect a mock Socket.IO client as an authenticated driver; emit `driver:location` twice within 1 s; assert Redis `GEOPOS active_drivers <driver_id>` reflects first position only; emit after 3 s delay; assert position updated.
- Unit (Flutter): `test/core/location/foreground_task_callback_test.dart` — mock `Geolocator.getCurrentPosition()`; assert emit called when distance > 10 m; assert emit skipped when distance < 10 m.
- Unit (Flutter): `test/core/location/location_stream_provider_test.dart` — assert provider emits positions from `Geolocator.getPositionStream()`.

## Out of scope

- Location fan-out to the ride client (`driver_location` event to client app) — that is RCAB-E4.S7.
- `on_ride` cadence (3 s) — the foreground task uses 5 s only; the on_ride cadence change is RCAB-E4.
- Ops dashboard UI to visualise the stream — Demo 2 validates it via `redis-cli GEOPOS`; a Grafana panel is RCAB-E8.

## Notes / questions

- `FlutterForegroundTask` runs in a separate Dart isolate. Accessing the dio-backed `socketProvider` from within the task requires a `MethodChannel` bridge — the recommended pattern is for the task to send a message to the main isolate which then calls `socket.emit()`. This keeps the WS connection in the main isolate where the Riverpod providers live. Document this bridge in `lib/core/realtime/`.
- The 10 m debounce is measured by `Geolocator.distanceBetween()`. Threshold source: [[driver-background-location]] § Sampling strategy.
- Server-side throttle is per-connection (in-memory `Map`), not per-user. If a driver opens two connections (edge case), both are throttled independently. This is acceptable for Phase-0.

## See also

- [[epic-e3-driver-presence]] · [[journey-driver-go-online]] · [[module-realtime]] · [[websocket-events]]
- [[redis-usage]] · [[driver-background-location]] · [[driver-state-management]]
- [[story-rcab-e3-s4-driver-online-toggle]] · [[ADR-0008-socketio-realtime]]
