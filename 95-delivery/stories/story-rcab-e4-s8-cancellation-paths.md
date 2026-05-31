---
title: RCAB-E4.S8 — Ride cancellation & no-show paths
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: l
hitl: yes
depends_on: [[story-rcab-e4-s6-ride-state-machine]], [[story-rcab-e4-s7-driver-location-stream]], [[story-rcab-e4-s4-solo-dispatch-claim]], [[sm-ride-lifecycle]], [[module-rides]], [[module-dispatch]], [[rest-endpoints]], [[websocket-events]], [[entity-ride]], [[driver-screens]], [[web-state-management]]
affected_notes: [[sm-ride-lifecycle]], [[module-rides]], [[module-dispatch]], [[rest-endpoints]], [[websocket-events]], [[schema-postgres]], [[entity-ride]], [[driver-screens]], [[web-state-management]], [[journey-client-book-normal]]
owner: claude
audience: both
---

# RCAB-E4.S8 — Ride cancellation & no-show paths

## Goal

E4.S6 built the forward solo lifecycle (`accepted → en_route → arrived → in_progress → completed`) and E4.S7 wired live tracking, but a ride has **no way out except completion**: neither side can cancel, and a client who never shows up strands the driver forever. This story adds the **terminal off-ramps** to the solo `rides` lifecycle — client cancel, driver cancel, and driver-reported no-show — as the role-aware counterpart to E4.S6's driver-only forward machine.

The transport contract is already declared in the vault: `POST /v1/rides/:id/cancel` (role-aware) per [[rest-endpoints]], and `cancel_driver` / `cancel_client` / `mark_no_show` transitions per [[sm-ride-lifecycle]]. This story makes them real for solo `rides`, reconciles the note's separate `canceled_driver` / `canceled_client` states with the single `cancelled` status migration 0006 actually shipped (*J1*), adds the missing `no_show` status + the cancellation bookkeeping columns (*migration 0009*), and surfaces cancel on both clients (web rider panel from E4.S7 + driver `/ride/:id` from E4.S6).

Cancellation can fire **before** a driver is bound (while the ride is `requested` / `dispatching`), so it must also unwind in-flight dispatch — release the Redis claim, revoke outstanding offers, and drop the wave / hard-fail timers. That unwind reuses E4.S4's dispatch internals via a decoupled `RIDE_CANCELLED_EVENT` (mirroring the E4.S7 gateway→listener pattern — the rides module stays free of dispatch internals) (*J4*).

**No cancellation or no-show fee ships in Phase-0** (HITL decision, 2026-05-31): cancellation is **free** in every case, and the fee *mechanism* — schedule, computation, the `cancel_fee_cents` column, the pricing method — is deferred to a later phase that will introduce and activate it. This story builds the cancellation *paths and bookkeeping* only (who cancelled, when, why), with **no money** anywhere. (*See Out of scope.*)

## User-facing acceptance criteria

- `Given` a client whose solo ride is still `requested` (no driver yet), `When` they tap **Cancel**, `Then` the ride moves to `cancelled`, dispatch stops searching, and the rider panel shows a "Ride cancelled" terminal state.
- `Given` a client whose ride is `accepted` (a driver was just assigned but is not yet moving), `When` they cancel, `Then` the ride is `cancelled`, the bound driver is released (offer revoked, `current_ride_id` cleared) and is notified via `ride_state_changed`.
- `Given` a client whose ride is `en_route` or `arrived`, `When` they cancel, `Then` the ride is `cancelled`, the driver is notified and freed, and the rider panel shows the cancelled terminal state. (No fee in Phase-0.)
- `Given` a client whose ride is `in_progress` (trip started), `When` they attempt to cancel, `Then` it is **rejected** (HTTP 409) — an in-progress trip ends via the driver's "End ride", not cancel.
- `Given` a driver on `/ride/:id` at any pre-`completed` state, `When` they tap **Cancel** and supply a reason, `Then` the ride is `cancelled`, the reason is recorded, and the rider panel reflects the driver-initiated cancellation.
- `Given` a driver whose ride is `arrived` and the client has not appeared, `When` 5 minutes have elapsed since `arrived_at`, `Then` the **Report no-show** action becomes available; tapping it moves the ride to `no_show`, frees the driver, and notifies the rider.
- `Given` a driver who taps **Report no-show before the 5-minute wait has elapsed**, `When` the server processes it, `Then` it is **rejected** (HTTP 409 `no_show_too_early`) and the button stays disabled until the wait passes.
- `Given` either party on a cancelled / no-show ride, `When` the terminal `ride_state_changed` arrives, `Then` the live tracking view stops (driver dot frozen/cleared, "Book another ride" offered on web; driver routed home).

## Technical acceptance criteria

### API (apps/api — `module-rides`)

- **`RideStateMachine.cancel(...)`** — a new role-aware terminal path **separate from the driver-only forward `apply()`** (*J2*). Inside a single `SELECT … FOR UPDATE` transaction it:
  - resolves the actor (`'client'` must equal `rides.passenger_id`; `'driver'` must equal `rides.driver_id`) → `not_owner` otherwise;
  - validates the current status is cancellable for that actor — **client**: any of `requested` / `dispatching` / `accepted` / `en_route` / `arrived` (rejected `invalid_transition` once `in_progress`+); **driver**: any pre-`completed` state; `mark_no_show` only from `arrived`;
  - writes `status` (`cancelled`, or `no_show` for a no-show), `cancelled_at = now`, `cancelled_by` (`'client'` | `'driver'`), `cancel_reason` (required for driver-initiated; a fixed `'no_show'` reason for no-show);
  - returns the same `RideApplyResult` discriminated-union shape (`ok` | `not_found` | `not_owner` | `invalid_transition`), plus `no_show_too_early` for the early-no-show guard.
  - **No fee is computed or stored** — Phase-0 cancellation is free (see Out of scope).
- **No-show wait gate** — `mark_no_show` is rejected unless `now − arrived_at ≥ NO_SHOW_WAIT_MS` (config, default `300_000`). **Server-side elapsed check, not a background job** (*J5*) — the driver button is client-side-enabled at 5 min and the server re-validates; no auto-termination of rides.
- **`POST /v1/rides/:id/cancel`** — role-aware (`AuthGuard`; both `client` and `driver` allowed, authorisation is per-row inside the state machine). Body `{ reason? }` for driver cancel; a `{ event: 'mark_no_show' }` discriminator for the driver no-show (*J6*). Returns `200 { rideId, status, cancelledBy }`; `403` not-your-ride; `404` unknown; `409` `invalid_transition` (e.g. client cancel on `in_progress`) or `no_show_too_early`. Matches the [[rest-endpoints]] `/v1/rides/:id/cancel` row.
- **`ride_state_changed` emit** — after commit, `bus.toRide(rideId, 'ride_state_changed', { rideId, state, by })` so both rooms land on the terminal state. (Same payload shape as E4.S6 — no fee field.)
- **Dispatch unwind** — on a cancel that fires while the ride is still `requested` / `dispatching` (or `accepted`), the state machine emits **`RIDE_CANCELLED_EVENT { rideId, driverId? }`**; `DispatchService` consumes it via `@OnEvent` and runs a `releaseDispatch(rideId)` that `DEL`s `claim:ride:<id>`, calls the existing `revokeAllOffers(rideId)`, and removes the wave-2 + hard-fail BullMQ jobs (`waveTimeoutJobId` / `hardFailJobId`). Rides module stays free of dispatch internals (*J4*).
- **Driver release** — when a driver was bound, clear `driver:state.current_ride_id` (reuse the `RideStateMachine` helper from E4.S6) and emit the driver-facing notification.
- **`GET /v1/rides/:id`** — extend `RideDetailResponse.timestamps` with `cancelledAt` and add `cancelledBy` / `cancelReason` so the reconnect-restore hydrates a terminal cancelled/no-show ride correctly.
- **Migration 0009** — `ALTER TABLE rides`: add `cancelled_at timestamptz NULL`, `cancelled_by text NULL` (CHECK in `('client','driver')`), `cancel_reason text NULL`; **extend the status CHECK to include `no_show`** (`cancelled` already present from 0006). Drizzle schema (`rides`) updated to match; `RideRow` + `toRow` gain the new fields. **No fee column** — that arrives with the later fee-mechanism phase.

### Flutter (apps/driver-app — `/ride/:id`, E4.S6 screen)

- **`RideController`** gains `cancel(reason)` → `POST /v1/rides/:id/cancel { reason }` and `reportNoShow()` → `POST … { event: 'mark_no_show' }`; a `ride_state_changed` carrying a terminal `cancelled` / `no_show` for this ride drives the screen to a terminal state and routes home.
- **`RideScreen`** gains a **Cancel** affordance (reason prompt) available pre-`completed`, and a **Report no-show** button that is **enabled only once `arrived` and the 5-minute wait has elapsed** (drive a countdown off `arrived_at`). Keep `Key('ride_screen')`.

### Web (apps/web — rider tracking panel, E4.S7)

- **`RideTrackingPanel`** gains a **Cancel ride** button (hidden once terminal / `in_progress`), wired through `book-client` → `POST /v1/rides/:id/cancel` (`cancelActiveRide`). On a cancel response or a terminal `ride_state_changed`, show the terminal banner ("Ride cancelled" / driver-cancelled wording / "Marked as no-show") and offer **Book another ride** (reuse the E4.S7 `onNewBooking` / `clearActiveRide` path + clear `rcab_active_ride`).
- **booking store** — `applyRideState` already normalises `cancelled`; add `no_show` to `RideStatus` + `KNOWN_STATUSES`; add a `cancelActiveRide` action; the `tracking → terminal` clear effect already exists from E4.S7.
- **`api.ts`** — `cancelRide(rideId, jwt)` (POST, no idempotency key needed — cancel is naturally idempotent on a terminal row).

### Vault reconciliation

- **[[sm-ride-lifecycle]]** — the note shows distinct `canceled_driver` / `canceled_client` states; the shipped `rides` table has a single `cancelled` status. Reconcile (*J1*): document the as-built — one `cancelled` status discriminated by `cancelled_by`, plus a distinct `no_show` status; list the `cancel_client` / `cancel_driver` / `mark_no_show` events; note the client cut-off is pre-`in_progress`, the no-show 5-min gate is a server-side elapsed check, and **fees are deferred to a later phase** (the note's "fee applies" annotations are future, not Phase-0).
- **[[module-rides]]** — add `RideStateMachine.cancel(...)`, the no-show gate, and the `RIDE_CANCELLED_EVENT` emit to the module's responsibilities.
- **[[module-dispatch]]** — document `releaseDispatch(rideId)` and the `@OnEvent(RIDE_CANCELLED_EVENT)` consumer that unwinds claim / offers / timers.
- **[[rest-endpoints]]** — annotate `POST /v1/rides/:id/cancel` as shipped (role-aware; body + status codes; no fee in Phase-0); clarify that the legacy `/v1/rides/requests/:id/cancel` row belongs to the not-built abstract `ride_request` model, not solo `rides`.
- **[[websocket-events]]** — extend the `ride_state_changed` row to note terminal `cancelled` / `no_show` states.
- **[[schema-postgres]]** — the indicative DDL still shows a single abstract `ride` table with `state` / `canceled_at` / `cancel_reason`; add an as-built note for the real `rides` table's 0009 columns (`cancelled_at`, `cancelled_by`, `cancel_reason`) and the `no_show` CHECK value; note no fee column ships yet.
- **[[entity-ride]]** — reconcile the cancel fields with the as-built columns; note fee deferral.
- **[[driver-screens]]** — flesh `/ride/:id` with the Cancel (reason) + Report-no-show (5-min-gated) actions.
- **[[web-state-management]]** — add the `cancelActiveRide` action to the solo tracking slice.
- **[[journey-client-book-normal]]** — add the cancellation leg (client cancels / is no-show) to the journey.

## Test plan

- **Unit (API — `ride-state-machine.service.spec.ts`):** client cancel from each cancellable state writes `cancelled` (no fee field written); client cancel on `in_progress` → `invalid_transition` (no write); driver cancel any pre-`completed` → `cancelled`, reason recorded; `mark_no_show` from `arrived` after the wait → `no_show`; `mark_no_show` before the wait → `no_show_too_early`; non-owner (wrong client / wrong driver) → `not_owner`; a bound-driver cancel clears `current_ride_id` + emits `RIDE_CANCELLED_EVENT`.
- **Unit (API — `rides.controller.spec.ts`):** `/cancel` maps results to 200 / 403 / 404 / 409 (incl. `no_show_too_early`); driver-cancel requires a reason; response carries `cancelledBy`.
- **Unit (API — `dispatch.service.spec.ts`):** `@OnEvent(RIDE_CANCELLED_EVENT)` → `releaseDispatch` DELs the claim, revokes offers, removes both timers; a cancel after `no_driver` is a safe no-op.
- **Integration (API — Testcontainers postgres + redis):** real ride walked to `requested` then cancelled → `cancelled`, dispatch artefacts gone; walked to `arrived` then client-cancelled → `cancelled_at` stamped, driver `current_ride_id` cleared; `arrived` + simulated elapsed `arrived_at` then `mark_no_show` → `no_show`; early no-show → 409. **Real containers, no infra mocks.**
- **Unit/Widget (Flutter):** `RideController.cancel/reportNoShow` issue the right POST; no-show button disabled until `arrived` + 5 min; a terminal `ride_state_changed` routes home.
- **Web (RTL):** `RideTrackingPanel` shows the Cancel button pre-terminal and hides it once `in_progress`/terminal; clicking cancels and renders the right terminal banner (cancelled vs driver-cancelled vs no-show); store `cancelActiveRide` + terminal clear.
- Gate: `pnpm test` + `pnpm test:int` + `/flutter-test unit widget` + `/lint`.

## HITL stops

1. **Demo-3 cancellation legs** — "client cancels and lands on the cancelled state" + "driver reports a no-show after the wait." Batched into the E4 end-to-end demo walk; sign off there. As with E4.S5–S7, the live client↔driver walk is expected to be **deferred to the first E4 end-to-end dry-run**; code lands and is verified by API integration + Flutter/RTL tests until then.

*(The fee-schedule sign-off originally flagged here was resolved at pickup — no fee in Phase-0; see Notes J3.)*

## Out of scope

- **Cancellation / no-show fees — any amount — deferred to a later phase** (HITL decision, 2026-05-31). Phase-0 cancellation is free. The fee *mechanism* (schedule, `PricingService.cancellationFee`, the `cancel_fee_cents` column, fee display, and any charging) is introduced and activated in a later phase, not here.
- **Charging / collecting money.** Phase-0 has no wallet or payment gateway. (Moot while fees are deferred.)
- **Shared-ride cancellation** (a member leaving an open pool, pool-level cancel). This story is solo `rides` only; shared pools have their own lifecycle (`RideLifecycleService`, E5) and are untouched.
- **Cancellation analytics / abuse limits** (e.g. "too many cancels → penalty"). Recording `cancelled_by` enables this later; no policy here.
- **Rating after a no-show / cancel.** Rating capture is RCAB-E4.S9 / E7; a cancelled ride does not route into rating in this story.
- **Auto no-show via a background job.** Server-side elapsed gate only (*J5*); no BullMQ timer that terminates a ride without driver confirmation.

## Notes / questions — resolved at pickup

- **J1 — `cancelled` vs `canceled_driver`/`canceled_client`:** keep the **single shipped `cancelled` status discriminated by `cancelled_by`** + a distinct `no_show`, and reconcile the sm-note *(chosen — a CHECK split into two cancel states is churn for zero behavioural gain; `cancelled_by` already distinguishes them)*.
- **J2 — cancel path placement:** a **new `RideStateMachine.cancel(...)` method** (role-aware, multi-from-state, writes the cancel columns) separate from the driver-only forward `apply()` *(chosen — cancel's authorisation and column writes differ from a forward step)*.
- **J3 — fee schedule: RESOLVED — no fee in Phase-0** (HITL decision, 2026-05-31). Cancellation is free; the fee mechanism is deferred to a later phase. No pricing method, no fee column, no fee in the payload/UI this story.
- **J4 — dispatch unwind coupling:** a decoupled **`RIDE_CANCELLED_EVENT` → `DispatchService.releaseDispatch`** consumer *(chosen — mirrors the E4.S7 gateway→listener decoupling; keeps rides free of dispatch internals)*.
- **J5 — no-show trigger:** **server-side elapsed gate** on `mark_no_show` (`now − arrived_at ≥ 5 min`), driver-initiated *(chosen — no background worker auto-terminating rides; Phase-0-appropriate)*.
- **J6 — no-show API shape:** a `{ event: 'mark_no_show' }` discriminator on `POST /v1/rides/:id/cancel` (single endpoint matching the declared rest-endpoints row) *(chosen over a separate `/no-show` route)*.
- **Scope:** kept whole — spans **API + web + Flutter** (the widest E4 story); it is one feature across three surfaces.

## See also

- [[epic-e4-normal-booking]] · [[sm-ride-lifecycle]] · [[module-rides]] · [[module-dispatch]] · [[entity-ride]]
- [[rest-endpoints]] · [[websocket-events]] · [[schema-postgres]] · [[driver-screens]] · [[web-state-management]] · [[journey-client-book-normal]]
- [[story-rcab-e4-s6-ride-state-machine]] · [[story-rcab-e4-s7-driver-location-stream]] · [[story-rcab-e4-s4-solo-dispatch-claim]]
