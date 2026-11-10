# Realtime protocol (Socket.IO)

How clients subscribe to live state, which events exist, and the ordering rules that make reconnects and duplicate events safe. The gateway lives on the API port (3000), is websocket-only, and is backed by the Redis adapter for multi-node fan-out.

Back to [README](../README.md) · see also [dispatch-and-offers](dispatch-and-offers.md), [shared-rides](shared-rides.md), [normal-booking](normal-booking.md) · vault design note: `40-backend/websocket-events.md` and `40-backend/module-realtime.md` (older; this page is code-verified) · source of truth: `apps/api/src/modules/realtime/realtime.protocol.ts`.

## Connection

- Transport: `websocket` only (no long-polling). URL = API origin, e.g. `http://localhost:3000`.
- Auth: access JWT in `handshake.auth.token` (web passes a callback so a reconnect uses a fresh token) or an `Authorization: Bearer` header. Missing or invalid token: the server disconnects the socket immediately.
- On connect the socket joins `user:<id>`; drivers also join `driver:<id>`, get a `driver_state` replay and a `driver:assignment` snapshot (committed trip from Postgres, or `null`).
- Gauge `rcab_ws_connections` counts authenticated sockets.

## Rooms

| Room | Members | Used for |
|---|---|---|
| `user:<userId>` | all sockets of a user | `ride_no_driver`, `ride_dispatch_retry`, `joinRide`/`joinPool` targeting |
| `driver:<driverId>` | the driver's sockets | offers, outcomes, `force_offline`, stop echoes |
| `ride:<rideId>` | passenger and driver of a solo ride; for a pool, every member and the claimed driver (the pool id is the room id) | `ride_state_changed`, `driver_location`, `ride:completed` |
| `pool:<poolId>` | members of a shared pool | `pool:update` |

Rooms do not survive reconnects. The server also joins the booking passenger's sockets to `ride:<id>` / `pool:<id>` at create time, but **delivery never depends on that**: clients must subscribe explicitly after create and on every reconnect.

## Client to server

| Event | Sender | Payload | Ack / effect |
|---|---|---|---|
| `ride:subscribe` | passenger or bound driver | `{ rideId }` (UUID) | Checks party membership in Postgres, joins `ride:<id>`, emits `ride:snapshot`. Ack `{ ok: true, snapshot }` or `{ ok: false, reason: invalid_payload \| forbidden \| not_found \| unavailable }` |
| `pool:subscribe` | pool member | `{ sharedRideId }` | Membership check, joins `pool:<id>` and `ride:<id>`, emits `pool:snapshot`. Same ack shape |
| `driver:sync` | driver | none | Ack and a `driver:assignment` event with the committed assignment. Use on cold start or after a lost accept ack |
| `driver:location` | driver | `{ lat, lng, heading, speed }` | No ack. Refreshes the geo index and `last_seen` (3 s gate), fans out `driver_location` to the ride room (1 Hz) while the driver has a `current_ride_id`, and triggers the implicit `en_route` on the first packet |
| `ride_offer_response` | driver | `{ offerId (UUID), accept (boolean) }` | Ack: accept result or decline result (see [dispatch-and-offers](dispatch-and-offers.md)); `invalid_payload` for anything not a UUID and a strict boolean |
| `stop:pickup_confirmed` / `stop:drop_confirmed` | driver | `{ rideId (pool id), sequenceIndex (integer) }` | No ack; result arrives as the same-named event to the driver and a `pool:update` to members |

For `ride:subscribe`/`pool:subscribe` the server **joins the room first, then reads the snapshot**, so no commit can fall in between.

## Server to client

| Event | To | Payload | Versioned |
|---|---|---|---|
| `ride:snapshot` | the subscriber | `{ rideId, version, status, terminal, driverId, vehicle, pickup, dropoff, fareCents, retryUntil }` | yes |
| `ride_state_changed` | `ride:<id>` | `{ rideId, state, by: driver\|client\|system, version? }` | rank of the status (`requested` 1, `dispatching` 2, `accepted` 3, `en_route` 4, `arrived` 5, `in_progress` 6, terminals 10) |
| `driver_location` | `ride:<id>` | `{ rideId, lat, lng, heading }` | no |
| `ride_no_driver` | `user:<passenger>` | `{ rideId }` | no |
| `ride_dispatch_retry` | `user:<passenger>` | `{ rideId, retryCount, retryUntil }` (scheduled rides, first re-arm only) | no |
| `pool:snapshot` | the subscriber | `{ sharedRideId, version, seatCount, maxSeats, poolStatus, terminal, driverId, vehicle, completedAt, me { active, quotedFareCents, pickup, dropoff }, itinerary[] }` | yes |
| `pool:update` | `pool:<id>` | `{ sharedRideId, version, seatCount, maxSeats, poolStatus, terminal, driverId }` | `shared_rides.state_version` |
| `ride:completed` | `ride:<poolId>` | `{ rideId, completedAt }` | no (clients re-subscribe for a fresh snapshot) |
| `ride_offer` | `driver:<id>` | solo or shared offer payload | no |
| `ride_offer_accepted` | winner | `{ offerId, rideId, sharedRideId? }` | no |
| `ride_offer_revoked` | driver | `{ offerId, rideId?, sharedRideId?, reason: taken\|revoked\|unavailable, detail? }` | no |
| `ride_offer_outcome` | driver | `{ offerId, outcome: assigned\|lost\|expired\|revoked\|rejected, tripKind?, tripId?, generation?, reason?, assignment? }` | no |
| `driver:assignment` | driver | `{ driverId, assignment: solo\|shared view \| null }` | `assignment.version` |
| `driver_state` | driver, on connect | `{ availability, current_ride_id }` | no |
| `force_offline` | driver | `{ reason: "timeout" }` | no |
| `stop:pickup_confirmed` / `stop:drop_confirmed` | driver | `{ rideId, sequenceIndex, passengerId, type, confirmedAt, rideCompleted, version? }` | `state_version` |

Privacy rule: a pool snapshot hides other passengers' identity and coordinates (`itinerary[].lat/lng` only on `mine` stops).

## Ordering rules clients must implement

1. Keep the highest `version` applied per aggregate (ride or pool).
2. Apply a **snapshot** when its version is `>=` yours (it resets your view).
3. Apply an **incremental event** only when its version is strictly greater; drop duplicates, reorderings and events for another aggregate.
4. An event without a version (older server paths such as the `apply()` driver transition) is ranked by status via the table above; unversioned informational events (`ride_dispatch_retry`, `driver_location`) are applied to the followed ride only.
5. Re-send `ride:subscribe` / `pool:subscribe` on every `connect`. On an `unavailable` ack retry with backoff (web: 5 attempts, 1 s, 2 s, 4 s, 8 s, see [client knobs](../../POLICY.md#web)); `forbidden`/`not_found` are final.
6. Terminal ride statuses share rank 10, so nothing can regress a terminal ride.

Reference implementations: web `apps/web/src/lib/booking/ws.ts` (`createVersionGate`, `connectBookingSocket`); driver app `lib/core/realtime/realtime_socket.dart`, `offer_outcome.dart`, `driver_assignment.dart` and the shared-ride provider.

## Failure behaviour

- Emits happen after commit through `RealtimeBus`; a failure is logged and ignored. The next subscribe or `driver:sync` repairs any miss because snapshots come from Postgres, never from Redis.
- Redis down: the adapter pub/sub, geo/presence writes and BullMQ jobs fail (jobs retry, the reconciler repairs once Redis is back). Postgres-backed snapshots keep working.
- Deploys: all sockets drop; clients reconnect and resubscribe automatically.

## Policy knobs

[Realtime](../../POLICY.md#realtime): `REALTIME_LOCATION_FANOUT_MS` (1 s), `REALTIME_GEO_INDEX_GATE_MS` (3 s). Client: `realtime.subscribeMaxTries`, `realtime.subscribeBackoffMs`, `realtime.reconnectDelayMaxMs` (5 s). Driver: `sharedAcceptAckTimeout` (8 s). `RCAB_DISABLE_WS_ADAPTER=1` turns the Redis adapter off (tests).

## Code entry points

`modules/realtime/{realtime.gateway,realtime.bus,realtime.protocol,realtime-snapshot.service,realtime.module}.ts`; emitters in `modules/dispatch/dispatch.service.ts`, `modules/rides/ride-state-machine.service.ts`, `modules/ride-lifecycle/ride-lifecycle.service.ts`, `modules/matching/pool-lifecycle.service.ts`, `modules/drivers/drivers.service.ts`.

## Tests

Unit: `realtime.gateway.spec.ts`, `realtime.bus.spec.ts`, `realtime.protocol.spec.ts`. Integration: `realtime-snapshot.int.spec.ts`, `realtime-location.int.spec.ts`, `ride-realtime.int.spec.ts`, `dispatch-offer-gateway.int.spec.ts`. Web: `lib/booking/ws.test.ts`. Driver app: `test/core/realtime/`, `test/support/fake_realtime_socket.dart`. Video: W09 (reload and reconnect restore tracking) in the [web index](../videos/web/INDEX.md).

## Known gaps

- ~~The gateway was declared with `cors: { origin: '*' }`.~~ Fixed in 3a80460: socket CORS uses the same `resolveBrowserOrigins()` allowlist as REST (`CORS_ORIGINS`); native clients that send no `Origin` are still allowed.
- A suspended user's open sockets stay connected until they disconnect (token is only checked at connect).
- `ride_state_changed` emitted by the driver's forward transition carries no `version`; the web derives it from the status rank. Adding it would match the other emitters.
- Legacy constant `RIDE_SUBSCRIBE_REQUEST_EVENT` and its listener (`RidesRealtimeListener.onRideSubscribe`) are dead code since R09.
- No server push when an offer expires or a driver's socket is replaced by a newer one (two app instances).
