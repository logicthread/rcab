---
title: RCAB-E4.S7 — Driver location → client live tracking (1 Hz fan-out)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: l
hitl: yes
depends_on: [[story-rcab-e4-s6-ride-state-machine]], [[story-rcab-e4-s5-driver-offer-screen]], [[story-rcab-e3-s5-location-streaming]], [[sm-ride-lifecycle]], [[module-realtime]], [[websocket-events]], [[web-osm-integration]], [[journey-client-book-normal]], [[module-rides]], [[entity-ride]]
blocks:
affected_notes: [[websocket-events]], [[module-realtime]], [[sm-ride-lifecycle]], [[web-pages-routes]], [[web-osm-integration]], [[web-state-management]], [[journey-client-book-normal]]
owner: claude
audience: both
---

# RCAB-E4.S7 — Driver location → client live tracking (1 Hz fan-out)

## Goal

E3.S5 already streams the driver's GPS over WS (`driver:location { lat, lng, heading, speed }` → `RealtimeGateway.handleDriverLocation` → `GEOADD active_drivers` + `driver:state:<id>.last_seen`, throttled to one write per 3 s) — but that stream goes only to the geo-index; **the rider never sees it**. E4.S6 put the booking client into room `ride:<id>` (`RealtimeBus.joinRide` at request time) and emits `ride_state_changed` there. This story closes the live-tracking loop:

1. **Fan the driver's location out to the ride's client room** as `driver_location { rideId, lat, lng, heading }`, rate-limited to **1 Hz per ride**, **only while that driver is on an active ride** (privacy: a driver not on a ride feeds only the geo-index).
2. **Light up the rider's live-tracking view on web** — the driver's marker moving on the existing booking-page Leaflet map + a status banner fed by `ride_state_changed`. This first requires **enabling solo booking on web** (the private/"Book" button is still disabled — `createSharedRide` is the only create path today), so wiring the disabled button → `POST /v1/rides` `type:normal` is in scope here (scope-fork resolution — *bundle*, see Notes).
3. **Wire the implicit `start_en_route`-on-first-location transition** that E4.S6 explicitly deferred here — so the ride flips `accepted → en_route` the moment the driver's app starts streaming, without anyone tapping a button.

The transport is already declared in [[websocket-events]] (`driver_location` client event "throttled 1 Hz while ride is live"; the throttling section names both the 3 s geo-index gate and the 1 Hz fan-out debouncer). This story makes it real and reconciles the payload shape (snake → camelCase, matching `ride_state_changed`) and the two-throttle design.

## User-facing acceptance criteria

- `Given` a rider whose solo ride was just accepted, `When` the driver's app begins streaming location, `Then` the rider's booking screen switches to a live-tracking view showing the driver's marker on the map and a "Driver is on the way" status.
- `Given` an active ride, `When` the driver sends location updates faster than once per second, `Then` the rider receives `driver_location { rideId, lat, lng, heading }` **at most once per second** (a smooth dot, no flooding).
- `Given` the driver's **first** location update after accepting, `When` the server receives it, `Then` the ride auto-advances `accepted → en_route` (the rider's banner flips to "Driver en route") with no driver tap — and E4.S6's explicit **Start trip** button remains a harmless no-op fallback (*J3*).
- `Given` the ride moves through `arrived` / `in_progress` (via the E4.S6 driver buttons), `When` each transition commits, `Then` the rider's status banner updates live from `ride_state_changed`.
- `Given` the ride reaches `completed`, `When` the final transition commits, `Then` the rider stops receiving `driver_location` and the tracking view shows "Trip complete".
- `Given` a rider reloads the page mid-ride, `When` the tracking view mounts, `Then` it rehydrates the current status from `GET /v1/rides/:id` and the marker resumes on the next `driver_location`.
- `Given` a driver who is **not** on any ride, `When` they stream location while online, `Then` only the geo-index is updated and **no** `driver_location` is fanned out to any client (privacy gate).

## Technical acceptance criteria

### API (apps/api — `module-realtime` / `module-rides`)

- **Location fan-out** — extend `RealtimeGateway.handleDriverLocation`: independent of the existing 3 s geo-index throttle, look up the driver's `current_ride_id` (from `driver:state:<driverId>`, already read/written in this handler). If set, emit `driver_location { rideId, lat, lng, heading }` to room `ride:<rideId>` via `RealtimeBus.toRide`, gated by a **separate 1 Hz-per-ride debouncer** applied to the raw inbound stream (the 3 s gate stays for `GEOADD`/`last_seen` only — *J1*, *J2*).
- **Implicit `start_en_route`** — on the **first** location packet seen for a given `current_ride_id`, emit a gateway domain event (mirroring `RIDE_OFFER_RESPONSE_EVENT` / `STOP_CONFIRM_REQUEST_EVENT`) consumed by the rides module, which calls `RideStateMachine.apply(rideId, driverId, 'start_en_route')` and **swallows `invalid_transition`** (the ride may already be past `accepted`). An in-memory once-guard keeps it to a single attempt per ride; ownership + from-state are enforced by the state machine (*J3*).
- **Client activation on accept** — emit a thin `ride_state_changed { rideId, state: 'accepted', by: 'driver' }` to `ride:<rideId>` at solo-claim time so the rider's tracking view activates the instant a driver accepts (before the first GPS packet). The richer `driver_assigned { driver, vehicle, eta_s }` payload from [[websocket-events]] is **deferred** (needs a driver/vehicle profile join) — *J4*.
- **`ride:subscribe` client→server event** — `{ rideId }`; the gateway emits a domain event consumed by a `module-rides` listener that validates the caller is the ride's `passengerId` **or** `driverId` (`RidesRepository.findById`) then `RealtimeBus.joinRide(userId, rideId)`. Lets the rider's socket (re)join `ride:<id>` deterministically — used on solo create + reconnect (*J7*).
- **No new REST endpoint** — `GET /v1/rides/:id` (E4.S6) is reused verbatim for the rider's reconnect-restore.

### Web (apps/web — booking page)

- **Enable solo booking** — wire the disabled private "Book" button → `POST /v1/rides` `type:normal` (with the `quoteToken` already returned by `/quote` + an `Idempotency-Key`); capture the returned `{ rideId, status }` (`SoloRideResponse`) into the booking store. This is the missing entry point — without it the rider can never reach a solo ride to track.
- **WS layer** — extend `src/lib/booking/ws.ts` (today subscribes `pool:update`, E5.S6) to also subscribe `ride_state_changed` + `driver_location` and expose `subscribeRide(rideId)` (emits the new `ride:subscribe` client→server event); route events into a tracking store/hook ([[web-state-management]]).
- **Ride-room join** — the rider's socket joins `ride:<id>` via the new `ride:subscribe` event after solo create (and on reconnect/reload), so create-time `joinRide` races + lost-state reloads are covered deterministically (*J7*).
- **Live-tracking view** — after the ride is accepted, render the driver's marker on the existing booking-page Leaflet map ([[web-osm-integration]]), move it on each `driver_location`, and show a status banner driven by `ride_state_changed` (Finding driver → Driver en route → Arrived → On trip → Trip complete). Rehydrate status via `GET /v1/rides/:id` on mount (active `rideId` persisted to `localStorage` for reload-restore); close/finalise the view on `completed` (*J5*).

### Flutter (apps/driver-app)

- **No change this story (*J6* deferred).** The driver already streams `driver:location` continuously while online (E3.S5, foreground service) — the server fans those out against whatever cadence arrives, and the 1 Hz cap is a ceiling not a floor. Making the emit cadence ride-state-aware crosses the foreground-isolate boundary for marginal smoothness gain, so it is **out** of this story. The implicit `start_en_route` is server-side; E4.S6's Start-trip button stays as the manual fallback. Driver app receives no new events.

### Vault reconciliation

- **[[websocket-events]]** — `driver_location` payload `{ ride_id, … }` → `{ rideId, lat, lng, heading }` (camelCase, room `ride:<id>`, 1 Hz per-ride debounce, emitted **only while a ride is live**). Reconcile the inbound-cadence note (table says "~5 s", throttle section says 3 s) and spell out the **two independent throttles** (3 s geo-index ingestion vs 1 Hz client fan-out). Annotate the thin `accepted` `ride_state_changed` emit at claim and mark the full `driver_assigned` payload as deferred.
- **[[module-realtime]]** — document the gateway's location fan-out responsibility + the first-location domain event → `RideStateMachine` wiring.
- **[[sm-ride-lifecycle]]** — flip the `start_en_route` trigger from E4.S6's "explicit button" to "**implicit on first location update** (E4.S7); explicit button retained as fallback" — restoring the note's original intent.
- **[[web-pages-routes]]** / **[[web-osm-integration]]** / **[[web-state-management]]** — the booking route's post-accept live-tracking view (marker + banner + rehydrate).
- **[[journey-client-book-normal]]** — the rider's "watch the driver approach" leg is now real (driver_location dot + ride_state_changed banner).

## Test plan

- **Unit (API — gateway):** a location packet from a driver with `current_ride_id` fans out `driver_location` to `ride:<id>` with the camelCase payload; a second packet within the same second is dropped (1 Hz debounce); a driver with **no** `current_ride_id` fans out nothing; the **first** packet for a ride emits the first-location domain event, subsequent packets do not.
- **Unit (API — listener):** the rides listener calls `RideStateMachine.apply(rideId, driverId, 'start_en_route')` and swallows `invalid_transition` without throwing.
- **Integration (API — Testcontainers postgres + redis, real Socket.IO clients):** a driver socket emits `driver:location` while on an accepted ride; a client socket joined to `ride:<id>` receives `driver_location` at ≤ 1 Hz; the ride flips to `en_route` after the first packet (asserted via `GET /v1/rides/:id`); an **off-ride** driver's location does **not** reach any client room. **Real containers, no infra mocks.**
- **Web (RTL):** the ws layer dispatches `driver_location` / `ride_state_changed` into the store; the tracking view renders the marker + banner and updates on events; mount rehydrates from a stubbed `GET /v1/rides/:id`. (Web e2e is RTL-only — no Playwright harness in repo.)
- **Flutter (unit):** on-ride cadence selection picks ~2 s while `current_ride_id` is set, presence cadence otherwise.
- Gate: `pnpm test` + `/lint` + `/flutter-test unit`. `/k6-load` for the 1 Hz fan-out under many concurrent rides is **optional / deferred** unless the budget looks at risk.

## HITL stops

1. **Demo-3 live-tracking leg** — "the rider watches the driver's dot move across the map and the status banner step en route → arrived → on trip → complete." Batched into the E4 end-to-end demo walk; as with E4.S5 / E4.S6 the live walk needs a real client↔driver flow and is expected to be **deferred to the first E4 end-to-end dry-run**; code lands and is verified by API integration + RTL/Flutter tests until then.
2. **Privacy sign-off** — driver location is shared with the rider **only while a ride is live** (gated on `current_ride_id`) and stops at `completed`. This is a new client-visible data flow; confirm the gate at sign-off. (Not the `secrets-management` note, but a privacy-sensitive flow worth an explicit look.)

## Out of scope

- **ETA recompute / live route redraw / re-routing** — just a moving marker + a status banner; ETA math and polyline re-draw are later.
- **Full `driver_assigned { driver, vehicle, eta_s }` rich payload** — thin `accepted` activation signal only this story; the driver/vehicle profile join is deferred (*J4*).
- **Cancellation (E4.S8)** and **rating (E4.S9 / E7)**.
- **Shared-ride multi-passenger location fan-out** — solo `ride:<id>` only here; the same `toRide` room mechanic is compatible with shared but per-pool fan-out is its own concern, not built here.
- **Background / offline location buffering & OEM-kill** — E3.S6 territory; unchanged.

## Notes / questions — to resolve at pickup

- **J1 — two-throttle design:** keep the existing **3 s geo-index throttle** untouched and add a **separate 1 Hz-per-ride fan-out debouncer** off the raw inbound stream *(recommended — a single 3 s gate cannot yield a smooth 1 Hz dot; the two serve different purposes: presence freshness vs client smoothness)*; vs reuse one throttle *(rejected — couples the two)*.
- **J2 — current-ride lookup for fan-out:** read `current_ride_id` from the `driver:state:<id>` hash per packet (the handler already touches this hash) *(recommended — single source of truth, set on claim / cleared on `end_ride`)*; vs cache on `client.data` at connect *(stale across a mid-session claim)*.
- **J3 — implicit `start_en_route`:** wire it now — first post-accept location emits a gateway domain event → `RideStateMachine.apply('start_en_route')`, `invalid_transition` swallowed, in-memory once-guard, E4.S6's button kept as fallback *(recommended — honours the [[sm-ride-lifecycle]] intent S6 deferred here)*; vs leave explicit-only *(rejected — leaves the note's "implicit" promise unfulfilled)*.
- **J4 — client activation signal on accept:** emit a thin `ride_state_changed { state:'accepted', by:'driver' }` to `ride:<id>` at claim so the tracking view lights up immediately on accept *(recommended)*, full `driver_assigned { driver, vehicle, eta_s }` deferred; vs rely on the first `en_route` only *(rider sees nothing between accept and first GPS)*. Touches the solo-claim path lightly — flag at pickup.
- **J5 — web tracking-view scope:** minimal moving marker on the existing booking-page Leaflet map + a status banner, rehydrate via `GET /v1/rides/:id` *(recommended)*; full ETA / route-redraw deferred.
- **J6 — Flutter on-ride cadence:** **resolved → leave the presence cadence (Flutter untouched).** Ride-state-aware cadence crosses the foreground-isolate boundary for marginal gain; the 1 Hz fan-out is a cap not a floor, so the existing stream is sufficient. Driver app unchanged this story.
- **J7 — rider ride-room join mechanism:** a `ride:subscribe { rideId }` client→server event → gateway domain event → `module-rides` listener validates ownership (`findById`: caller is `passengerId` or `driverId`) → `RealtimeBus.joinRide` *(recommended — deterministic; covers the create-time `joinRide` race + full-reload state loss; reuses the existing event-emit decoupling so the gateway stays free of `RidesRepository`)*; vs rely on create-time `joinRide` alone *(racy; misses reloads)*; vs on-connect server-side active-ride lookup *(a DB query per client connect; heavier)*.
- **Scope-fork resolution (bundle):** discovered at pickup that web booking is **shared-only** (the private/solo "Book" button is disabled; `createSharedRide` is the only create path), so the rider has no entry point to a solo ride. Per HITL decision, **enabling web solo booking is bundled into this story** (not split out) so the tracking view is demoable end-to-end. This keeps E4.S7 a single API + web story; **driver app is untouched**.

## See also

- [[epic-e4-normal-booking]] · [[sm-ride-lifecycle]] · [[module-realtime]] · [[websocket-events]]
- [[web-osm-integration]] · [[web-pages-routes]] · [[web-state-management]] · [[journey-client-book-normal]]
- [[story-rcab-e4-s6-ride-state-machine]] · [[story-rcab-e4-s5-driver-offer-screen]] · [[story-rcab-e3-s5-location-streaming]]
