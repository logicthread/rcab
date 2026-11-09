# Dispatch and offers

Finding a driver for a trip: how a booking becomes offers, how exactly one driver wins, and what keeps the machinery honest when processes crash. Dispatch has **no HTTP surface**: it is driven by the outbox, BullMQ jobs and the driver's Socket.IO connection.

Back to [README](../README.md) · see also [normal-booking](normal-booking.md), [shared-rides](shared-rides.md), [scheduled-rides](scheduled-rides.md), [idempotency-and-durability](idempotency-and-durability.md) (outbox), [realtime-protocol](realtime-protocol.md) · diagrams: [state-machines](../state-machines.md) (offer states, ride states) · contract: [stage-c-contract](../../remediation/stage-c-contract.md).

## Moving parts

| Part | Role | File |
|---|---|---|
| Outbox row | The durable "please dispatch generation g of trip T" intent, written in the booking/pool-close transaction | `modules/outbox/*` |
| `OutboxRelay` | Leases due rows and publishes a deterministic BullMQ job `dispatch-start-<trip>-g<g>` | `outbox.relay.ts` |
| `DispatchProcessor` | BullMQ worker on queue `dispatch`: handles `dispatch:start`, `dispatch:wave-timeout`, `dispatch:hard-fail` | `dispatch.processor.ts` |
| `DispatchStartService` | Guards (state + generation), then runs wave 1. Also `wakeScheduled` for scheduled rides | `dispatch-start.service.ts` |
| `DispatchService` | `runSoloWave`, `runPoolWave`, `acceptOffer`, `declineOffer`, hard-fail, scheduled retry, timers | `dispatch.service.ts` |
| `DispatchOfferRepository` | `dispatch_offer` reads/writes, eligibility filter | `offer.repository.ts` |
| `DriverAssignmentRepository` | `driver_active_assignment` guard and the trip row locks | `assignment.repository.ts` |
| `DriverAssignmentProjection` | Mirrors the guard into Redis `driver:state:<id>.current_ride_id`; every 30 s repairs it and sweeps lapsed offers to `expired` | `driver-assignment.projection.ts` |
| `DispatchReconciler` | Boot and every 5 min: finds trips that should have work in flight, re-arms what is missing | `modules/outbox/dispatch-reconciler.service.ts` |
| `RealtimeGateway` | Receives `ride_offer_response`, answers with the accept result as the Socket.IO ack | `modules/realtime/realtime.gateway.ts` |

## Timeline of one normal ride (defaults)

```
t=0      booking commit: rides(requested, generation 1) + outbox ride.dispatch.requested
t~0      relay kick -> BullMQ dispatch:start -> wave 1:
           GEORADIUS active_drivers within R1=2000 m, up to K1*4 + offered candidates,
           Postgres eligibility filter, first K1=5 get a dispatch_offer (TTL 12 s) and a ride_offer event
         wave 1 also arms two delayed jobs for this generation:
t=30 s   wave 2: K2=10 within R2=4000 m, skipping drivers already offered this generation
t=60 s   hard fail: ride -> no_driver, live offers revoked, ride_no_driver + ride_state_changed(no_driver)
```

Observations: an offer lives 12 s but wave 2 starts at 30 s, so there is an idle gap; a driver who declined or let an offer lapse is never re-offered the same generation; a ride accepted at any moment cancels its pending timers.

Scheduled rides use the same code with a 4-minute window and a retry instead of a hard fail ([scheduled-rides](scheduled-rides.md)). A closed shared pool uses `runPoolWave` and aborts instead of failing a ride ([shared-rides](shared-rides.md)).

### Candidate selection

`selectCandidates`: read drivers already offered this generation, `GEORADIUS active_drivers` (ascending distance, `COUNT = K * DISPATCH_CANDIDATE_HEADROOM + offered`), drop the already offered, then keep only those that pass `eligibleCandidates` in Postgres: valid UUID, active `app_user` with role driver, a `driver` row, **no** `driver_active_assignment`, **no** live unexpired offer, and an active vehicle with `seats >= seatsNeeded`. The Redis geo index is advisory; Postgres decides.

### Creating an offer

`createOffer` runs in its own short transaction: `SELECT ... FOR SHARE` on the trip (must still be dispatchable at this generation), expires the driver's lapsed offers, then inserts. Unique constraints make this idempotent per (trip, generation, driver), allow at most **one live offer per driver at a time**, and forbid two accepted offers for one trip generation. The payload sent to the driver:

- solo `ride_offer`: `{ offerId, rideId, ttlMs, expiresAt, pickup, dropoff, fareCents, waveNumber }`
- shared `ride_offer`: `{ offerId, sharedRideId, ttlMs, expiresAt, stops[], passengerCount, waveNumber }` where each stop is `{ type, lat, lng, passengerId, sequenceIndex }`

`expiresAt` is the authoritative deadline (DB clock); the app's countdown is advisory.

## The accept transaction

Driver sends `ride_offer_response { offerId, accept: true }` (a UUID and a real boolean; anything else is `invalid_payload`). The trip is **derived from the stored offer**, never from the client. `acceptInTx` runs, in the contract lock order:

1. lock the trip row (`rides` or `shared_rides`, `FOR UPDATE`); serialises against other accepts, cancel, hard-fail, completion;
2. lock the offer row and re-check it belongs to this driver;
3. if the offer is already `accepted` for this driver and the guard still exists: **replay** the success (lost-ack recovery); if the guard was released since, `trip_not_claimable`;
4. reject if state is not `offered` (`offer_declined`, `offer_revoked`, or `trip_taken` if another driver holds the trip), if past `expires_at` on the DB clock (`offer_expired`, offer marked expired), or if the offer generation differs from the trip's (`offer_stale`);
5. trip state: solo must be `requested` and unassigned; shared must be `closed_full`/`closed_timeout`, unclaimed, with `seat_count >= 1` and exactly `2 * seat_count` itinerary stops (`itinerary_missing` otherwise);
6. driver eligibility at the decision: active driver account and a vehicle with enough seats (`driver_ineligible`, `vehicle_capacity`);
7. insert the **assignment guard** `driver_active_assignment` (`driver_busy` if the driver already holds a trip, `trip_taken` if the trip already has a driver);
8. bind the trip (`rides.driver_id`, status `accepted`, `accepted_at`, or `shared_rides.claimed_by_driver_id`), mark the offer `accepted`, revoke every other live offer for the trip.

Deadlock or serialization victims retry twice, then answer `conflict` (the offer stays live; the driver may tap again).

After commit, best effort and never turning success into failure: project `current_ride_id`, remove the wave-2/hard-fail timers, send the winner `ride_offer_accepted` and `ride_offer_outcome { outcome: "assigned", assignment }`, send each loser `ride_offer_revoked { reason: "taken" }` and `ride_offer_outcome { outcome: "lost" }`, tell the ride room `ride_state_changed accepted` (solo) or publish a versioned `pool:update` (shared).

Decline: `ride_offer_response { accept: false }` runs one guarded UPDATE; result `declined | not_found | not_live`.

### Ack and outcome vocabulary

| Accept ack | Meaning |
|---|---|
| `{ ok: true, trip, generation, replay }` | committed (or replayed) |
| `{ ok: false, reason }` | `offer_not_found`, `offer_expired`, `offer_declined`, `offer_revoked`, `offer_stale`, `trip_taken`, `trip_not_claimable`, `itinerary_missing`, `driver_busy`, `driver_ineligible`, `vehicle_capacity`, `conflict` |
| `{ ok: false, reason: invalid_payload \| forbidden \| unavailable }` | gateway-level refusal |

`ride_offer_outcome.outcome` is one of `assigned | lost | expired | revoked | rejected` (mapping in `realtime.protocol.ts#outcomeForAcceptFailure`). Legacy clients also receive `ride_offer_revoked` for a refused accept.

## Hard fail, abort, retry

- **Solo normal**: `handleHardFail` calls `markNoDriver` in one transaction (ride must still be `requested`, unassigned, same generation), revokes live offers, emits `ride_no_driver` to `user:<passenger>` and `ride_state_changed no_driver` (version 10), removes timers.
- **Scheduled**: the same job re-arms the ride under a new generation instead (until the retry cutoff).
- **Shared pool**: the pool becomes `aborted`; members are released by trigger and see the terminal state in `pool:update`. Members are **not** automatically re-queued as solo rides (owner decision F-5).
- A cancel (client or driver) revokes offers and releases the guard in its own transaction, then `RIDE_CANCELLED_EVENT` makes dispatch drop the timers.

## Crash safety

- The relay leases rows for 30 s; a crashed publisher's rows are retried. Jobs have deterministic ids (`dispatch-start-<trip>-g<g>`, `dispatch-wave2-<trip>-g<g>`, `dispatch-hardfail-<trip>-g<g>`), so a re-publish never duplicates work. BullMQ retries a failing job 5 times with exponential backoff.
- Every handler re-checks state and generation first, so a stale, duplicate or late job is a successful no-op.
- `DispatchReconciler` (boot + every 5 min, trips touched in the last 15 s skipped): re-arms missing wake jobs, missing `dispatch:start`, missing wave-2/hard-fail timers, missing pool-expiry jobs, and closes out scheduled rides whose window lapsed. It logs `reconcile repaired missing durable work` when it changes anything and exposes the backlog as outbox gauges.
- If Redis is flushed, the reconciler rebuilds timers from Postgres; the geo index refills as drivers' location packets arrive. See the Redis-loss drill in [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md).

## Data

`dispatch_offer` (state `offered|accepted|declined|expired|revoked`, `dispatch_generation`, `wave_number`, `expires_at`, `resolved_at`), `driver_active_assignment`, `outbox` (topics `ride.dispatch.requested`, `pool.dispatch.requested`, `ride.wake.schedule`, `pool.expire.schedule`), `rides.dispatch_generation`, `shared_rides.dispatch_generation`. Migrations 0014 and 0015. Redis: `bull:dispatch:*`, `bull:scheduled-dispatch:*`, `bull:matching:*`, `driver:state:<id>.current_ride_id`.

Operator tools: `/redis-inspect`, `/pool-inspect`, `/db-migrate`; invariant SQL in [stage-c-contract](../../remediation/stage-c-contract.md) section 6; `scripts/recovery/resolve-driver-conflict.sql` for a driver with two active trips found by migration 0014 (`migration_conflict` table).

## Policy knobs

[Dispatch](../../POLICY.md#dispatch-normal-rides): `DISPATCH_K1` (5), `DISPATCH_K2` (10), `DISPATCH_R1_METERS` (2000), `DISPATCH_R2_METERS` (4000), `DISPATCH_OFFER_TTL_MS` (12 s), `DISPATCH_WAVE_ONE_TIMEOUT_MS` (30 s), `DISPATCH_HARD_FAIL_MS` (60 s), `DISPATCH_CANDIDATE_HEADROOM` (4), `DISPATCH_ASSIGNMENT_RECONCILE_MS` (30 s). [Outbox relay and reconciler](../../POLICY.md#outbox-relay--reconciler): poll 1 s, batch 50, lease 30 s, 10 publish attempts, 5 job attempts, reconcile every 5 min with 15 s grace. [Scheduled booking](../../POLICY.md#scheduled-booking) for the window. Cross-field: R1 <= R2 and wave-1 timeout < hard fail.

## Code entry points

`apps/api/src/modules/dispatch/*`, `modules/outbox/*`, `modules/realtime/realtime.gateway.ts` (`handleRideOfferResponse`), `modules/realtime/realtime.protocol.ts`. Driver app: `features/offer/{offer_controller,offer_provider,offer_screen,offer_models}.dart`, `core/realtime/{realtime_socket,offer_outcome,driver_assignment}.dart`.

## Tests

Unit: `dispatch.service.spec.ts`, `dispatch.processor.spec.ts`, `dispatch-start.service.spec.ts`, `offer-assignment.repository.spec.ts`, `driver-assignment.projection.spec.ts`, `outbox.relay.spec.ts`, `dispatch-reconciler.service.spec.ts`, `outbox.jobs.spec.ts`. Integration (real Postgres/Redis): `dispatch-offer-assignment.int.spec.ts` (claim races), `dispatch-offer-gateway.int.spec.ts`, `dispatch-pool.int.spec.ts`, `outbox-dispatch.int.spec.ts`, `outbox-e2e.int.spec.ts`, `migrations-stage-c.int.spec.ts`. Driver app: `test/features/offer/`, `test/core/realtime/`. Videos: D04, D05, D06, D07 ([driver app index](../videos/driver-app/INDEX.md)), W03, W06, W07 ([web index](../videos/web/INDEX.md)); metrics M01, M02 ([ops index](../videos/ops/INDEX.md)).

## Known gaps

- No push when an offer lapses: the driver app relies on its own countdown; the server marks the row `expired` lazily (on the next accept attempt or the 30 s sweep) and only then sends `expired`.
- Idle gap between offer TTL (12 s) and wave 2 (30 s); wave 2 never re-offers wave-1 drivers.
- Dispatch is nearest-first by straight-line geo distance; there is no ETA, rating or acceptance-rate ranking.
- A pool that nobody accepts is aborted and its passengers are not re-queued as solo rides (owner decision F-5).
- The geo index does not hold driver heading/vehicle; the accept transaction is the only authority on vehicle capacity.
- Accept/decline are Socket.IO only. A driver whose socket is down cannot respond; there is no REST fallback.
- Nest `Logger` output (the `warn`/`error` lines in these services, including "no fresh candidates this wave" and reconciler repairs) is currently dropped, so the log lines described above do not reach stdout or Loki (see [admin-and-observability](admin-and-observability.md) known gaps).
