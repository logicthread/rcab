# Shared rides (pools)

Up to three passengers whose routes overlap share one driver. A booking either joins an open **pool** or opens a new one; the pool closes when full or after 60 s, is dispatched to drivers as one multi-stop trip, and is driven stop by stop.

Back to [README](../README.md) · see also [quoting-and-pricing](quoting-and-pricing.md) (seat fare), [dispatch-and-offers](dispatch-and-offers.md), [realtime-protocol](realtime-protocol.md), [idempotency-and-durability](idempotency-and-durability.md) · diagrams: [state-machines](../state-machines.md) (pool states) · design: `70-algorithms/` route-similarity, `10-product/features-shared-rides.md`, `99-decisions/ADR-0010-shared-ride-route-similarity.md`.

## What it does

1. **Match.** `MatchingService.findOrCreatePool` asks Postgres/PostGIS for open pools with free seats whose origin **and** destination centroids are within `MATCHING_PREFILTER_RADIUS_M` (1500 m) of the request. Each candidate is scored by route similarity and a detour check; qualified pools are tried best first.
2. **Join or open.** The first pool that accepts the seat wins (`mode: "slotted"`); if none does, a new pool is opened with the passenger as the first member (`mode: "opened"`).
3. **Close.** The pool leaves `open` when the last seat is taken (`closed_full`) or 60 s after it opened (`closed_timeout`, only if it has members). Closing, in the same transaction, bumps the dispatch generation, persists the **itinerary** to `ride_stops`, and writes the `pool.dispatch.requested` outbox row.
4. **Dispatch.** Drivers get one offer showing all stops; the first valid accept claims the pool ([dispatch-and-offers](dispatch-and-offers.md)).
5. **Drive.** The driver confirms stops in order. The first pickup moves the pool to `closed_started`; the last stop completes it and frees the driver.

### Similarity and detour

`RouteSimilarityService.scoreRoutes` fetches both OSRM road polylines (cached in Redis `osrm:poly:*` for 1 h), resamples them, and takes the mean nearest-neighbour distance `d`; score `s = 1 - d / ROUTE_SIMILARITY_SATURATION_M` (1200 m), floored at 0. A pool qualifies when `s >= MATCHING_SIMILARITY_THRESHOLD` (0.7) and the straight-line distance between the two origins and between the two destinations is at most the pool's `detour_budget_m` (800 m). Candidates are ranked by `s - 0.0005 * (originDetour + destDetour)`.

### Seat transaction (optimistic pricing)

`PoolLifecycleService.joinPool` (no network call is ever made under the pool lock):

1. read an unlocked snapshot (pool row + members); fail fast if missing, closed or full;
2. price the seat from that snapshot via OSRM (seat count after join, itinerary including the joiner) with no transaction open;
3. transaction: lock the pool `FOR UPDATE`, re-validate open + capacity, and compare `state_version` with the snapshot. If it moved, discard the quote and go to step 1 (at most `MATCHING_JOIN_PRICE_RETRIES` = 3 retries; after that the result is a typed `conflict` and the matcher tries the next pool or opens a new one);
4. insert the `pool_member` with its `agreed_fare_cents`; close `closed_full` in the same transaction if this seat filled the pool; complete the idempotency claim; commit;
5. after commit: project Redis `pool:<id>`, join the passenger's sockets to `pool:<id>`, emit a versioned `pool:update`; kick the relay if the pool closed.

Triggers (migration 0016) back this up for any writer that forgets: inserts only into an `open` pool, `seat_count` is derived from `pool_member`, a CHECK rejects oversubscription, and members are deactivated when the pool reaches `aborted` or `completed`. A passenger can hold **one active seat at a time** (unique partial index `pool_member_one_active_pool_uq`); a second booking gets 409 `passenger_has_active_pool` with the existing `sharedRideId`.

### Itinerary

`computeStops` (`matching/itinerary.ts`, pure, deterministic): pickups ordered by distance from the pool anchor (the opener's origin), then dropoffs by nearest neighbour starting from the last pickup, ties broken by passenger id. Stored as `ride_stops` rows `0..2n-1` (`pickup`/`dropoff`, `passenger_id`, `lat`, `lng`, `confirmed_at`). Accept requires exactly `2 * seat_count` stops.

## User-visible behaviour

| Who | What they see | Video |
|---|---|---|
| Passenger A (opener) | Chooses **Share**, quote shows an indicative per-seat price, presses "Book share". Status area shows the pool status (`open`), seat count and "Your fare: Rs X (fixed when you joined)" | W07 |
| Passenger B (joiner) | Same flow; response is `slotted`. A's screen updates through `pool:update`: a green badge "1 other rider joining - your fare is ready" | W07 |
| Pool full or timeout | Status moves to `closed_full` or `closed_timeout`. If it times out with a single member the web shows "No co-rider found - continuing as private" with the solo fare | W07 |
| Driver | One offer card listing the stops; after accept a multi-stop screen with the ordered stop list and a confirm action for the next pending stop | D06 |
| Completion | Last drop confirmed: pool `completed`, `ride:completed` emitted to the pool's ride room | W07, D06 |

Scene IDs: [W07](../videos/web/INDEX.md), [D06](../videos/driver/INDEX.md).

## API and socket events

| Call | Notes |
|---|---|
| `POST /v1/rides/quote` (`type=shared`) | adds `sharedEstimate` |
| `POST /v1/rides` (`type=shared`) | Client only. No quote token needed. `Idempotency-Key` optional (strongly recommended; the web sends one). Response `{ sharedRideId, passengerId, mode: opened\|slotted, poolStatus: open\|closed_full, perSeatPrice, farePolicy: "fixed_at_join", seatMultiplier?, detourFactor? }`. 409 `idempotency_request_in_progress`, 409 `passenger_has_active_pool`, 409 `pool_conflict` (retry), 422 `idempotency_key_conflict`, 503 routing unavailable |
| `GET /v1/rides/:id/stops` | The claimed driver only (403 otherwise). `{ rideId, poolStatus, stops[{ sequenceIndex, passengerId, type, lat, lng, confirmed, confirmedAt }] }` |
| socket `pool:subscribe { sharedRideId }` | Members only. Ack `{ ok, snapshot }` and a `pool:snapshot` event. Re-sent on every reconnect |
| socket `pool:update` | `{ sharedRideId, version, seatCount, maxSeats, poolStatus, terminal, driverId }` to room `pool:<id>` |
| socket `pool:snapshot` | update fields plus `vehicle`, `completedAt`, `me { active, quotedFareCents (the agreed fare), pickup, dropoff }`, `itinerary[]` where other passengers' stops hide their coordinates |
| socket `stop:pickup_confirmed` / `stop:drop_confirmed` | Driver to server `{ rideId, sequenceIndex }`. Strictly in sequence order; a repeat is answered with the current state (idempotent). The driver gets the same event back `{ rideId, sequenceIndex, passengerId, type, confirmedAt, rideCompleted, version }` |
| socket `ride:completed` | To room `ride:<poolId>` `{ rideId, completedAt }` when the final stop is confirmed |

There is **no HTTP or socket call for a passenger to leave a pool or cancel a shared booking**, and `POST /v1/rides/:id/cancel` and `/state` act only on solo `rides` rows (a pool id returns 404).

## Pool states

`open`, `closed_full`, `closed_timeout`, `closed_started`, `aborted`, `completed` (`shared_rides.pool_state` CHECK). `aborted` happens when an empty open pool times out or when no driver accepts before the hard fail. Terminal: `aborted`, `completed`. `shared_rides.state_version` rises on every UPDATE and is the realtime version number.

## Data

`shared_rides` (pool, `max_seats` 3, `detour_budget_m`, `claimed_by_driver_id`, `dispatch_generation`, `state_version`, PostGIS centroids from migration 0003), `pool_member` (one row per passenger, `agreed_fare_cents`, `idempotency_key`, `active`), `ride_stops`, `idempotency_record`, `outbox`. Migrations 0003 to 0005, 0014 to 0017. Legacy: `shared_rides.members` JSON column is no longer the source of truth. Redis: `pool:<id>` hash (`version, state, seat_count, max_seats, claimed_by`, 10 min TTL), written compare-by-version after commit and rebuilt at boot.

## Policy knobs

[Shared-ride matching and pools](../../POLICY.md#shared-ride-matching--pools): `MATCHING_POOL_TIMEOUT_MS` (60 s), `MATCHING_MAX_SEATS` (3), `MATCHING_PREFILTER_RADIUS_M` (1500), `MATCHING_DETOUR_BUDGET_M` (800), `MATCHING_SIMILARITY_THRESHOLD` (0.7), `MATCHING_JOIN_PRICE_RETRIES` (3), `ROUTE_SIMILARITY_SATURATION_M` (1200). Fare: [Pricing](../../POLICY.md#pricing--fares). Dispatch of the closed pool uses the normal [dispatch knobs](../../POLICY.md#dispatch-normal-rides). Driver app: `sharedAcceptAckTimeout` 8 s ([driver app knobs](../../POLICY.md#driver-app)).

## Code entry points

API: `modules/matching/{matching.service,pool-lifecycle.service,pool-membership.repository,shared-ride.repository,ride-stop.repository,itinerary,route-similarity.service,pool-projection.service,pool-expire.processor}.ts`; `modules/ride-lifecycle/ride-lifecycle.service.ts` (`confirmStop`); `modules/rides/rides.controller.ts` (`createShared`, `allocateSharedSeat`, `listStops`); `modules/realtime/realtime-snapshot.service.ts`. Web: `app/book/{book-client,pool-badge,solo-fallback-banner}.tsx`, `lib/booking/{ws,store}.ts`. Driver app: `features/shared_ride/*`.

## Tests

Unit: `matching.service.spec.ts`, `pool-lifecycle.service.spec.ts`, `pool-membership.repository.spec.ts`, `pool-projection.service.spec.ts`, `route-similarity.service.spec.ts`, `ride-lifecycle.service.spec.ts`. Integration: `matching-service.int.spec.ts`, `pool-lifecycle.int.spec.ts`, `pool-membership.int.spec.ts`, `pool-fare.int.spec.ts`, `pool-optimistic-pricing.int.spec.ts`, `route-similarity.int.spec.ts`, `dispatch-pool.int.spec.ts`, `ride-lifecycle.int.spec.ts`, `realtime-snapshot.int.spec.ts`. Web: `pool-badge.test.tsx`, `book-client.test.tsx`, `lib/booking/ws.test.ts`. Driver app: `test/features/shared_ride/`. Manual walk: [RUN-GUIDE](../../manual-testing/RUN-GUIDE.md) section 6 (Demo 4).

## Known gaps

- **No leave/cancel for a shared seat** (passenger or driver). A pool ends only by completion or abort.
- **Web does not restore a pool on reload** (only a solo ride id is persisted) and has no driver map, driver details, stop progress or rating screen for a shared trip, although `driver_location` is delivered to `ride:<poolId>`.
- Slotted joins hard-code `seatCount = 2` in the web store until the first `pool:snapshot` / `pool:update` corrects it.
- A single-member pool that times out is still dispatched as a one-passenger pool (the "continuing as private" copy is a UI message, not a conversion to a solo ride).
- Pools whose dispatch fails are aborted and their members are not re-queued (owner decision F-5).
- Fare policy is the `fixed_at_join` stand-in (E8.S9 pending); the commission/payout helper is unused.
- Ratings are solo only ([ratings](ratings.md)).
- Pool similarity is geometry only: no time-of-day, waiting-time or luggage rules; max 3 seats and one seat per passenger.
