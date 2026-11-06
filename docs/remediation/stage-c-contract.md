# Stage C design contract: offers/assignment, outbox, pool membership

Branch `remediation/stage-c`. Story trailer: `Story: RCAB-E8.S8`.
Findings: F05, F06 (R06), F08 (R07), F09 (+ part of F15) (R08). Test IDs refer to guide §9.

The architect commit has landed the schema (migrations 0014–0016 and Drizzle definitions) and a few shared, logic-free helpers. Three implementer slices build on it. **A** handles offers and assignment, **B** the outbox and durable work, and **C** pool membership. Each slice owns a disjoint set of files or functions, listed in §5. Treat this document as the interface between slices. If you need to change an interface, write the change down in your final report. Do not silently edit another slice's code.

---

## 0. Owner-approved decisions (guide §3) and non-goals

| Decision | What Stage C does |
|---|---|
| Offer validity | A `dispatch_offer` row in Postgres is the authority. Accept validates it inside the assignment transaction, against the DB clock. Redis is not consulted for accept or decline. |
| Driver exclusivity | `driver_active_assignment` (PK `driver_id`, UNIQUE `solo_ride_id`, UNIQUE `shared_ride_id`) is the one guard for both trip tables. |
| Pool seats | Each member holds exactly one seat (`pool_member.seats CHECK = 1`). Group bookings are out of scope. |
| Durable work | A transactional `outbox` is written in the business transaction. An in-process relay publishes it to BullMQ. A BullMQ job completes only when the actual dispatch work has finished. |
| Scheduled wake | The wake stays at T−10 min (`SCHEDULED_WAKE_LEAD_MS`). **The escalation/accept window is NOT changed.** See flag F-1 in §9. |
| Redis loss | Jobs and projections are rebuilt from Postgres: reconcile on boot, then periodically. Drivers re-establish presence themselves. |
| Phase-0 | Single VPS and no new services. Postgres, Redis, BullMQ and the api process are all we use. Polling is acceptable. Do not add LISTEN/NOTIFY infrastructure unless it is trivial. |

Non-goals in Stage C, which belong to later stages: realtime snapshots and the ack protocol for clients (R09), Flutter/web changes, the shared-fare policy (F15 product decision), member cancellation or pool fallback to solo, and vault/doc notes. The slices **must not** edit `apps/driver-app/`, `apps/web/` or any vault note (`00-`…`99-`). Each slice lists the doc deltas it needs in its final report, for a later docs pass.

---

## 1. What has already landed (architect commit)

### 1.1 Migrations (verified on a scratch DB on top of 0013 by `test/integration/migrations-stage-c.int.spec.ts`, and the whole int suite is green)

**`0014_dispatch_offer_assignment.sql`**
- `migration_conflict` (id, migration, kind, subject jsonb, detail jsonb, detected_at, resolved_at, resolution; UNIQUE (migration, kind, subject)). This is the operator inventory of rows a migration could not apply mechanically.
- Adds `rides.dispatch_generation` and `shared_rides.dispatch_generation` (int, default 0, CHECK ≥ 0). Backfill: everything is set to 1 except un-woken scheduled rides (`type='scheduled' AND status='requested'`) and open pools, which stay at 0.
- `dispatch_offer`:
  - Columns: id, trip_kind ∈ {solo, shared}, ride_id FK rides, shared_ride_id FK shared_rides (exactly one is set, and it matches trip_kind), driver_id FK driver(user_id), dispatch_generation ≥ 1, wave_number, state ∈ {offered, accepted, declined, expired, revoked}, offered_at, expires_at > offered_at, resolved_at (NULL ⇔ state='offered').
  - UNIQUE (ride_id, gen, driver_id) and UNIQUE (shared_ride_id, gen, driver_id). These replace the Redis `…:offered` sets.
  - Partial UNIQUE `dispatch_offer_one_live_per_driver_uq` (driver_id) WHERE state='offered'. This reserves the **driver**, which is the F06 reservation fix.
  - Partial UNIQUE for one accepted offer per (trip, generation): `dispatch_offer_solo_one_accept_uq` and `dispatch_offer_shared_one_accept_uq`.
  - Index on `expires_at` WHERE state='offered'.
- `driver_active_assignment`:
  - PK driver_id FK driver; UNIQUE solo_ride_id FK rides; UNIQUE shared_ride_id FK shared_rides; UNIQUE offer_id FK dispatch_offer ON DELETE SET NULL; dispatch_generation ≥ 1; assigned_at.
  - CHECK exactly one trip is set.
  - Backfill comes from active solo rides (`accepted|en_route|arrived|in_progress` with driver_id) and claimed non-terminal pools (`closed_full|closed_timeout|closed_started`).
  - A driver with more than one active trip, or a trip whose driver has no `driver` row, gets **no** guard row. Those trips are recorded as `driver_multiple_active_trips` or `assignment_unknown_driver`.

**`0015_outbox.sql`**
- `outbox`:
  - Columns: id, topic (CHECK `^[a-z]+(\.[a-z_]+)+$`), aggregate_type ∈ {ride, shared_ride}, aggregate_id, aggregate_generation, payload jsonb object, payload_version, dedupe_key, available_at, attempts, max_attempts (10), last_error, lease_token and leased_until (both NULL or both set), processed_at, failed_at (never both set), created_at, updated_at.
  - UNIQUE dedupe_key.
  - Index `outbox_due_idx` (available_at) WHERE processed_at IS NULL AND failed_at IS NULL.
- Backfill: one `ride.wake.schedule` row, at g1, for each un-woken scheduled ride. This also covers the F08 repro, where the wake was lost.

**`0016_pool_membership.sql`**
- `pool_member`:
  - Columns: pool_id FK shared_rides, passenger_id FK app_user, seats (=1), origin/dest lat/lng, quoted_fare_cents, idempotency_key, active, joined_at, left_at (NULL ⇔ active).
  - PK (pool_id, passenger_id). UNIQUE (passenger_id, idempotency_key). Partial UNIQUE `pool_member_one_active_pool_uq` (passenger_id) WHERE active.
- `shared_rides.state_version bigint`. `CHECK shared_rides_seat_capacity_check (0 ≤ seat_count ≤ max_seats)` and `CHECK max_seats ≥ 1`.
- Triggers. **All of them are part of the contract.**
  - `pool_member_require_open_trg` (BEFORE INSERT): locks the shared_rides row and raises 23514 / constraint `pool_member_pool_open` unless pool_state='open'.
  - `pool_member_sync_seat_count_trg` (AFTER INSERT/DELETE): runs `seat_count ± seats`. **seat_count is derived and the app never writes it.** On oversubscription the capacity CHECK fails inside this trigger (23514 / `shared_rides_seat_capacity_check`).
  - `pool_member_immutable_identity_trg`: pool_id, passenger_id and seats are immutable.
  - `shared_rides_release_members_trg`: when pool_state becomes `aborted` or `completed`, every member's `active` is set to false and `left_at` to now().
  - `shared_rides_bump_state_version_trg` (BEFORE UPDATE): `state_version += 1`.
- Backfill: jsonb `members` is copied into `pool_member`. Problems are inventoried as `pool_member_malformed`, `pool_member_unknown_passenger`, `pool_member_duplicate_in_pool`, `passenger_multiple_active_pools` (only the newest-joined membership stays active), `pool_over_capacity` (max_seats is raised to the member count) and `pool_seat_count_mismatch` (seat_count is set to the member count).
- `shared_rides.members` jsonb is **deprecated**. Stage C code stops writing it. A later migration drops it.

### 1.2 Shared code (import it, do not fork it)

| File | Contents | Owner after this commit |
|---|---|---|
| `apps/api/src/db/schema.ts` | `migrationConflict`, `dispatchOffer` (+ `DispatchOfferState`), `driverActiveAssignment`, `outbox`, `poolMember`; `rides.dispatchGeneration`; `sharedRide.dispatchGeneration`, `sharedRide.stateVersion` | Frozen. A schema change needs a new migration (0017+), and the slice must report it. |
| `apps/api/src/db/constraints.ts` | `Constraint.*` names, SQLSTATE constants, `pgConstraintViolation(err)` (unwraps drizzle `cause`) | Frozen. You may append new names. |
| `apps/api/src/infra/db/drizzle.module.ts` | `DrizzleTx`, `DbExecutor = DrizzleDb \| DrizzleTx` | Frozen. |
| `apps/api/src/modules/outbox/outbox.types.ts` | `OutboxTopic`, payload types, `OutboxMessage`, `outboxDedupeKey()` | B. Others import only. |
| `apps/api/src/modules/outbox/outbox.writer.ts` | `enqueueOutbox(tx, message): Promise<boolean>` (INSERT … ON CONFLICT (dedupe_key) DO NOTHING) | B. Others call it. |
| `rides.repository.ts` `RideRow.dispatchGeneration` + `toRow` | mapping only | A owns `RideRow`/`toRow` from now on. |
| `shared-ride.repository.ts` `SharedRideRow.dispatchGeneration`, `.stateVersion` + SELECT/rowFromDb | mapping only | C owns. |

### 1.3 Global rules (all slices)

1. **Lock order.** Every transaction acquires locks in this order:
   1. the trip row, `rides` or `shared_rides`, with `SELECT … FOR UPDATE`;
   2. `dispatch_offer` rows, `FOR UPDATE`;
   3. `driver_active_assignment` (INSERT or DELETE);
   4. `pool_member` and `ride_stops`;
   5. `outbox` INSERT and `idempotency_record`.

   No transaction locks two trip rows. If you need to find the trip from an offer, read the offer without a lock first, then lock the trip, then re-read the offer `FOR UPDATE` and re-validate.
2. **DB clock.** Expiry and deadlines are compared in SQL (`now()`, `expires_at <= now()`), never against `Date.now()` on the app side, after the lock has been taken.
3. **Typed conflicts.** Expected 23505/23514 violations are mapped with `pgConstraintViolation(err)` and the `Constraint.*` names into result unions. Never match on message text. If an expected violation must not abort the outer transaction, wrap that single statement in a savepoint (`tx.transaction(async (sp) => …)`). On 40P01 (deadlock) or 40001, retry the whole transaction at most twice, then return a typed `'conflict'` result.
4. **After commit only.** Socket.IO emits, Redis projection writes, `queue.remove`, timers and relay kicks happen after commit. A failure there must never turn a committed success into an error response. Log it and let reconciliation repair it.
5. **No network inside a lock.** No OSRM, Redis or BullMQ calls between `BEGIN` and `COMMIT`. The single exception is the relay's own *short* lease transaction, which contains no network call either (lease, commit, then publish, then ack).
6. **Generation.** Every offer, BullMQ job payload and outbox row carries the trip's `dispatch_generation`. A consumer whose generation ≠ the row's current generation does nothing and returns success (stale work is not an error).
7. **BullMQ job IDs.** New job IDs contain no colons: `dispatch-start-<tripId>-g<g>`, `dispatch-wave2-<tripId>-g<g>`, `dispatch-hardfail-<tripId>-g<g>`, `scheduled-wake-<rideId>-g<g>`, `pool-expire-<poolId>`. Legacy jobs that are in flight at deploy time (`dispatch:wave2-timeout:<id>`, `dispatch:hard-fail:<id>`, `scheduled:wake:<id>`, `pool:expire:<id>`) must still be handled, by treating a missing `generation` as "the current generation". When removing jobs, remove both the legacy and the new IDs.
8. **No Lua decision points.** `pool_claim.lua` and `pool_slot.lua` are deleted. Any compare-and-set for a Redis projection is an inline `EVAL` string constant, not a new `.lua` asset.
9. **Test fixtures.** The new FKs mean every driver used in a test needs `app_user` + `driver` rows, plus an active `vehicle` row where eligibility is checked. Every pool passenger needs an `app_user` row. Use `uniquePhone()`. Contention tests use **independent `pg.Client` / Pool connections**, never `Promise.all` on one client.
10. **Gate.** Each slice runs `pnpm --filter @rcab/api typecheck`, `lint`, `test` and `test:int` before it reports done. The end-to-end flow is green only after all three slices merge (§8), and `pnpm verify` is run then.

---

## 2. Slice A: offers-assignment (R06; F05, F06; tests T18–T22, T31-server side)

### 2.1 Files A owns

| File | Scope |
|---|---|
| NEW `apps/api/src/modules/dispatch/offer.repository.ts` | whole |
| NEW `apps/api/src/modules/dispatch/assignment.repository.ts` | whole (guard + trip-claim SQL for both tables) |
| NEW `apps/api/src/modules/dispatch/driver-assignment.projection.ts` | whole (Redis `current_ride_id` projection + reconcile) |
| `apps/api/src/modules/dispatch/dispatch.service.ts` | **everything except** B's functions (`onRideRequested`, `dispatchSolo`, `dispatchPool`, `onPoolClosed`, `RIDE_REQUESTED_EVENT`/`RideRequestedEventPayload`) and C's pure-helper section (`computeStops` … `orderDropoffsNearestNeighbour`). A owns the **constructor**, `onRideOfferResponse`, `runSoloWave`, `runWave` (rename it `runPoolWave`), `handleWaveTimeout`, `handleHardFail`, `onRideCancelled`, `releaseDispatch`, `claimPool`, `claimSolo`, `persistStops` (delete), `revokeAllOffers`, `selectCandidates`, `reserveOffer`, `getOrComputeStops` (delete), the job-id helpers, the constants, and the `WaveTimeoutJob`/`HardFailJob` types. |
| `apps/api/src/modules/dispatch/dispatch.types.ts` | whole |
| `apps/api/src/modules/dispatch/dispatch.module.ts` | whole (B does **not** edit it; see B's runner module) |
| `apps/api/src/modules/dispatch/lua/pool_claim.lua` | delete |
| `apps/api/scripts/copy-assets.mjs` / `check-artifact.mjs` | only the `pool_claim.lua` entry |
| `apps/api/src/modules/realtime/realtime.gateway.ts` | only `handleRideOfferResponse` + `RideOfferResponsePayload`/`RideOfferResponseEvent` |
| `apps/api/src/modules/rides/rides.repository.ts` | `RideRow`, `toRow`, `claimSolo`, `markNoDriver`, `transition`, `cancel` |
| `apps/api/src/modules/rides/ride-state-machine.service.ts` | whole |
| `apps/api/src/modules/ride-lifecycle/*` | whole |
| `apps/api/src/modules/matching/ride-stop.repository.ts` | whole (`seed` may be deleted once `persistStops` is gone; C writes stops through its own repository) |
| `apps/api/src/modules/matching/shared-ride.repository.ts` | only `setClaimed` (rewrite or delete) |
| Tests | `dispatch.service.spec.ts`, `ride-state-machine.service.spec.ts`, `ride-lifecycle.service.spec.ts`, `rides-realtime.listener.spec.ts`, `test/integration/ride-lifecycle.int.spec.ts`, `ride-realtime.int.spec.ts`, `ride-state-machine.int.spec.ts`; in `dispatch-pool.int.spec.ts` the shared setup plus the `it` blocks "dispatchPool fans out…", "claimPool atomic Lua…", "handleHardFail with no claim…", "dispatchSolo fans out…", "claimSolo (solo)…", "handleHardFail (solo)…"; in `rides-idempotency.int.spec.ts` the block "concurrent client-cancel + driver-cancel…"; NEW `test/integration/dispatch-offer-assignment.int.spec.ts`. |

A must not touch: the outbox files, `scheduled/*`, `dispatch.processor.ts`, the controller create paths, `pool-lifecycle.service.ts`, `matching.service.ts`, the pool_member write paths, or migrations.

### 2.2 Types and repository methods A adds

```ts
// dispatch.types.ts
export type TripRef = { kind: 'solo'; rideId: string } | { kind: 'shared'; sharedRideId: string };

export type AcceptOfferResult =
  | { ok: true; trip: TripRef; generation: number; replay: boolean }
  | { ok: false; reason:
      | 'offer_not_found'      // unknown id OR not this driver's offer (no leak)
      | 'offer_expired' | 'offer_declined' | 'offer_revoked'
      | 'offer_stale'          // offer.generation ≠ trip.dispatch_generation
      | 'trip_taken'           // another assignment/accepted offer exists
      | 'trip_not_claimable'   // solo not 'requested'; pool not closed_full|closed_timeout, or aborted
      | 'itinerary_missing'    // shared: ride_stops not persisted (C persists at closure)
      | 'driver_busy'          // Constraint.AssignmentDriverBusy
      | 'driver_ineligible'    // app_user not active driver / no driver row
      | 'vehicle_capacity'     // no active vehicle with seats ≥ needed
      | 'conflict' };          // bounded retry exhausted (deadlock/serialization)

export type DeclineOfferResult = 'declined' | 'not_found' | 'not_live';
```

```ts
// offer.repository.ts — DispatchOfferRepository (@Injectable, DRIZZLE_DB)
createOffer(db: DbExecutor, p: { trip: TripRef; driverId: string; generation: number;
  waveNumber: number; ttlMs: number }): Promise<{ offerId: string; expiresAt: Date } | null>;
  // In ONE statement batch: expire this driver's lapsed offers
  //   (UPDATE … SET state='expired', resolved_at=now() WHERE driver_id=$d AND state='offered' AND expires_at<=now()),
  // then INSERT … expires_at = now() + ttl ON CONFLICT DO NOTHING RETURNING.
  // null ⇒ driver holds a live offer or was already offered this trip generation.
findForDriver(db: DbExecutor, offerId: string, driverId: string): Promise<OfferRow | null>;
lockForUpdate(tx: DrizzleTx, offerId: string): Promise<OfferRow | null>;
markAccepted(tx: DrizzleTx, offerId: string): Promise<void>;
decline(db: DbExecutor, offerId: string, driverId: string): Promise<DeclineOfferResult>;
revokeLiveForTrip(tx: DbExecutor, trip: TripRef, exceptOfferId?: string):
  Promise<Array<{ offerId: string; driverId: string }>>;  // state='revoked', resolved_at=now()
expireLapsed(db: DbExecutor): Promise<number>;            // sweeper + boot
eligibleCandidates(db: DbExecutor, candidateIds: string[], seatsNeeded: number): Promise<string[]>;
  // keeps input (distance) order; drops: no driver row, app_user.status<>'active' or role<>'driver',
  // existing driver_active_assignment, live offer, no active vehicle with seats ≥ seatsNeeded.
```

```ts
// assignment.repository.ts — DriverAssignmentRepository  (THE guard API; solo and pool claims both call it)
acquire(tx: DrizzleTx, p: { driverId: string; trip: TripRef; offerId: string | null; generation: number }):
  Promise<{ ok: true } | { ok: false; reason: 'driver_busy' | 'trip_taken' }>;
  // savepoint-wrapped INSERT; maps AssignmentDriverBusy → driver_busy,
  // AssignmentSoloTaken/AssignmentSharedTaken → trip_taken.
release(tx: DbExecutor, p: { driverId: string; trip: TripRef }): Promise<boolean>;
  // DELETE … WHERE driver_id=$d AND <solo_ride_id|shared_ride_id>=$trip. false ⇒ nothing matched
  // (never deletes another trip's guard).
findByDriver(db: DbExecutor, driverId: string): Promise<AssignmentRow | null>;
findByTrip(db: DbExecutor, trip: TripRef): Promise<AssignmentRow | null>;
listAll(db: DbExecutor): Promise<AssignmentRow[]>;        // reconcile
lockSoloTrip(tx: DrizzleTx, rideId: string): Promise<RideRow | null>;            // FOR UPDATE
lockSharedTrip(tx: DrizzleTx, poolId: string): Promise<SharedTripLockRow | null>; // FOR UPDATE
claimSoloRow(tx, rideId, driverId, generation): Promise<RideRow>;   // status requested→accepted, driver_id, accepted_at
claimSharedRow(tx, poolId, driverId, generation): Promise<void>;     // claimed_by_driver_id, claimed_at
abortUnclaimedPool(tx, poolId, generation): Promise<boolean>;        // closed_full|closed_timeout & unclaimed & gen → 'aborted'
```

DispatchService public surface. B and the gateway depend on it:

```ts
acceptOffer(input: { offerId: string; driverId: string }): Promise<AcceptOfferResult>;
declineOffer(input: { offerId: string; driverId: string }): Promise<DeclineOfferResult>;
runSoloWave(ride: RideRow, waveNumber: 1 | 2, generation: number): Promise<void>;     // B calls (wave 1)
runPoolWave(pool: SharedRideRow, waveNumber: 1 | 2, generation: number): Promise<void>; // B calls (wave 1)
handleWaveTimeout(job: Job<WaveTimeoutJob>): Promise<void>;  // WaveTimeoutJob += generation?: number
handleHardFail(job: Job<HardFailJob>): Promise<void>;        // HardFailJob += generation?: number
releaseDispatch(rideId: string): Promise<void>;              // post-commit cleanup only
```

`runSoloWave` and `runPoolWave` **throw** on infrastructure failure (Postgres, Redis geo, queue.add) so that B's job retries. They are idempotent within a generation: the offer UNIQUE constraints skip drivers who were already offered, and the timer job IDs are deterministic per generation. When wave 1 runs it adds `dispatch-wave2-<id>-g<g>` (delay `DISPATCH_WAVE_ONE_TIMEOUT_MS`) and `dispatch-hardfail-<id>-g<g>` (delay `DISPATCH_HARD_FAIL_MS`). **Do not change these values or defaults** (flag F-1). Pool stops come from `ride_stops` (Postgres), and `passengerCount` is `seat_count`.

### 2.3 Transaction boundaries

**acceptOffer** is one transaction:
1. `findForDriver` runs without a lock. A missing offer or a different driver both return `offer_not_found`.
2. Lock the trip (`lockSoloTrip` / `lockSharedTrip`).
3. `lockForUpdate(offer)`.
4. If `state='accepted'` and `findByTrip` returns this driver at the same generation, return `{ok:true, replay:true}`. This replay check runs **before** the expiry rules. If the offer is accepted but the guard is gone (the trip was later completed or cancelled), return `trip_not_claimable` and **never recreate the assignment**.
5. `state ≠ 'offered'` returns `offer_<state>`.
6. `expires_at <= now()`: set state='expired', **commit**, and return `offer_expired`.
7. A generation mismatch returns `offer_stale`.
8. Trip state:
   - Solo: `status='requested' AND driver_id IS NULL`.
   - Shared: `pool_state IN ('closed_full','closed_timeout') AND claimed_by_driver_id IS NULL`, and `count(ride_stops) = 2*seat_count`, otherwise `itinerary_missing`.
9. Eligibility: an active driver, and an active vehicle with seats ≥ 1 (solo) or ≥ `seat_count` (shared).
10. `assignments.acquire`.
11. `claimSoloRow` or `claimSharedRow`.
12. `markAccepted`.
13. `revokeLiveForTrip(trip, except offer)`.
14. COMMIT.

After commit: the projection writes `current_ride_id`; remove the wave2 and hardfail jobs (both legacy and new IDs); send `ride_offer_accepted` to the winner, `ride_offer_revoked` to the revoked drivers, and `ride_state_changed` (accepted) to the solo ride room. The winner's acknowledgment does not depend on any revoke or delivery succeeding.

**declineOffer** is a single guarded UPDATE (`driver_id` = caller, `state='offered'`).

**Gateway `ride_offer_response`.**
- `offerId` must be a UUID string, and `accept` must be the boolean `true` or `false`. Anything else, including `'false'` and `1`, is rejected. `sharedRideId` is ignored and must not be used to find the trip.
- The handler returns the `AcceptOfferResult` / `DeclineOfferResult` as the Socket.IO ack. Use `emitAsync` and the first listener result, so the realtime→dispatch module cycle stays broken.
- The existing `ride_offer_accepted` and `ride_offer_revoked` emits stay unchanged for the Flutter app.

**markNoDriver (solo hard-fail)** is one transaction: lock the ride, check `status='requested' AND dispatch_generation = job.generation` (job generation missing means current), set `no_driver`, `revokeLiveForTrip`. Notify after commit.

**Pool hard-fail** is one transaction: lock the pool, then `abortUnclaimedPool`, then `revokeLiveForTrip`. The trigger releases the members.

**cancel** (existing transaction): add `revokeLiveForTrip`, and `assignments.release(driverId, trip)` when a driver is bound. The ride row lock serializes cancel with accept, so exactly one legal outcome exists (T21).

**transition → completed**: `assignments.release` in the same transaction.

**Shared confirmStop** becomes one transaction:
1. Lock the pool and check `claimed_by_driver_id = driver`.
2. Confirm the stop. The first pickup sets `closed_started`.
3. When `pending = 0`: set `pool_state='completed'`, `completed_at`, and `assignments.release`.

A duplicate confirmation returns the authoritative current state (`{ok:true, …, rideCompleted}` for an already-confirmed final stop), not an error that leaves the client hanging (T32).

### 2.4 Redis (A)

- **Deleted keys/usages:** `claim:ride:*`, `offer:<id>`, `offer:meta:*`, `offer:type:*`, `offer:list:*`, `ride:<id>:offered`, `pool:<id>:offered`, `pool:<id>:stops`, and `pool_claim.lua`. Nothing reads them after this slice.
- **Projection `driver:state:<d>.current_ride_id`.** Written after commit. Cleared with an inline compare-and-delete EVAL (`HDEL` only if the value equals the trip being released). The projection never creates the `driver:state` hash: the presence sweep owns its existence, so use EVAL `if EXISTS then HSET`.
- **Reconcile** (`DriverAssignmentProjection.reconcile()`) runs on `OnApplicationBootstrap` and every 30 s (`@Interval`, gated off when `RCAB_DISABLE_BULL_AUTORUN=1` and exposed for tests). For each guard row, set the projection. For each `driver:state:*` whose `current_ride_id` has no matching guard, run HDEL. Also call `offers.expireLapsed()` here.
- Candidate selection still reads the `active_drivers` geo index, which is advisory. `eligibleCandidates` is the filter, and the accept transaction remains the authority.

### 2.5 Tests A must add (independent connections)

- T18: wrong-driver, expired (backdate `expires_at`), forged (random UUID), declined, revoked and old-generation offers produce no assignment and an explicit result. A non-boolean `accept` is rejected at the gateway.
- T19: two drivers accept one trip on two connections. Exactly one wins, and the loser gets `trip_taken`.
- T20: one driver accepts a solo offer and a shared offer concurrently. Exactly one guard row exists, and the other attempt gets `driver_busy`.
- T21: accept races client cancel and hard-fail. Exactly one legal state results, with no surviving guard on a terminal trip.
- T22: a shared accept with no ride_stops returns `itinerary_missing`, and no guard is created.
- Replay: the same accept twice returns `replay:true`. An accept after completion returns `trip_not_claimable`, and the assignment is not recreated.
- Completion of trip X never clears the projection or guard of trip Y.

---

## 3. Slice B: outbox and durable dispatch (R07; F08; tests T14 (server), T17, T23–T26)

### 3.1 Files B owns

| File | Scope |
|---|---|
| `apps/api/src/modules/outbox/outbox.types.ts`, `outbox.writer.ts` | whole (already landed; keep the signatures stable) |
| NEW `apps/api/src/modules/outbox/outbox.repository.ts` | whole: lease / ack / fail / rearm |
| NEW `apps/api/src/modules/outbox/outbox.relay.ts` | whole: poller + `kick()` + `drainOnce()` |
| NEW `apps/api/src/modules/outbox/outbox.module.ts` | whole (registers queues `dispatch`, `scheduled-dispatch`, `matching` for publishing) |
| NEW `apps/api/src/modules/outbox/dispatch-reconciler.service.ts` | whole |
| NEW `apps/api/src/modules/dispatch/dispatch-start.service.ts` | whole |
| NEW `apps/api/src/modules/dispatch/dispatch-runner.module.ts` | whole (imports DispatchModule + ScheduledModule + OutboxModule; provides DispatchStartService, ScheduledDispatchProcessor, reconciler) |
| `apps/api/src/modules/dispatch/dispatch.processor.ts` | whole |
| `apps/api/src/modules/dispatch/dispatch.service.ts` | only: delete `onRideRequested`, `dispatchSolo`, `dispatchPool`, `onPoolClosed`, `RIDE_REQUESTED_EVENT`, `RideRequestedEventPayload` (their logic moves to DispatchStartService). Do not touch the constructor; A removes deps that become unused. |
| `apps/api/src/modules/scheduled/*` | whole (the processor registration moves to the runner module, which breaks the cycle without events) |
| `apps/api/src/modules/rides/rides.controller.ts` | only `createNormal`, `createScheduled`, `replaySolo`, `soloResponse`, the scheduled-wake tail of `cancel`, the **constructor**, and the imports they need |
| `apps/api/src/modules/rides/rides.repository.ts` | only `create`, `findByIdempotencyScope` |
| `apps/api/src/app.module.ts` | add `OutboxModule`, `DispatchRunnerModule` |
| `apps/api/test/setup.int.ts` | add `RCAB_DISABLE_OUTBOX_RELAY=1` |
| Tests | `scheduled.*.spec.ts`, `rides.controller.spec.ts` (`describe` blocks for normal/scheduled create + cancel), `rides.idempotency.spec.ts` (solo/scheduled cases), `test/integration/scheduled-dispatch.int.spec.ts`, `rides-idempotency.int.spec.ts` (all blocks except A's cancel race and C's `findRecentPoolMembership`); in `dispatch-pool.int.spec.ts` only "pool.closed event triggers dispatchPool…" and "scheduled wake → … end-to-end" (move them to a new `test/integration/outbox-dispatch.int.spec.ts`); NEW outbox/reconciler int specs. |

B must not touch: offer, assignment or claim code, pool membership, `pool-lifecycle.service.ts` (C writes its own outbox rows), `ride-state-machine.service.ts`, or migrations.

### 3.2 Topics → publication (the relay's mapping)

| Topic | Written by (same txn as) | aggregate / gen | Relay publishes | Consumer |
|---|---|---|---|---|
| `ride.dispatch.requested` | B: `rides.repository.create` for a **normal** ride (gen 1) | ride / 1 | queue `dispatch`, job `dispatch:start`, data `{kind:'solo', tripId, generation}`, jobId `dispatch-start-<id>-g<g>`, attempts 5, exponential backoff 1 s | `DispatchProcessor` → `DispatchStartService.startSolo` |
| `ride.wake.schedule` | B: `create` for a **scheduled** ride (ride gen 0, outbox gen 1, payload `{scheduledFor}`) | ride / 1 | queue `scheduled-dispatch`, job `scheduled:wake`, data `{rideId, generation}`, jobId `scheduled-wake-<id>-g<g>`, delay `max(0, scheduledFor − SCHEDULED_WAKE_LEAD_MS − now)` computed at publish | `ScheduledDispatchProcessor` |
| `pool.expire.schedule` | C: openPool (gen 0, payload `{expireAt}`) | shared_ride / 0 | queue `matching`, job `pool:expire`, data `{rideId}`, jobId `pool-expire-<id>`, delay `max(0, expireAt − now)` | C's `PoolExpireProcessor` |
| `pool.dispatch.requested` | C: pool close (closed_full/closed_timeout) bumps gen → 1 | shared_ride / 1 | queue `dispatch`, job `dispatch:start`, data `{kind:'pool', tripId, generation}`, jobId `dispatch-start-<id>-g<g>` | `DispatchStartService.startPool` |

An unknown topic is acked as failed (`failed_at`) with `last_error='unknown_topic'`, logged at error level, and never retried in a loop.

### 3.3 Signatures

```ts
// outbox.repository.ts — OutboxRepository
lease(limit: number, leaseMs: number): Promise<LeasedOutboxRow[]>;
  // ONE short txn:
  // UPDATE outbox SET lease_token=gen_random_uuid(), leased_until=now()+$lease, attempts=attempts+1, updated_at=now()
  //  WHERE id IN (SELECT id FROM outbox
  //                WHERE processed_at IS NULL AND failed_at IS NULL AND available_at <= now()
  //                  AND (leased_until IS NULL OR leased_until < now())
  //                ORDER BY available_at LIMIT $n FOR UPDATE SKIP LOCKED)
  //  RETURNING *;
ack(id: string, leaseToken: string): Promise<boolean>;   // SET processed_at=now(), lease_token=NULL, leased_until=NULL WHERE id AND lease_token=$t
fail(id: string, leaseToken: string, error: string): Promise<'retry' | 'exhausted' | 'lost_lease'>;
  // available_at = now() + least(2^attempts, 300) s; failed_at=now() when attempts >= max_attempts; clears lease; fenced by token
rearm(where: { topic: OutboxTopicName; aggregateId: string; generation: number }): Promise<boolean>;
  // processed_at=NULL, failed_at=NULL, attempts=0, available_at=now(), lease cleared — reconciler / operator retry
stats(): Promise<{ pending: number; oldestPendingAgeS: number | null; exhausted: number }>; // metrics/health

// outbox.relay.ts — OutboxRelay
drainOnce(): Promise<{ published: number; failed: number }>; // lease → publish each → ack/fail
kick(): void;                                                // schedule an immediate drain (debounced)
// @Interval 1000 ms unless RCAB_DISABLE_OUTBOX_RELAY=1. Batch 50, lease 30 s.

// dispatch-start.service.ts — DispatchStartService
startSolo(rideId: string, generation: number): Promise<'started' | 'stale'>;
  // read ride; stale unless status='requested' AND dispatch_generation=generation;
  // else await dispatch.runSoloWave(ride, 1, generation) — errors propagate (job retries).
startPool(poolId: string, generation: number): Promise<'started' | 'stale'>;
  // stale unless pool_state IN (closed_full, closed_timeout) AND claimed_by IS NULL AND gen matches.
wakeScheduled(rideId: string, generation: number): Promise<'started' | 'stale'>;
  // txn: UPDATE rides SET dispatch_generation=$g, updated_at=now()
  //       WHERE id=$id AND type='scheduled' AND status='requested' AND dispatch_generation IN ($g-1, $g)
  //      RETURNING *  → none ⇒ 'stale' (cancelled / already woken further)
  // then await startSolo(rideId, g). Job completes only after wave 1 offers + timers exist.

// rides.repository.ts (B)
create(params: …existing… ): Promise<{ row: RideRow; created: boolean; requestFingerprint: string | null }>;
  // ONE txn: INSERT ride (normal: dispatch_generation=1; scheduled: 0) ON CONFLICT scope DO NOTHING;
  // if inserted → enqueueOutbox(tx, ride.dispatch.requested g1 | ride.wake.schedule g1 {scheduledFor}).
  // A replay (conflict) writes no outbox row — the original intent committed with the original row.
```

The controller (B) calls `relay.kick()` after `create` returns `created: true`, then joins the ride room. It **does not emit `ride.requested`** and **does not call `scheduleWake`**. The cancel path keeps a best-effort removal of the scheduled wake (`scheduled-wake-<id>-g1` and the legacy `scheduled:wake:<id>`) after commit. The wake worker's status guard is the real protection.

`DispatchProcessor.process`: `dispatch:start` → `startSolo` / `startPool`; `dispatch:wave-timeout` / `dispatch:hard-fail` → A's handlers (unchanged delegation). Errors propagate. Do **not** catch and log in a way that completes the job. `ScheduledDispatchProcessor.process`: `scheduled:wake` → `wakeScheduled(rideId, data.generation ?? 1)`.

### 3.4 Reconciliation (B), on `OnApplicationBootstrap` and every 5 min

Postgres is the authority. A "published" outbox row is not proof that its job still exists.

1. **Un-woken scheduled rides.** `type='scheduled' AND status='requested' AND dispatch_generation=0`. If `queue.getJob('scheduled-wake-<id>-g1')` and the legacy `scheduled:wake:<id>` are both missing, run `rearm(ride.wake.schedule, id, 1)`, or `enqueueOutbox` if no row exists.
2. **In-flight solo dispatch.** `status='requested' AND dispatch_generation ≥ 1`. If the gen has no `dispatch_offer` rows and no `dispatch-start` job, re-arm `ride.dispatch.requested` (gen). If offers exist but the `dispatch-hardfail-<id>-g<g>` (or legacy) job is missing, re-add it with delay `max(0, min(offered_at) + DISPATCH_HARD_FAIL_MS − now)`. If wave 2 is missing and the wave-1 timeout has not passed, re-add it. The handlers are A's, so add jobs with A's data shape.
3. **Pools.** For `open` pools with no `pool-expire-<id>` / legacy job, `rearm(pool.expire.schedule, id, 0)`. If the row is missing, enqueue it with `expireAt = pool_closed_at`, which openPool sets to the planned close time. For `closed_full|closed_timeout` pools that are unclaimed with gen ≥ 1, apply the same rule as step 2, using shared offers.
4. **Metrics/logs.** Report `stats()` (oldest pending age, exhausted count). Exhausted rows are not retried automatically. An operator re-arms them.

B tests: T23 (inject failure before and after commit, before and after publish, and before ack; the required work is recovered with no duplicate business result), T24 (worker killed or throws after the wave-1 commit; redelivery is safe; an old-generation job is a no-op), T25 (flush Redis with future scheduled rides; reconcile restores the wake jobs), T26 (cancel at the wake boundary, and a late worker, produce no post-cancel dispatch), T17 (Redis cleared, then a scheduled replay of an old commit still returns the ride, and a wake row exists).

---

## 4. Slice C: pool membership, capacity, closure (R08; F09, F15-part; tests T27–T29, T22-closure side)

### 4.1 Files C owns

| File | Scope |
|---|---|
| NEW `apps/api/src/modules/matching/pool-membership.repository.ts` | whole |
| NEW `apps/api/src/modules/matching/itinerary.ts` | whole: move `computeStops` and its pure helpers here from `dispatch.service.ts` |
| NEW `apps/api/src/modules/matching/pool-projection.service.ts` | whole: Redis pool hash projection + rebuild |
| `apps/api/src/modules/matching/pool-lifecycle.service.ts` | whole |
| `apps/api/src/modules/matching/shared-ride.repository.ts` | everything **except** `setClaimed` (A) |
| `apps/api/src/modules/matching/matching.service.ts`, `matching.module.ts`, `pool-expire.processor.ts` | whole |
| `apps/api/src/modules/matching/lua/pool_slot.lua` | delete; also the `pool_slot.lua` entry in `scripts/copy-assets.mjs` / `check-artifact.mjs` |
| `apps/api/src/modules/dispatch/dispatch.service.ts` | only the pure-helper section (`computeStops` … `orderDropoffsNearestNeighbour`): replace it with `export { computeStops } from '../matching/itinerary';` |
| `apps/api/src/modules/rides/rides.controller.ts` | only `createShared`, `completeClaim`, `existingSharedSeat`, `allocateSharedSeat`, `priceMatchedSeat` (no constructor changes; ask B if you need one) |
| `apps/api/src/modules/rides/rides.repository.ts` | only `findRecentPoolMembership` / `PoolMembershipRow` (replace with an exact lookup or delete) |
| `apps/api/src/modules/rides/idempotency.repository.ts` | may add `DbExecutor`-taking variants of `complete`/`release` |
| Tests | `pool-lifecycle.service.spec.ts`, `matching.service.spec.ts`, `test/integration/pool-lifecycle.int.spec.ts`, `matching-service.int.spec.ts`; in `dispatch-pool.int.spec.ts` only "concurrent slotRequest…" (move it to NEW `test/integration/pool-membership.int.spec.ts`); in `rides-idempotency.int.spec.ts` the `findRecentPoolMembership` block; `rides.controller.spec.ts` / `rides.idempotency.spec.ts` shared-create blocks only. |

C must not touch: claim, accept and offer code, `ride-stop.repository.ts` (C inserts `ride_stops` through its own repository), pool transitions after close (`closed_started`, `completed`, `aborted` all belong to A), the outbox relay, or migrations.

### 4.2 Signatures

```ts
// pool-membership.repository.ts — PoolMembershipRepository
lockPool(tx: DrizzleTx, poolId: string): Promise<PoolLockRow | null>;  // SELECT … FOR UPDATE (state, seat_count, max_seats, gen, version)
insertMember(tx: DrizzleTx, m: { poolId: string; passengerId: string; origin…; dest…;
  quotedFareCents: number | null; idempotencyKey: string | null }):
  Promise<{ ok: true; seatCount: number } | { ok: false; reason:
    'already_member' | 'passenger_has_active_pool' | 'pool_full' | 'pool_closed' | 'idempotent_replay' }>;
  // savepoint-wrapped; maps Constraint.PoolMemberDuplicate / PoolMemberOneActivePool /
  // PoolCapacity / PoolNotOpen / PoolMemberIdempotency. seatCount read back post-trigger.
listMembers(db: DbExecutor, poolId: string): Promise<SharedRideMember[]>; // ORDER BY joined_at, passenger_id
findByIdempotencyKey(db: DbExecutor, passengerId: string, key: string): Promise<{ poolId: string; poolState: string; opened: boolean } | null>;
findActiveForPassenger(db: DbExecutor, passengerId: string): Promise<{ poolId: string; poolState: string } | null>;
insertItinerary(tx: DrizzleTx, poolId: string, stops: OfferStop[]): Promise<void>; // INSERT ride_stops (no ON CONFLICT DO NOTHING: a conflict is a bug)

// pool-lifecycle.service.ts — PoolLifecycleService
openPool(p: OpenPoolParams & { quotedFareCents: number | null; idempotency?: IdempotencyScope }): Promise<SharedRideRow>;
  // ONE txn: INSERT shared_rides (seat_count 0, pool_state 'open', pool_closed_at = now()+MATCHING_POOL_TIMEOUT_MS,
  //   dispatch_generation 0, members '[]') → insertMember(opener) → enqueueOutbox(pool.expire.schedule g0 {expireAt})
  //   → idempotency complete (if scope). After commit: project, joinPool, emit pool:update.
joinPool(p: { poolId: string; joiner: SharedRideMember; quotedFareCents: number | null; idempotency?: IdempotencyScope }):
  Promise<{ joined: true; closedFull: boolean; seatCount: number } | { joined: false; reason: string }>;
  // ONE txn: lockPool → state 'open' & seat_count < max_seats (fast-fail) → insertMember →
  //   if seatCount == max_seats: closeInTxn(tx, pool, 'closed_full') → idempotency complete → COMMIT.
  //   After commit: project, joinPool socket, emit pool:update.
closeIfOpen(poolId: string, reason: 'closed_timeout'): Promise<'closed' | 'not_open'>;  // expiry processor; stale timeout is a no-op
private closeInTxn(tx, pool, reason: 'closed_full' | 'closed_timeout'): Promise<number /* new generation */>;
  // guarded UPDATE … SET pool_state=$reason, pool_closed_at=now(), dispatch_generation=dispatch_generation+1
  //   WHERE ride_id=$id AND pool_state='open' RETURNING dispatch_generation;
  // stops = computeStops({...pool, members: listMembers(tx)}) → insertItinerary;
  // enqueueOutbox(pool.dispatch.requested, gen, {poolId, reason}).
```

`MatchingService.findOrCreatePool` keeps scoring candidates (OSRM, outside any transaction) as advisory work. It then tries `joinPool` on each candidate in order. When a candidate returns `pool_full`/`pool_closed`, it moves to the next one. When it gets `already_member`/`idempotent_replay`, it returns that pool. On `passenger_has_active_pool` it returns a typed conflict: the controller maps that to 409 `passenger_has_active_pool`, and returns the existing pool instead when it is the same request's idempotent replay. If no candidate accepts, it calls `openPool`.

`SharedRideRepository.findById` and `findCandidates` derive `members` from `pool_member` (`json_agg … ORDER BY joined_at, passenger_id`, with keys shaped like `SharedRideMember`), so `SharedRideRow.members` keeps its shape for A. `incrementSeats`, `appendMember` and `closePool` are deleted. Writing `seat_count` or `members` becomes illegal.

Shared-create idempotency (closes the Stage-B `TODO(R08)`): the claim stays as it is today, pending before allocation. **`complete` moves into the join/open transaction**, and the seat stores `idempotency_key`. A reclaimed stale claim calls `findByIdempotencyKey` (exact) instead of `findRecentPoolMembership` (passenger + time heuristic). The shared fare quote is computed **before** the transaction (OSRM) and stored in `quoted_fare_cents`. The final fare policy is not decided here (F15).

### 4.3 Redis (C)

- **Deleted:** `pool:<id>:seats` and `pool_slot.lua`.
- **`pool:<id>` hash.** A projection `{state, seat_count, max_seats, version, claimed_by?}`, written after commit by an inline compare-version EVAL (write only if the stored `version` < the incoming `state_version`), with a 600 s TTL as today.
- **`PoolProjectionService`:**
  - `project(poolId)` re-reads Postgres and writes the hash.
  - `rebuildAll()` runs on `OnApplicationBootstrap` for every non-terminal pool.
  - A may call `project(poolId)` after a claim. That call is best effort and optional.
- **`pool:update` socket payloads** come from the committed row, not from Redis.

C tests:
- T27: N+2 joiners on independent connections against a pool with N free seats. Afterwards `seat_count = count(pool_member) ≤ max_seats`, every passenger appears once, there is exactly one `pool.dispatch.requested` outbox row, and `ride_stops` has `2*seat_count` rows.
- T28: join races timeout. A closed pool rejects a stale join, there is one closure, and there is one dispatch intent.
- T29: the same passenger submits a duplicate shared request with the same key and gets one seat. With different keys, they get `passenger_has_active_pool`.
- A stale `closeIfOpen` on a closed or started pool is a no-op.

---

## 5. Ownership matrix (shared files only; any file not listed is owned by the slice that creates it)

| Shared file | A (offers-assignment) | B (outbox) | C (pool) |
|---|---|---|---|
| `dispatch/dispatch.service.ts` | constructor + all dispatch/claim/offer/timer methods (§2.1) | delete `onRideRequested`, `dispatchSolo`, `dispatchPool`, `onPoolClosed`, `RIDE_REQUESTED_EVENT`, `RideRequestedEventPayload` | pure-helper section → re-export from `matching/itinerary.ts` |
| `rides/rides.controller.ts` | none | constructor, `createNormal`, `createScheduled`, `replaySolo`, `soloResponse`, cancel's wake tail | `createShared`, `completeClaim`, `existingSharedSeat`, `allocateSharedSeat`, `priceMatchedSeat` |
| `rides/rides.repository.ts` | `RideRow`, `toRow`, `claimSolo`, `markNoDriver`, `transition`, `cancel` | `create`, `findByIdempotencyScope` | `findRecentPoolMembership`, `PoolMembershipRow` |
| `matching/shared-ride.repository.ts` | `setClaimed` | none | everything else |
| `realtime/realtime.gateway.ts` | `handleRideOfferResponse` + its payload/event types | none | none |
| `scripts/copy-assets.mjs`, `check-artifact.mjs` | `pool_claim.lua` entry | none | `pool_slot.lua` entry |
| `test/integration/dispatch-pool.int.spec.ts` | setup + 6 claim/fan-out/hard-fail blocks | 2 blocks, move out | 1 block, move out |
| `test/integration/rides-idempotency.int.spec.ts` | cancel-race block | create/scheduled/scope blocks | `findRecentPoolMembership` block |
| `rides.controller.spec.ts`, `rides.idempotency.spec.ts` | none | solo/scheduled/cancel blocks | shared-create blocks |

Inside a shared file, keep your diff within the functions or blocks you own. If you must touch an import line, add or remove only your own symbols.

---

## 6. Invariant SQL (audit/reconcile queries; all must return zero rows)

```sql
-- I1  guard ⇔ active solo ride
SELECT r.id FROM rides r
 WHERE r.status IN ('accepted','en_route','arrived','in_progress')
   AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a
                    WHERE a.solo_ride_id = r.id AND a.driver_id = r.driver_id)
UNION ALL
SELECT a.solo_ride_id FROM driver_active_assignment a JOIN rides r ON r.id = a.solo_ride_id
 WHERE r.status NOT IN ('accepted','en_route','arrived','in_progress') OR r.driver_id <> a.driver_id;

-- I2  guard ⇔ claimed non-terminal pool
SELECT s.ride_id FROM shared_rides s
 WHERE s.claimed_by_driver_id IS NOT NULL
   AND s.pool_state IN ('closed_full','closed_timeout','closed_started')
   AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a
                    WHERE a.shared_ride_id = s.ride_id AND a.driver_id = s.claimed_by_driver_id)
UNION ALL
SELECT a.shared_ride_id FROM driver_active_assignment a JOIN shared_rides s ON s.ride_id = a.shared_ride_id
 WHERE s.pool_state IN ('open','aborted','completed') OR s.claimed_by_driver_id IS DISTINCT FROM a.driver_id;

-- I3  an accepted offer is the trip's current assignment (or the trip has moved past it)
SELECT o.id FROM dispatch_offer o
 WHERE o.state = 'accepted'
   AND NOT EXISTS (SELECT 1 FROM driver_active_assignment a WHERE a.offer_id = o.id)
   AND EXISTS (SELECT 1 FROM rides r WHERE r.id = o.ride_id
                 AND r.status IN ('accepted','en_route','arrived','in_progress'));

-- I4  no live offer on a non-claimable trip
SELECT o.id FROM dispatch_offer o LEFT JOIN rides r ON r.id = o.ride_id
  LEFT JOIN shared_rides s ON s.ride_id = o.shared_ride_id
 WHERE o.state = 'offered'
   AND ((r.id IS NOT NULL AND (r.status <> 'requested' OR r.dispatch_generation <> o.dispatch_generation))
     OR (s.ride_id IS NOT NULL AND (s.claimed_by_driver_id IS NOT NULL
                                    OR s.pool_state NOT IN ('closed_full','closed_timeout')
                                    OR s.dispatch_generation <> o.dispatch_generation)));

-- I5  seat_count is derived and within capacity (also enforced by trigger + CHECK)
SELECT s.ride_id FROM shared_rides s
 WHERE s.seat_count <> (SELECT COALESCE(sum(m.seats),0) FROM pool_member m WHERE m.pool_id = s.ride_id)
    OR s.seat_count > s.max_seats;

-- I6  membership active flag matches pool state
SELECT m.pool_id, m.passenger_id FROM pool_member m JOIN shared_rides s ON s.ride_id = m.pool_id
 WHERE m.active = (s.pool_state IN ('aborted','completed'));
-- (rows already listed in migration_conflict kind passenger_multiple_active_pools are expected until resolved)

-- I7  a closed (dispatched) pool has an itinerary and a dispatch intent
SELECT s.ride_id FROM shared_rides s
 WHERE s.pool_state IN ('closed_full','closed_timeout') AND s.dispatch_generation >= 1
   AND (NOT EXISTS (SELECT 1 FROM ride_stops t WHERE t.ride_id = s.ride_id)
        OR NOT EXISTS (SELECT 1 FROM outbox o WHERE o.topic = 'pool.dispatch.requested'
                         AND o.aggregate_id = s.ride_id AND o.aggregate_generation = s.dispatch_generation));

-- I8  every committed normal booking has its dispatch intent; every un-woken scheduled ride its wake
SELECT r.id FROM rides r
 WHERE (r.type = 'normal' AND r.dispatch_generation >= 1 AND NOT EXISTS (
          SELECT 1 FROM outbox o WHERE o.topic = 'ride.dispatch.requested' AND o.aggregate_id = r.id))
    OR (r.type = 'scheduled' AND r.status = 'requested' AND r.dispatch_generation = 0 AND NOT EXISTS (
          SELECT 1 FROM outbox o WHERE o.topic = 'ride.wake.schedule' AND o.aggregate_id = r.id));
-- (normal rides created before 0015 are exempt: filter created_at >= the 0015 ran_at)

-- I9  outbox health
SELECT id FROM outbox WHERE failed_at IS NOT NULL;                                    -- exhausted → operator
SELECT id FROM outbox WHERE processed_at IS NULL AND available_at < now() - interval '5 minutes';
```

A owns I1–I4, B owns I8–I9, and C owns I5–I7. Each owner adds its queries as assertions in its integration tests, after the race and fault scenarios have run.

---

## 7. Redis keys after Stage C

| Key | Status | Owner | Rebuilt from |
|---|---|---|---|
| `active_drivers` (geo), `driver:state:<d>` presence | unchanged, advisory | (presence) | driver heartbeats |
| `driver:state:<d>.current_ride_id` | projection | A | `driver_active_assignment` (boot + 30 s) |
| `claim:ride:*`, `offer:*`, `offer:meta:*`, `offer:type:*`, `offer:list:*`, `ride:*:offered`, `pool:*:offered`, `pool:*:stops` | **removed** | A | (none, Postgres is the authority) |
| `pool:<id>` hash | projection (versioned) | C | `shared_rides` + `pool_member` (boot) |
| `pool:<id>:seats` | **removed** | C | (none) |
| `bull:dispatch:*`, `bull:scheduled-dispatch:*`, `bull:matching:*` | work queues | B (publication), A (timers), C (expiry consumer) | outbox + reconciler §3.4 |
| `refresh`/idempotency | unchanged (Postgres since Stage B) | none | none |

---

## 8. Sequencing and integration

- The slices can be implemented in parallel against this contract. Merge them in the order **C → A → B**:
  - C writes closure stops and outbox rows (it needs only `enqueueOutbox`, which has already landed).
  - A's accept needs C's stops to be present at closure.
  - B wires the relay and the start service onto A's `runSoloWave`/`runPoolWave` and C's topics, and owns the end-to-end tests.
- Until B merges, no outbox row is published. Between C and B, pools do not dispatch end-to-end. That is expected. Each slice's tests assert its own durable effects: rows, guards and outbox rows. They do not assert the cross-slice flow.
- After all three merge, run `pnpm verify`, the full `test:int`, and the §6 invariants against a DB the suites have exercised. Fix any interface mismatch in the slice that owns the callee.

## 9. Flags for the owner (no action in Stage C)

- **F-1 (escalation window).** The scheduled-booking feature note specifies a **4-minute** accept/escalation window after wake. The reused normal path hard-fails at **60 s** (`DISPATCH_HARD_FAIL_MS`, with the wave-2 timeout at 30 s). **Resolved: the owner chose 4 minutes.** Scheduled rides now use `SCHEDULED_DISPATCH_WINDOW_MS=240000` (wave one `SCHEDULED_DISPATCH_WAVE_ONE_MS`, default half); unanswered scheduled rides are re-armed with no cap. Normal rides keep 30 s / 60 s, and the wake stays at T−10 min. (Original text: Stage C kept both values pending a decision.)
- **F-2 (vehicle capacity).** Eligibility now requires an active `vehicle` with `seats ≥` the seats the trip needs. A driver with no active vehicle row stops receiving offers. Dev seeds already create vehicles. Pilot onboarding must create them too.
- **F-3 (migration inventory).** Before the first deploy of 0014/0016 to any DB that holds real data, review `SELECT * FROM migration_conflict WHERE resolved_at IS NULL`. Trips listed there have **no** driver guard until an operator resolves them. Never auto-cancel them.
- **F-4 (deprecated column).** `shared_rides.members` jsonb is deprecated and no longer written. Drop it in a later migration, once no reader remains (`pool-inspect`/`redis-inspect` skills and docs).
- **F-5 (still open owner decisions).** Shared final fare (F15), member cancellation and no-show in pools, pool fallback to solo, and early driver assignment for scheduled trips.
