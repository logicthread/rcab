---
title: RCAB-E4.S5 — Driver offer screen + accept/decline (solo)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e4-normal-booking]]
demo: 3
estimate: m
hitl: yes
depends_on: [[story-rcab-e4-s4-solo-dispatch-claim]], [[story-rcab-e4-s3-dispatch-geo-candidates]], [[driver-screens]], [[driver-state-management]], [[websocket-events]], [[journey-driver-accept-ride]]
affected_notes: [[driver-screens]], [[websocket-events]], [[driver-state-management]], [[journey-driver-accept-ride]]
owner: claude
audience: both
---

# RCAB-E4.S5 — Driver offer screen + accept/decline (solo)

## Goal

The solo dispatch backend is complete (E4.S3 fans `ride_offer` out, E4.S4 claims first-accept-wins and emits `ride_offer_accepted` / `ride_offer_revoked`), but the **driver app cannot respond yet**. `OfferScreen` (`lib/features/offer/offer_screen.dart`) is a stub that prints `Offer <id>`, and the only consumer of the `ride_offer` stream is the **shared-ride** controller, whose parser returns null for a solo offer (no `stops[]`) — so a solo offer reaches the device and goes nowhere. This story builds the real **solo** offer experience: parse the `SoloRideOfferPayload`, auto-open a ringing offer screen with a 12 s countdown, and let the driver **Accept** (→ `ride_offer_response {accept:true}` → on `ride_offer_accepted` route to the active ride screen) or **Decline** (→ `ride_offer_response {accept:false}`), with the offer auto-dismissing on `ride_offer_revoked` (someone else won) or TTL expiry. **No API code changes** — the backend contract is already in place; this is the Flutter half plus reconciling `websocket-events` with what S3/S4 actually ship.

## User-facing acceptance criteria

- `Given` the driver is online and a solo `ride_offer` arrives, `When` the event is received, `Then` the offer screen auto-opens within 200 ms showing pickup, dropoff, fare, and a visible countdown seeded from `ttlMs` (12 s), with an audible + haptic alert.
- `Given` the offer screen is showing, `When` the driver taps **Accept**, `Then` a `ride_offer_response { offerId, accept: true }` is sent and the screen shows a brief "claiming…" state until the server replies.
- `Given` the driver accepted and won, `When` `ride_offer_accepted { offerId, rideId }` arrives, `Then` the app routes to the active ride screen (`/ride/:rideId`).
- `Given` the driver accepted but lost the race (or the client cancelled), `When` `ride_offer_revoked { offerId, rideId, reason }` arrives, `Then` the offer screen dismisses back to `/home` with a brief "ride taken" / "no longer available" note (by `reason`).
- `Given` the offer screen is showing, `When` the driver taps **Decline**, `Then` `ride_offer_response { offerId, accept: false }` is sent and the screen dismisses to `/home` immediately.
- `Given` the driver does nothing, `When` the countdown reaches 0, `Then` the offer auto-dismisses to `/home` (the server-side `offer:<id>` key has its own 12 s TTL — *J2*).

## Technical acceptance criteria

### Flutter (apps/driver-app — pure client story)

- **Solo offer model** `lib/features/offer/offer_models.dart` — `SoloRideOffer` with `tryFromRideOfferJson(Map)` that parses the as-built `SoloRideOfferPayload` `{ offerId, rideId, ttlMs, pickup:{lat,lng}, dropoff:{lat,lng}, fareCents, waveNumber }`. **Returns null when `stops` is present** (that path belongs to `SharedRideOffer`) — mirrors the solo/shared split already used by `SharedRideOffer.tryFromRideOfferJson`.
- **`RealtimeSocket` additions** (`lib/core/realtime/realtime_socket.dart` + `IRealtimeSocket`):
  - inbound: `..on('ride_offer_accepted', …)` and `..on('ride_offer_revoked', …)` → two new broadcast streams `rideOfferAccepted` / `rideOfferRevoked`.
  - outbound: `sendOfferResponse({ required String offerId, required bool accept })` → `emit('ride_offer_response', { offerId, accept })` (no `sharedRideId` for solo; server resolves the ride via `offer:meta:<offerId>`).
  - `dispose()` closes the two new controllers.
- **`OfferController`** `lib/features/offer/offer_controller.dart` — Riverpod `StateNotifier<OfferState>`:
  - subscribes to `rideOffer` (solo branch only — ignores offers that parse as shared), `rideOfferAccepted`, `rideOfferRevoked`.
  - holds `{ offer: SoloRideOffer?, phase: idle | ringing | claiming | accepted | revoked | expired, secondsLeft }`; a 1 Hz ticker drives `secondsLeft` from `ttlMs` and flips to `expired` at 0.
  - `accept()` → `phase = claiming` + `sendOfferResponse(accept:true)`; `decline()` → `sendOfferResponse(accept:false)` + clear; matches `ride_offer_accepted`/`revoked` **by `offerId`** (ignores stale echoes for a prior offer).
- **`OfferScreen`** (`lib/features/offer/offer_screen.dart`) — replace the stub: pickup/dropoff rows, fare rendered from `fareCents` (₹ major units), countdown indicator, **Accept** / **Decline** buttons, audible + haptic alert on open (`driver-screens` "12 s TTL is short" rule). Navigation driven by `OfferController` phase: `accepted` → `/ride/:rideId`, `revoked` / `expired` / decline → `/home`.
- **Auto-open wiring** — a top-level listener (where the socket is already consumed in the app shell — *J3*) pushes `/offer/:offerId` on an incoming solo `ride_offer`. Shared offers keep their existing path untouched.

### Vault reconciliation

- **`websocket-events` is stale vs. as-built** and must be corrected in this PR (*J4*): the solo `ride_offer` row still reads `{ offer_id, request?, ttl_ms, pickup, fare_est, est_pickup_eta_s }` (snake_case, pre-S3 design). Update it to the shipped `SoloRideOfferPayload` (camelCase, with `rideId` + `dropoff` + `fareCents` + `waveNumber`); **add** the `ride_offer_accepted { offerId, rideId }` server→driver row (undocumented today); correct `ride_offer_revoked` to `{ offerId, rideId, reason }` (`reason` ∈ `taken` / `unavailable`); note the solo `ride_offer_response { offerId, accept }` path (decline just `DEL offer:<id>`).

## Test plan

- **Unit (Flutter — `test/features/offer/offer_controller_test.dart`):** a solo `ride_offer` puts the controller in `ringing` with `secondsLeft` seeded from `ttlMs`; a shared payload (`stops[]`) is ignored; `accept()` sends `ride_offer_response {accept:true}` and goes `claiming`; a matching `ride_offer_accepted` → `accepted` with `rideId`; a matching `ride_offer_revoked` → `revoked`; an `accepted`/`revoked` for a *different* offerId is ignored; the ticker drives `secondsLeft` to 0 → `expired`; `decline()` sends `{accept:false}`.
- **Widget (Flutter — `test/features/offer/offer_screen_test.dart`):** renders pickup/dropoff/fare + countdown; **Accept** tap invokes the controller; **Decline** tap invokes the controller; on `accepted` phase navigates to `/ride/:id` (fake router / navigator observer).
- **Fakes:** reuse the `IRealtimeSocket` fake seam already used by the shared-ride tests; extend it with the two new streams + `sendOfferResponse` capture.
- Gate via `/flutter-test unit widget` (driver-app is outside the pnpm workspace; ~6 baseline analyzer infos are pre-existing). **No API tests** — the server contract is covered by the E4.S3/S4 integration specs.

## HITL stops

1. **Demo-3 driver-accept leg** — the "the offer rings on the driver's phone, they tap Accept, and it's theirs" moment. Batched into the E4 end-to-end demo walk; sign off there. As with E5.S7, the live walk needs a real client→driver flow and is expected to be **deferred to the first E4 end-to-end dry-run**; code lands and is verified by the Flutter unit/widget tests until then.

## Out of scope

- Active ride screen behaviour after accept (state buttons, "Navigate" → Google Maps, `accepted → en_route → …`) — RCAB-E4.S6. This story only routes to `/ride/:rideId`; the `RideScreen` body is S6.
- FCM data-message path for offers when the WS is stale (`journey-driver-accept-ride` "why both FCM and WebSocket") — Phase-1 / separate story; this story is WS-only.
- Client-side "searching / no driver" UI — web follow-up (the backend already emits `ride_no_driver`).
- Shared-ride offer UI changes — owned by E5.S7 (`SharedRideOffer` / `SharedRideScreen`), untouched here beyond not regressing the shared `ride_offer` parse.
- Map rendering on the offer screen (pickup/dropoff marker map) — optional; text rows satisfy the AC. Add only if cheap.

## Notes / questions — to resolve at pickup

- **J1 — solo offer state ownership:** (A) a **separate** `OfferController` + `offer_provider.dart` under `lib/features/offer/` *(recommended — mirrors the `shared_ride_controller` / `shared_ride_provider` split; solo and shared offers are distinct routes/screens and parsers)*; vs (B) fold solo handling into the existing `SharedRideController` *(couples two unrelated screens; rejected)*.
- **J2 — countdown expiry behaviour:** (A) on client TTL expiry just **dismiss** to `/home` and let the server `offer:<id>` key lapse on its own 12 s TTL *(recommended — the server lock already auto-expires; an explicit decline-on-expiry is redundant and races the server)*; vs (B) send `ride_offer_response {accept:false}` on expiry too. The explicit **Decline button** always sends `{accept:false}` regardless.
- **J3 — auto-open navigation wiring:** where the top-level `ride_offer` → `push('/offer/:id')` listener lives. (A) a listener in the app shell / a top-level provider that watches `OfferController` *(recommended)*; vs (B) only navigate when `/home` is foreground. Confirm how shared offers currently surface so solo matches the pattern without a second navigation owner.
- **J4 — `websocket-events` reconciliation scope:** correct the solo `ride_offer` + add `ride_offer_accepted` + fix `ride_offer_revoked` *(in scope, clearly as-built drift)*. The `journey-driver-accept-ride` sequence diagram still shows a **REST** `POST /rides/offers/:id/accept`, but the as-built transport is the WS `ride_offer_response` (per [[ADR-0008-socketio-realtime]]) — reconcile that note too, or leave it with a one-line transport correction? *(recommend a one-line correction; the journey is an `accepted` product note, so a fuller rewrite would be a heavier review.)*

## See also

- [[epic-e4-normal-booking]] · [[journey-driver-accept-ride]] · [[driver-screens]] · [[driver-state-management]] · [[websocket-events]]
- [[story-rcab-e4-s4-solo-dispatch-claim]] · [[story-rcab-e4-s3-dispatch-geo-candidates]]
