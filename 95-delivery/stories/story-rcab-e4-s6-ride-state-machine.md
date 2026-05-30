---
title: RCAB-E4.S6 — Ride state machine (solo: accepted → … → completed)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: l
hitl: yes
depends_on: [[story-rcab-e4-s5-driver-offer-screen]], [[story-rcab-e4-s2-quote-request-endpoints]], [[sm-ride-lifecycle]], [[module-rides]], [[driver-screens]], [[websocket-events]], [[rest-endpoints]], [[entity-ride]]
affected_notes: [[sm-ride-lifecycle]], [[module-rides]], [[websocket-events]], [[rest-endpoints]], [[driver-screens]], [[journey-driver-complete-ride]]
owner: claude
audience: both
---

# RCAB-E4.S6 — Ride state machine (solo: accepted → … → completed)

## Goal

E4.S4 binds a solo `rides` row to its driver (`status='accepted'`, `driver_id`, `accepted_at`) and E4.S5 routes the winning driver to `/ride/:rideId` — but that screen is a stub (`Ride <id>`) and the ride has nowhere to go: `rides.status` sits at `accepted` forever. This story builds the **forward solo ride lifecycle** — the driver advancing the ride `accepted → en_route → arrived → in_progress → completed` — as a single guarded state machine over the `rides` table, plus the real `/ride/:id` driver screen (state-driven action buttons + a prominent "Navigate" deeplink) and the `ride_state_changed` broadcast that lets the booking client follow along. The transport contract already exists in the vault (`POST /v1/rides/:id/state { event }` per [[rest-endpoints]]; `ride_state_changed` per [[websocket-events]]); this story makes it real for solo rides and reconciles the [[sm-ride-lifecycle]] state names with what migration 0006 actually shipped. **Cancellation, no-show, and fee tiers are explicitly E4.S8** — this story is the happy path only.

The existing `RideLifecycleService` is **shared-only** (stop-list-driven over `shared_rides` / `ride_stops`, advanced by WS `stop:pickup_confirmed`); it does not model the solo `rides.status` column. Solo gets its own status-column FSM (*J2*).

## User-facing acceptance criteria

- `Given` a driver on `/ride/:id` for a freshly-accepted ride, `When` they tap **Start trip**, `Then` the ride moves to `en_route`, the booking client receives `ride_state_changed { rideId, state: 'en_route' }`, and the screen now shows **Arrived** as the next action.
- `Given` an `en_route` ride, `When` the driver taps **I've arrived**, `Then` the ride moves to `arrived` and the client is notified.
- `Given` an `arrived` ride, `When` the driver taps **Start ride**, `Then` the ride moves to `in_progress` and the "Navigate" target flips from the pickup point to the dropoff point.
- `Given` an `in_progress` ride, `When` the driver taps **End ride**, `Then` the ride moves to `completed`, the client is notified, the driver's `driver:state.current_ride_id` is cleared, and the driver app routes on to `/rating/:id` (the stub from E5.S7).
- `Given` any state of an active ride, `When` the driver taps **Navigate**, `Then` Google Maps opens to the current target (pickup while `en_route`/`arrived`, dropoff once `in_progress`).
- `Given` an out-of-order action (e.g. **Start ride** is somehow sent on an `en_route` ride), `When` the server processes it, `Then` it is rejected (HTTP 409, no state change) and the screen re-syncs to the true state.
- `Given` a driver re-opens the app mid-ride, `When` `/ride/:id` mounts, `Then` `GET /v1/rides/:id` hydrates the current state and the correct action button (reconnect-restore, mirroring the shared-ride `driver_state` restore).

## Technical acceptance criteria

### API (apps/api — `module-rides`)

- **`RideStateMachine` service** (new, in `modules/rides/`) implementing [[sm-ride-lifecycle]]'s `apply(rideId, driverId, event)` contract:
  - SELECT the `rides` row `FOR UPDATE` inside a transaction; assert `driver_id === driverId` (only the claimed driver transitions); validate the `(fromState, event)` pair against the forward transition table; write the new `status` + the matching timestamp column; emit on the realtime bus. Illegal transitions and non-owner callers are rejected without a write.
  - Forward events only this story: `start_en_route` (`accepted → en_route`), `mark_arrived` (`en_route → arrived`), `start_ride` (`arrived → in_progress`), `end_ride` (`in_progress → completed`). `end_ride` also clears `driver:state.current_ride_id` (reuse the helper pattern from `RideLifecycleService.clearDriverCurrentRide`).
- **`POST /v1/rides/:id/state`** (driver-only, `AuthGuard` + role `driver`) — body `{ event }`; 200 with the updated `{ rideId, status }` on success, 409 `invalid_transition` on a bad `(state, event)`, 403 if the caller is not the bound driver, 404 if unknown. Matches the [[rest-endpoints]] row already declared.
- **`GET /v1/rides/:id`** (client *or* the bound driver) — returns the ride incl. current `status` + the timestamp trail; used for reconnect-restore and the client status panel. (404/403 guards mirror `GET /v1/rides/:id/stops`.)
- **`ride_state_changed` emit** — on every successful transition, `bus.toRide(rideId, 'ride_state_changed', { rideId, state, by: 'driver' })` so the booking client room follows the ride live.
- **Migration 0008** — add the lifecycle timestamp columns to `rides`: `en_route_at`, `arrived_at`, `started_at`, `completed_at` (all `timestamptz NULL`); `accepted_at` already exists (0007). No CHECK change needed — migration 0006 already permits `en_route`/`arrived`/`in_progress`/`completed` (*J1*).

### Flutter (apps/driver-app — `/ride/:id`)

- **`RideController` + `ride_provider.dart`** (mirrors `offer_controller` / `shared_ride_controller`): holds `{ rideId, status, pickup, dropoff }`; subscribes to `ride_state_changed` (own ride only, matched by `rideId`); exposes `advance(event)` → `POST /v1/rides/:id/state` (Dio); on `completed` routes to `/rating/:id`; on mount hydrates via `GET /v1/rides/:id`.
- **`RideScreen`** (replace the stub) — state-driven single primary action button (Start trip / I've arrived / Start ride / End ride keyed off `status`), a prominent **Navigate** button (`driver-screens`: "the most prominent thing on the ride screen") that launches the Google Maps nav intent, and pickup/dropoff context. Keep `Key('ride_screen')` so the router smoke test stays green.
- **Navigate deeplink** via `url_launcher` (`google.navigation:q=<lat>,<lng>&mode=d` Android geo-intent; driver-app is Android-only Phase-0 — *J6*). Target = pickup until `in_progress`, then dropoff.

### Vault reconciliation

- **[[sm-ride-lifecycle]]** — the note's states are `en_route_pickup` / `arrived_pickup`, but migration 0006 shipped `en_route` / `arrived` for the solo `rides` table (*J1*). Reconcile: document that the solo lifecycle uses `en_route`/`arrived` (the `_pickup` suffix is a shared multi-stop concept); keep the diagram but add an as-built note for the solo column values.
- **[[websocket-events]]** — two inconsistent `ride_state_changed` rows exist (`{ ride_id, state, by }` vs `{ ride_id, state }`). Collapse to one as-built row: `{ rideId, state, by }` (camelCase, room `ride:<id>`), emitted by `RideStateMachine` on each solo transition; note it is the solo analogue of the shared `stop:*_confirmed` echoes.
- **[[rest-endpoints]]** — confirm/annotate `POST /v1/rides/:id/state` and `GET /v1/rides/:id` as shipped in this story (event vocabulary = the four forward events; cancel via `/cancel` remains E4.S8).
- **[[driver-screens]]** — flesh the `/ride/:id` row: the four state buttons, Navigate target rule, reconnect-restore via `GET /v1/rides/:id`, auto-route to `/rating/:id` on `completed`.
- **[[journey-driver-complete-ride]]** — align the complete-ride journey with the as-built REST-driven solo transitions (one-line transport note if the diagram shows otherwise, à la S5's `journey-driver-accept-ride` correction).

## Test plan

- **Unit (API — `ride-state-machine.service.spec.ts`):** each legal forward transition writes the right status + timestamp; every illegal `(state, event)` pair is rejected with no write; a non-owner driver is rejected; `end_ride` clears `current_ride_id` and emits `ride_state_changed`.
- **Integration (API — Testcontainers postgres + redis):** `POST /v1/rides/:id/state` walks a real ride `accepted → en_route → arrived → in_progress → completed`, asserting 409 on an out-of-order event and 403 for a driver who is not the bound driver; `GET /v1/rides/:id` returns the live state + timestamp trail. **Real containers, no infra mocks.**
- **Unit (Flutter — `ride_controller_test.dart`):** `advance(event)` issues the right POST; a `ride_state_changed` for *this* ride updates state, for another `rideId` is ignored; `completed` triggers `/rating/:id`; reconnect hydrate from a stubbed `GET /v1/rides/:id`.
- **Widget (Flutter — `ride_screen_test.dart`):** the correct primary button renders per status; tapping it calls the controller; Navigate target flips at `in_progress`; `Key('ride_screen')` present.
- Gate: `pnpm test` + `/flutter-test unit widget` + `/lint`.

## HITL stops

1. **Demo-3 complete-a-ride leg** — "driver taps through Start → Arrived → Start ride → End ride and the client watches it happen." Batched into the E4 end-to-end demo walk; sign off there. As with E4.S5 / E5.S7, the live walk needs a real client→driver flow and is expected to be **deferred to the first E4 end-to-end dry-run**; code lands and is verified by API integration + Flutter tests until then.

## Out of scope

- **Cancellation (`cancel_driver` / `cancel_client`), no-show, and fee tiers — RCAB-E4.S8.** The `rides.status` CHECK already has `cancelled`; the `POST /v1/rides/:id/cancel` endpoint and the 5-min no-show timer are S8. This story adds no cancel/no_show transitions.
- **Driver location → client (1 Hz) and the live map / ETA — RCAB-E4.S7.** Hence `start_en_route` is an **explicit button** here (*J3*), not the sm-note's "implicit on first location update" — that wiring lands in S7 once the location stream exists.
- **Client-side live ride-status UI** (the rider's "your driver is en route / has arrived" panel) — pairs with E4.S7's map; S6 only emits `ride_state_changed`. (Flag at pickup — *J5*.)
- **Shared-ride lifecycle** — already shipped (E5.S7, `RideLifecycleService`); untouched beyond not regressing it.
- **Rating capture** — `/rating/:id` is the E5.S7 stub; full rating is RCAB-E7.S1. S6 only routes to it.

## Notes / questions — to resolve at pickup

- **J1 — state-name drift (DB CHECK vs sm-note):** migration 0006 shipped `en_route` / `arrived`; [[sm-ride-lifecycle]] says `en_route_pickup` / `arrived_pickup`. (A) **keep the shipped `en_route`/`arrived`** and reconcile the note (the `_pickup` suffix is shared-multi-stop-only; a CHECK change = another migration for zero solo benefit) *(recommended)*; vs (B) migrate the column to the suffixed names *(churn, rejected)*.
- **J2 — solo state machine ownership:** (A) a **new `RideStateMachine` service** over `rides.status` per the sm-note's `apply()` design *(recommended — the existing `RideLifecycleService` is stop-driven over `shared_rides`; solo is a single status column; unifying is a bigger refactor than Phase-0 wants)*; vs (B) extend `RideLifecycleService` *(couples two different shapes; rejected)*.
- **J3 — `start_en_route` trigger:** explicit **Start trip** button this story *(recommended — driver→ride location streaming is E4.S7; "implicit on first location update" needs that stream)*; revisit auto-advance in S7.
- **J4 — audit of transitions:** (A) **timestamp columns** on `rides` (`en_route_at` … `completed_at`) + the `ride_state_changed` event as the live trail *(recommended for Phase-0)*; vs (B) a separate `ride_status_events` audit table *(event-sourced; heavier; defer to E7 dashboards if ever needed)*.
- **J5 — client live status UI scope:** keep it **out** (driver + API only; emit `ride_state_changed`) *(recommended — the rider panel pairs with E4.S7's map)*; or add a thin client status line now? Confirm at pickup.
- **J6 — Navigate deeplink + dependency:** `url_launcher` with the Android `google.navigation:q=lat,lng&mode=d` intent *(recommended; Android-only Phase-0)*. Adds the `url_launcher` pub dep — a pubspec change, not a system package, so not a HITL stop, but flagged.

## See also

- [[epic-e4-normal-booking]] · [[sm-ride-lifecycle]] · [[module-rides]] · [[entity-ride]]
- [[driver-screens]] · [[websocket-events]] · [[rest-endpoints]] · [[journey-driver-complete-ride]]
- [[story-rcab-e4-s5-driver-offer-screen]] · [[story-rcab-e4-s2-quote-request-endpoints]]
