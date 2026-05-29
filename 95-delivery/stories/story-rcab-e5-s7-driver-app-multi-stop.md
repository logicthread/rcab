---
title: RCAB-E5.S7 — Driver app — multi-stop ride screen, per-passenger drop
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e5-shared-booking]]
demo: 4
estimate: m
hitl: yes
depends_on: [[story-rcab-e5-s4-shared-ride-dispatch]], [[driver-screens]], [[driver-state-management]], [[websocket-events]], [[module-realtime]]
affected_notes: [[driver-screens]], [[driver-state-management]], [[websocket-events]]
owner: claude
audience: both
---

# RCAB-E5.S7 — Driver app — multi-stop ride screen, per-passenger drop

## Goal

Once a shared pool is assigned to a driver, the driver app must guide them through multiple pickup and drop-off points in sequence. This story adds the `SharedRideScreen` Flutter widget, which shows the ordered stop list from the dispatch offer, lets the driver confirm each pickup and drop independently, and completes the ride only when the last passenger is dropped. The HITL stop is the demo walk of a full 2-passenger shared ride on the driver app.

## User-facing acceptance criteria

- `Given` the driver accepts a shared ride offer, `When` the shared ride screen opens, `Then` it shows all stops in order with passenger names and type labels (PICKUP / DROP).
- `Given` the driver reaches the first pickup location, `When` they tap "Picked up", `Then` that stop turns green, the map re-centres on the next stop, and a `stop:pickup_confirmed` event is sent to the server.
- `Given` all pickups are confirmed, `When` the driver reaches the first drop, `Then` "Drop off" button activates and tapping it sends `stop:drop_confirmed`.
- `Given` the driver confirms the last drop, `When` the event is accepted by the server, `Then` the ride state transitions to `completed` and the rating prompt appears.
- `Given` the WS connection drops mid-ride, `When` reconnected, `Then` the screen restores stop states from `driver:state:<id>` and highlights the current pending stop.

## Technical acceptance criteria

### Flutter

- `lib/features/shared_ride/shared_ride_screen.dart` — `SharedRideScreen` widget:
  - Receives `SharedRideOffer` (parsed from the `ride:offer` WS event `stops` array).
  - `StopListTile` per stop: renders passenger name, type badge (PICKUP / DROP), status icon (pending / confirmed).
  - "Confirm pickup / drop" button is enabled only for the current sequential stop (not skippable).
  - On button tap: emits `stop:pickup_confirmed` or `stop:drop_confirmed` with `{ rideId, stopIndex, passengerId }`.
  - On final drop confirmed: navigate to `RatingScreen`.
- `lib/features/shared_ride/shared_ride_provider.dart` — `SharedRideState` Riverpod `StateNotifier`:
  - `stops: List<StopState>` where `StopState = { stop: Stop, status: pending | confirmed }`.
  - `currentStopIndex`: index of next unconfirmed stop.
  - Updates on incoming `stop:pickup_confirmed` / `stop:drop_confirmed` server echoes.
- `lib/core/realtime/socket_provider.dart` — subscribe to `stop:pickup_confirmed` / `stop:drop_confirmed` events (server echos back confirmation with timestamp).

### API

- `RealtimeGateway` — add `@SubscribeMessage('stop:pickup_confirmed')` and `@SubscribeMessage('stop:drop_confirmed')`:
  - Validates driver identity and `rideId`.
  - Updates `ride_stops` table: `confirmed_at = now`.
  - On last drop confirmed: triggers ride completion flow (reuse E4.S6 completion path).
  - Emits server echo back to driver socket.
- `ride_stops` table: `(ride_id, sequence_index, passenger_id, type, lat, lng, confirmed_at)`.

## Test plan

- **Unit (Flutter):** `test/features/shared_ride/shared_ride_provider_test.dart` — assert `currentStopIndex` advances on each confirmation; assert ride completion triggered when all drops confirmed; assert WS connection drop restores state.
- **Unit (Vitest):** `realtime.gateway.spec.ts` — assert `stop:pickup_confirmed` updates DB; assert server echo emitted; assert completion triggered on last drop.
- **Integration (Testcontainers):** full pool dispatch → driver accept → emit 2 pickup + 2 drop confirmations → assert ride `status = completed`.
- **HITL demo:** dev runs driver app on device/emulator, walks the 2-passenger shared ride flow end to end.

## HITL stops

1. Demo walk with 2 simultaneous shared requests pooled into one ride, driver app showing both stops, each confirmed independently. Dev signs off in PR description.

**HITL deferred (2026-05-29):** the demo walk requires a real client-driver flow (web client posting `/v1/rides` with `type=shared` from a real auth session). Phase-0 carve-out: `RidesController` requires a real client JWT, but no client UI exists yet for shared bookings outside of E5.S6's seeded preset flow. Story stays `in_progress` until E4 (Normal booking) lands the client booking screens; HITL sign-off happens together with the first E4 + E5 demo dry-run. All code is in and verified via integration tests (`ride-lifecycle.int.spec.ts` runs the full pool → dispatch → claim → 2 pickups + 2 drops → `pool_state='completed'` path against real Postgres + Redis).

## Out of scope

- Optimised stop reordering mid-ride (e.g. a passenger cancels en-route) — Phase-1.
- Turn-by-turn navigation inside the app — deep link to Google Maps (existing [[driver-google-maps-handoff]]).
- Multi-stop map polyline overlay — Phase-1.

## Notes / questions

- `ride_stops` table should be seeded by `DispatchService.dispatchPool()` when the pool is assigned.
- The driver app's `ride:offer` event parser must handle both `stops: undefined` (normal ride) and `stops: [...]` (shared ride) to maintain backward compatibility with E4.

## See also

- [[epic-e5-shared-booking]] · [[driver-screens]] · [[driver-state-management]]
- [[websocket-events]] · [[module-realtime]]
- [[story-rcab-e5-s4-shared-ride-dispatch]] · [[story-rcab-e5-s6-web-booking-share-ui]]
