---
title: RCAB-E3.S4 — Online / offline toggle + foreground service
tags: [layer/delivery, kind/story]
status: ready
phase: 0
epic: [[epic-e3-driver-presence]]
demo: 2
estimate: l
hitl: no
depends_on: [[story-rcab-e3-s1-flutter-app-skeleton]], [[story-rcab-e3-s2-firebase-otp-flutter]], [[story-rcab-e3-s3-vehicle-registration]], [[journey-driver-go-online]], [[sm-driver-availability]], [[redis-usage]], [[rest-endpoints]], [[module-realtime]], [[driver-state-management]], [[driver-background-location]]
blocks: [[story-rcab-e3-s5-location-streaming]], [[story-rcab-e3-s6-oem-kill-mitigation]]
affected_notes: [[rest-endpoints]], [[redis-usage]], [[sm-driver-availability]], [[module-realtime]], [[driver-state-management]]
owner: claude
audience: both
---

# RCAB-E3.S4 — Online / offline toggle + foreground service

## Goal

The core of Demo 2. Implement the full go-online / go-offline flow per [[journey-driver-go-online]]: API endpoints that update Redis and Postgres, the Flutter home screen toggle that starts/stops the Android foreground service, and the server-side 60-second auto-offline heartbeat. When this story is done, a driver can tap the toggle, appear in `active_drivers` in Redis, and be evicted automatically if they go silent.

## User-facing acceptance criteria

- `Given` I am signed in with a selected vehicle, `When` I tap the big online toggle on `/home`, `Then` the toggle turns green, an ongoing Android notification "rcab — You are online" appears, and my status changes to online.
- `Given` I am online, `When` I tap the toggle again to go offline, `Then` the notification disappears, the toggle turns grey, and my status changes to offline.
- `Given` I am online but my app is backgrounded and sends no location for 60 seconds, `When` the server auto-offline fires, `Then` I receive a `force_offline` WS event, the toggle returns to grey, and the foreground service stops.
- `Given` I am signed in but have no selected vehicle (`current_vehicle_id` is null), `When` I tap the online toggle, `Then` a message "Please select a vehicle before going online" is shown and the API call is not made.
- `Given` I am online, `When` the app is killed and relaunched, `Then` the foreground service is still running, and on WS reconnect the server restores my `online` state.

## Technical acceptance criteria

### API

- `modules/drivers/drivers.controller.ts` + `drivers.service.ts`:
  - `POST /v1/drivers/online` 🔒🚗 — body `{ lat: number, lng: number }`; rejects with `400 no_vehicle_selected` if `driver.current_vehicle_id` is null; calls `DriversService.goOnline(driverId, lat, lng)`:
    1. `GEOADD active_drivers <lng> <lat> <driver_id>` (note: Redis GEO uses lng-first).
    2. `HSET driver:state:<driver_id> availability online last_seen <epoch_ms>`.
    3. `UPDATE drivers SET availability='online' WHERE user_id=<driver_id>` (Postgres denorm).
    4. Returns `{ ok: true, session_id: <uuid> }`.
  - `POST /v1/drivers/offline` 🔒🚗 — calls `DriversService.goOffline(driverId)`:
    1. `ZREM active_drivers <driver_id>`.
    2. `DEL driver:state:<driver_id>`.
    3. `UPDATE drivers SET availability='offline' WHERE user_id=<driver_id>`.
    4. Returns `{ ok: true }`.
- **Auto-offline heartbeat** — a `@Cron('*/15 * * * * *')` (every 15 s) job in `DriversService` scans `driver:state:*` HASHes for `last_seen` older than 60 s and calls `goOffline()` for each stale driver, then emits `force_offline { reason: "timeout" }` via `RealtimeBus.toDriver(driverId, 'force_offline', { reason: 'timeout' })`.
- `RealtimeGateway` (in [[module-realtime]]) handles the `force_offline` server → client event — no new handler needed, it is a server-push event routed through `RealtimeBus`.

### Flutter

- `lib/features/home/home_screen.dart` — large `Switch` or `ElevatedButton.icon` toggle in the centre of the screen; reads `driverStateProvider`; on toggle to online: (1) checks `driverStateProvider.currentVehicleId != null`, else shows snackbar; (2) calls `POST /v1/drivers/online` with current GPS position (one-shot `geolocator.getCurrentPosition()`); (3) on 200 calls `_startForegroundService()`; (4) connects `socketProvider` WS.
- `lib/core/location/foreground_service.dart` — wraps `FlutterForegroundTask`: `startService()` sets `ForegroundTaskConfig(notificationTitle: 'rcab', notificationText: 'You are online', interval: 5000)`; `stopService()` stops it. Task callback is a no-op stub in this story (location emit is wired in RCAB-E3.S5).
- `lib/di/providers.dart` — `driverStateProvider` (`StateNotifier<DriverState>`) with `DriverState` sealed: `offline | online(vehicleId) | onRide(vehicleId, rideId)`. `goOnline()` and `goOffline()` methods call the API and update local state.
- `socketProvider` (`Provider<io.Socket>`) — lazy: creates `io.io(API_BASE_URL, OptionBuilder().setAuth({'token': jwt}).build())`. Connected on first `goOnline()`, disconnected on `goOffline()`. Registers handler for `force_offline`: calls `driverStateProvider.notifier.goOffline()` + stops foreground service.
- Auth guard in `app_router.dart` (from S1) ensures `/home` is only reachable when `authProvider` is `authenticated`.

## Test plan

- Unit (Vitest): `DriversService.goOnline` — mock Redis client and Drizzle; assert `GEOADD` called with `(lng, lat, driver_id)` order; assert `HSET` sets `availability=online`; assert 400 returned when `current_vehicle_id` is null.
- Unit (Vitest): `DriversService.goOffline` — assert `ZREM active_drivers` and `DEL driver:state:<id>` called.
- Unit (Vitest): auto-offline cron — seed a stale `driver:state:<id>` HASH (last_seen > 60s ago); run the job; assert `ZREM` called and `RealtimeBus.toDriver` called with `force_offline`.
- Integration (Testcontainers Postgres + real Redis via Testcontainers): `POST /v1/drivers/online` → assert `ZSCORE active_drivers <driver_id>` is non-null; `POST /v1/drivers/offline` → assert `ZSCORE` is null and `driver:state:<id>` does not exist; assert Postgres `availability` column updated.
- Unit (Flutter): `test/features/home/driver_state_provider_test.dart` — assert `offline → online` transition on `goOnline()` success; assert `online → offline` on `force_offline` event; assert snackbar emitted when `currentVehicleId` is null.

## Out of scope

- Location streaming to the WS — that is RCAB-E3.S5. The foreground service task callback is a stub in this story.
- OEM battery whitelist onboarding — that is RCAB-E3.S6.
- The `online → on_ride` state transition — that is RCAB-E4 (ride dispatch).
- Ops-initiated `force_offline` (via admin API) — deferred.

## Notes / questions

- The 60-second auto-offline window is defined in [[sm-driver-availability]] and [[journey-driver-go-online]]. The cron runs every 15 s to stay within budget but only acts on drivers whose `last_seen` is older than 60 s — this is a deliberate 15-s polling trade-off to avoid Redis keyspace notifications in Phase-0.
- `FlutterForegroundTask` requires `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` at runtime on some OEM ROMs. The permission request is deferred to RCAB-E3.S6 (OEM onboarding). This story just starts the service; battery-whitelist guidance comes later.
- On WS reconnect the server replays driver state per [[websocket-events]] reconnect contract. The Flutter `socketProvider` reconnects automatically (Socket.IO built-in); the server-side reconnect handler is part of [[module-realtime]] (ensure `driver:state:<id>` is read and replayed on `connect` event from a known driver).

## See also

- [[epic-e3-driver-presence]] · [[journey-driver-go-online]] · [[sm-driver-availability]] · [[redis-usage]]
- [[rest-endpoints]] · [[module-realtime]] · [[websocket-events]]
- [[driver-state-management]] · [[driver-background-location]] · [[driver-screens]]
- [[story-rcab-e3-s3-vehicle-registration]] · [[story-rcab-e3-s5-location-streaming]] · [[story-rcab-e3-s6-oem-kill-mitigation]]
