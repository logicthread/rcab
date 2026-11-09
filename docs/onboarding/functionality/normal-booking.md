# Normal (private) booking

The simplest end-to-end path: one passenger, one driver, a fare locked from a quote. Shared and scheduled rides are variations of this path and have their own pages.

Back to [README](../README.md) · parts of this flow: [quoting-and-pricing](quoting-and-pricing.md), [dispatch-and-offers](dispatch-and-offers.md), [ride-lifecycle-cancel-no-show](ride-lifecycle-cancel-no-show.md), [ratings](ratings.md), [realtime-protocol](realtime-protocol.md) · diagrams: [state-machines](../state-machines.md).

## What it does

1. Quote (see [quoting-and-pricing](quoting-and-pricing.md)).
2. `POST /v1/rides` creates a `rides` row in `requested` **and** an outbox row `ride.dispatch.requested` in one transaction, then returns immediately.
3. The outbox relay publishes a `dispatch:start` job; wave 1 offers the trip to the nearest eligible drivers.
4. A driver accepts; the ride becomes `accepted`, then moves through `en_route`, `arrived`, `in_progress`, `completed` as the driver acts.
5. The passenger watches status and the driver's position live, can cancel before the trip starts, and rates the driver at the end.

If nobody accepts within the hard-fail time (60 s by default) the ride ends as `no_driver`.

## User-visible behaviour

| Moment | Passenger (web `/book`) | Driver (app) | Video |
|---|---|---|---|
| Choose route | Map/search/preset, quote appears. Toggle **Private** | - | W03 |
| Book | "Book" button (labelled "Book share" for Share). Tracking panel opens with "Finding your driver..." | - | W03 |
| Offer | - | Ringing offer screen with pickup, dropoff, fare and a countdown (server `ttlMs`, default 12 s). Accept or decline | D04 |
| Accepted | Banner "Driver assigned - getting ready" | Ride screen with a primary action button ("Start trip" after accept, then "I've arrived", "Start ride", "End ride") and a Navigate button that opens Google Maps | W03, D04 |
| Driving to pickup | "Your driver is on the way", blue "Live - following your driver" hint, driver marker moves at about 1 Hz | Streams location every 5 s. **The first location packet after accept implicitly marks the ride `en_route`** | W03, D04 |
| Arrived | "Your driver has arrived" | Button "Start ride"; a no-show button unlocks 5 minutes after arrival | W03, W05 |
| In progress | "On the way to your destination"; cancel hidden | Button "End ride" | W03 |
| Completed | "Trip complete" and a 1 to 5 star card with optional comment (1000 chars) | Rating screen for the passenger | W03, D04 |
| No driver | "No driver available - please try again" | - | W06 |
| Cancel before pickup | "Ride cancelled" | If a driver was assigned they are released and told | W04 |

Scene index: [web W03 to W06](../videos/web/INDEX.md), [driver app D04, D05, D07](../videos/driver-app/INDEX.md).

Reload (W09): the web stores the active solo ride id in `localStorage` key `rcab_active_ride` and on mount rehydrates from `GET /v1/rides/:id`, then re-subscribes (`ride:subscribe`, re-sent on every socket reconnect) and receives a `ride:snapshot`.

## API

| Call | Notes |
|---|---|
| `POST /v1/rides/quote` | see quoting page |
| `POST /v1/rides` | Client only. Body `{ type: "normal", originLat, originLng, destLat, destLng, quoteToken }`; header `Idempotency-Key` **required** (1 to 128 visible ASCII chars). Returns `{ rideId, passengerId, status: "requested", fare }`. A replay with the same key returns the same ride |
| `GET /v1/rides/:id` | Passenger (client role, owner) or the bound driver. Returns status, fare, origin/dropoff, `cancelledBy`, `cancelReason` and the timestamp trail (`acceptedAt`, `enRouteAt`, `arrivedAt`, `startedAt`, `completedAt`, `cancelledAt`) |
| `POST /v1/rides/:id/state` | Bound driver only. Body `{ event }` where event is `start_en_route`, `mark_arrived`, `start_ride`, `end_ride`. 409 `invalid_transition` when out of order |
| `POST /v1/rides/:id/cancel` | Client or driver; see lifecycle page |
| `POST /v1/rides/:id/ratings` | see ratings page |

Status codes worth remembering: 400 `idempotency_key_required` / `idempotency_key_invalid` / `invalid_quote` / `quote_expired` / `quote_mismatch`; 403 `forbidden` (wrong role, not your ride); 404 `ride_not_found`; 409 `invalid_transition`, `idempotency_request_in_progress`; 422 `idempotency_key_conflict`.

Socket events for this flow: `ride:subscribe` then `ride:snapshot`; `ride_state_changed` (`{ rideId, state, by, version }`); `driver_location` (`{ rideId, lat, lng, heading }`); `ride_no_driver` to `user:<id>`. Driver side: `ride_offer`, `ride_offer_response`, `ride_offer_outcome`, `driver:assignment`. Full catalogue in [realtime-protocol](realtime-protocol.md).

## Ride status values

`requested`, `accepted`, `en_route`, `arrived`, `in_progress`, `completed`, `cancelled`, `no_driver`, `no_show`. The CHECK constraint and the policy list also allow `dispatching`, but **no code path ever writes it**: a ride stays `requested` for its whole search. Older vault notes and `docs/ARCHITECTURE.md` draw `requested -> dispatching -> accepted`; treat `dispatching` as reserved.

## Data

`rides` (status, fare, coordinates, `driver_id`, timestamp columns, `cancelled_by`, `cancel_reason`, `dispatch_generation`, idempotency columns), `dispatch_offer`, `driver_active_assignment`, `outbox`, `ratings`. Migrations 0006 to 0010, 0013, 0014, 0015.

## Policy knobs

[Pricing and fares](../../POLICY.md#pricing--fares), [Dispatch](../../POLICY.md#dispatch-normal-rides) (K1/K2/R1/R2, offer TTL 12 s, wave 2 at +30 s, hard fail at +60 s), [Ride lifecycle](../../POLICY.md#ride-lifecycle) (no-show wait 5 min, who may cancel from which state), [Idempotency](../../POLICY.md#idempotency), [Realtime](../../POLICY.md#realtime) (1 Hz location fan-out). Web: [Client knobs](../../POLICY.md#web) (idempotency in-progress replay 1 s, subscribe retries 5 with 1/2/4/8 s backoff).

## Code entry points

- API: `modules/rides/{rides.controller,rides.repository,ride-state-machine.service,rides-realtime.listener,idempotency,idempotency.repository,quote-token.service}.ts`; `modules/dispatch/*` (see dispatch page); `modules/realtime/*`.
- Web: `app/book/{book-client,ride-tracking-panel,map-picker,address-search,ride-type-toggle}.tsx`, `lib/booking/{store,api,ws,intent,types}.ts`.
- Driver app: `features/offer/*`, `features/ride/{ride_screen,ride_provider,ride_models}.dart`, `features/rating/*`.

## Tests

API: `rides.controller.spec.ts`, `rides.idempotency.spec.ts`, `ride-state-machine.service.spec.ts`, `rides-realtime.listener.spec.ts`, `dispatch.service.spec.ts`; integration `rides-idempotency.int.spec.ts`, `ride-state-machine.int.spec.ts`, `ride-realtime.int.spec.ts`, `outbox-dispatch.int.spec.ts`, `outbox-e2e.int.spec.ts`, `dispatch-offer-assignment.int.spec.ts`. Web: `book-client.test.tsx`, `ride-tracking-panel.test.tsx`, `lib/booking/*.test.ts`. Driver app: `test/features/{offer,ride,rating}/`. Manual walk: [RUN-GUIDE](../../manual-testing/RUN-GUIDE.md) section 5 (Demo 3).

## Known gaps

- **Fixed while writing this pack (commit `fd8b2ca`, RCAB-E8.S14):** the web restore-on-reload and "stop persisting" effects treated only `completed`, `no_driver`, `cancelled` as terminal, so a reload after a driver no-show rehydrated the tracking panel with "Marked as no-show". `book-client.tsx` now uses one `TERMINAL_RIDE_STATUSES` list that includes `no_show`.
- Only the solo ride is restored on reload; an in-flight shared pool is not (see [shared-rides](shared-rides.md)).
- The web has no way to book a scheduled ride (see [scheduled-rides](scheduled-rides.md)).
- No ride history page (E7.S3), no receipts, no payment.
- The passenger cannot see the driver's name, vehicle or ETA in the tracking panel; the snapshot carries `vehicle` and `driverId` but the UI does not render them.
