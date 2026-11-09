# Onboarding guide: backend developer

You own `apps/api` (NestJS 10), the Postgres schema and migrations, the realtime protocol, and the
shared packages (`packages/shared`, `packages/api-client`, `packages/test-fixtures`). The server is
the single source of truth for rides, pools, offers, driver assignment and sessions. Clients render
what you decide.

Back to the [onboarding index](../README.md). Facts were checked against the code on branch
`onboarding/walkthrough`; where a vault note disagrees with the code, the code wins (and you should
fix the note).

---

## 1. Day-1 / week-1 checklist

### Day 1: run it

1. Read [`CLAUDE.md`](../../../CLAUDE.md), then [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) end to
   end (it is the code-verified reference), then skim [`docs/POLICY.md`](../../POLICY.md) (every
   business number).
2. Toolchain: Docker Desktop, Node 20+, pnpm 10.
3. Start the stack and verify it:

   ```bash
   pnpm install
   pnpm dev:up && pnpm dev:smoke
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts
   curl -s localhost:3000/v1/health/ready | jq        # postgres, redis, osrm
   curl -s localhost:3000/v1/health/version | jq      # {"version":"dev",...} locally
   ```

   Host ports: api 3000, web 3002, postgres **55432** (not 5432), redis 6379. OSRM, Loki and
   Alertmanager have **no** host port; reach OSRM with
   `docker compose ... exec -T api sh -c 'curl http://osrm:5000/route/v1/driving/91.7362,26.1445;91.7898,26.1758'`.
4. Seed fixtures if you need drivers around: `./scripts/seed-dev.sh --keepalive` (drivers are swept
   offline after 60 s without a heartbeat). Seeded users cannot sign in through Firebase; for curl-only
   work put a valid test ID token in `FIREBASE_PHONE_TEST_TOKEN` and use
   `POST /v1/auth/firebase-exchange`.
5. Watch the web and driver videos (W03, W07, D04, D06) to see which API calls and events the flows
   produce: [`../videos/web/INDEX.md`](../videos/web/INDEX.md),
   [`../videos/driver/INDEX.md`](../videos/driver/INDEX.md).

### Week 1: first test run, first change

| Step | Command | Notes |
|---|---|---|
| Unit tests | `pnpm --filter @rcab/api test` | vitest + SWC; offline-safe (`RCAB_DISABLE_*` env set in `vitest.config.ts`) |
| One file | `pnpm --filter @rcab/api test -- src/foo.spec.ts` | |
| One test | `pnpm --filter @rcab/api test -- -t "name"` | |
| Coverage gate | `pnpm --filter @rcab/api test:cov` | floors: statements 75, branches 85, functions 70, lines 75 |
| Integration | `pnpm --filter @rcab/api test:int` | Testcontainers: real postgis 16 + redis 7. Needs Docker. |
| Typecheck, lint | `pnpm --filter @rcab/api typecheck` and `pnpm --filter @rcab/api lint` | |
| Whole gate | `pnpm verify` | `lint + policy:doc:check + api test:cov + test:int` |

First small change (suggested): add a read-only field to an existing response (for example expose one
extra column on `GET /v1/rides/:id`), update the DTO or mapper, add a unit test, add or extend an
integration assertion in `apps/api/test/integration/`, run `pnpm verify`, and note the new field for the
client owners (`lib/booking/types.ts`, Dart models).

Never use `RCAB_SKIP_INT=1 pnpm test:int` to declare a story green; it only exists for machines without
Docker.

---

## 2. What you own and the mental model

### The shape of the system

```
Controllers (HTTP /v1/*) --+                +-- BullMQ workers (dispatch, scheduled-dispatch, matching)
Gateway (Socket.IO)    ----+--> services --> Postgres (authoritative)  <-- OutboxRelay (leases rows)
                                |           Redis (projection + queues + presence + adapter)
                                +--> OSRM (routing, only outside transactions)
```

Five ideas explain most of the codebase:

1. **Postgres is authoritative; Redis is a rebuildable projection.** Rides, pools, members, offers, the
   driver assignment guard, the outbox and sessions are rows. Redis holds presence (geo index),
   `pool:<id>` hashes, `driver:state:<id>`, BullMQ queues and the Socket.IO adapter. With Redis empty a
   restarted api converges from Postgres alone (proved by the redis-loss drill, see the
   [recovery runbook](../../operations/recovery-runbook.md) section 5).
2. **Business mutations are single transactions with a fixed lock order**, and everything with a network
   effect happens after commit (section 4).
3. **Durable work goes through the transactional outbox.** The same transaction that books a ride writes
   an `outbox` row; a relay publishes it to BullMQ; workers do the work behind state and generation
   guards. A crash at any point is repaired by the reconciler.
4. **Every offer, job and outbox row carries a `dispatch_generation`.** A consumer whose generation is
   not the row's current one does nothing and succeeds. Stale work is not an error.
5. **Business numbers come from one validated policy table**, not from scattered constants or
   `ConfigService` reads (section 5).

### Code map (`apps/api/src`)

| Path | What lives there |
|---|---|
| `main.ts`, `app.module.ts` | Bootstrap (cookie-parser, CORS from `resolveBrowserOrigins()`), module wiring, global `ValidationPipe({whitelist:true, transform:true})`, global `AppExceptionFilter`, throttler, request-id and metrics middleware |
| `config/policy/` | `policy.schema.ts` (the table), `policy.ts` (builder, `getPolicy()`), `policy.module.ts` (global `POLICY` provider), doc generation helpers |
| `common/` | `guards/` (`AuthGuard`, `CsrfGuard`, access-token verification, `auth-config` fail-closed env checks), `filters/`, `middleware/` (`request-id`, `metrics`), `utils/` (`env`, `cookie`) |
| `infra/` | `db/drizzle.module.ts` (`DRIZZLE_DB`, `DrizzleTx`, `DbExecutor`), `redis/redis.module.ts` (`REDIS`), `firebase/`, `google/` |
| `db/` | `schema.ts` (15 tables), `constraints.ts` (named constraints + `pgConstraintViolation`) |
| `metrics.ts` | All Prometheus instruments (catalogue in the [monitoring guide](monitoring-maintenance-dev.md)) |
| `logger.ts` | pino JSON logger; `context.ts` request-scoped id store |
| `migrate.ts` | The migration runner |
| `modules/auth` | Firebase exchange, JWT issue, single-use refresh rotation, native endpoints, Google link/login |
| `modules/vehicles`, `modules/drivers` | Vehicle CRUD; online/offline, presence (geo index), auto-offline sweep (cron from policy) |
| `modules/rides` | Quote token, create (solo/shared/scheduled), state, cancel, idempotency; the controller is the largest file |
| `modules/pricing` | Fares in integer paise (`money.ts`), shared-seat multipliers, `shared-fare-policy.ts` (`'fixed_at_join'` stand-in) |
| `modules/matching` | Route similarity on cached OSRM polylines, slot-vs-open decision, pool lifecycle, `pool_member` repository, Redis projection |
| `modules/dispatch` | Offers, accept/decline, assignment guard, wave timers, `dispatch-start`, BullMQ processors |
| `modules/ride-lifecycle`, `modules/rides/ride-state-machine.service.ts` | Forward transitions with row locking |
| `modules/scheduled` | Scheduled wake jobs and the retry/cutoff logic |
| `modules/outbox` | `outbox.writer` (enqueue), `outbox.repository`, `outbox.relay`, `dispatch-reconciler` |
| `modules/realtime` | Gateway, `RealtimeBus`, protocol constants and versions, snapshot service |
| `modules/rating` | Two-sided rating capture (aggregation is E7.S2, not built) |
| `modules/metrics` | `BusinessMetricsSampler` (state gauges) |
| `modules/health` | `/v1/health/{live,ready,version}`, `/`, `/metrics` |

Shared packages: `packages/shared` (`@rcab/shared`, types and constants used by api and web),
`packages/api-client` (typed client), `packages/test-fixtures` (`runMigrations`, `uniquePhone`,
`uniqueRegNo`; `seedPilotCity` is an empty stub).

To answer "who imports X / where is route Y" without grepping, use the committed code graph
(`/code-graph`, `codegraph/graph.md`). Regenerate with `pnpm code:graph` when `codegraph/.stale` exists;
`pnpm code:graph:check` flags drift between modules and the vault module map.

### Domain facts you will need constantly

- Ride status: `requested, dispatching, accepted, en_route, arrived, in_progress, completed, cancelled,
  no_driver, no_show`. Pool states live on `shared_rides.pool_state` (open, closed_full, closed_timeout,
  closed_started, aborted, completed). Diagrams: [`../state-machines.md`](../state-machines.md).
- Dispatch is event/queue driven and has **no HTTP surface**. Offers are rows (`dispatch_offer`); a driver
  holds at most one active trip because `driver_active_assignment.driver_id` is its primary key.
- Roles: `app_user.role` is `client` or `driver`; controllers check it themselves
  (for example `assertDriver` in `vehicles.controller.ts`). There is no central `RolesGuard` (open item in
  the security checklist).
- Money is integer paise (`Money { amount, currency: 'INR' }`). Never use floats for fares.
- Expiry is decided with the **database clock** (`now()`, `expires_at <= now()`), not `Date.now()`.

---

## 3. Key workflows for this role

Workflow write-ups: [`../workflows/`](../workflows/README.md) (especially [database migrations](../workflows/database-migrations.md), [business-config changes](../workflows/business-config-changes.md), [testing](../workflows/testing.md), [adding a feature end to end](../workflows/adding-a-feature-end-to-end.md), [incident and recovery](../workflows/incident-and-recovery.md)). Per-area behaviour: [`../functionality/`](../functionality/) (for example [auth and sessions](../functionality/auth-and-sessions.md), [quoting and pricing](../functionality/quoting-and-pricing.md), [normal booking](../functionality/normal-booking.md), [realtime protocol](../functionality/realtime-protocol.md)).
State diagrams: [`../state-machines.md`](../state-machines.md). Videos show the observable result of each
flow; watch the matching scene before changing the code behind it.

| Area | Where to read | Watch |
|---|---|---|
| Auth, refresh rotation, native tokens | `modules/auth`, [`ARCHITECTURE.md`](../../ARCHITECTURE.md) section 8, vault `40-backend/module-auth.md` | W02, W10, D01 |
| Quote and create (solo/shared/scheduled), idempotency | `modules/rides/rides.controller.ts`, `idempotency*.ts`, `quote-token.service.ts` | W03, W07, W08 |
| Dispatch: waves, offers, accept races, hard fail | `modules/dispatch`, [`stage-c-contract.md`](../../remediation/stage-c-contract.md) section 2, vault `70-algorithms/algo-top-k-dispatch.md` | W03, W05, W06, D04, D05 |
| Shared pools and itinerary | `modules/matching`, vault `70-algorithms/algo-shared-ride-matching.md`, `algo-route-similarity.md`, `40-backend/module-matching.md` | W07, D06 |
| Scheduled rides | `modules/scheduled`, `modules/outbox`, `docs/POLICY.md` "Scheduled booking" | W08 |
| Cancel, no-show | `rides.repository.ts` cancel path, `ride-state-machine.service.ts` | W04, W05, D07 |
| Realtime subscribe/snapshot/versioning | `modules/realtime`, vault `40-backend/websocket-events.md` | W09 |
| Recovery, drills, `migration_conflict` | [`recovery-runbook.md`](../../operations/recovery-runbook.md) | M06 |

### Add an HTTP endpoint

1. Create or extend a DTO in the module's `dto/` with `class-validator` decorators (`whitelist: true` strips
   unknown fields, `transform: true` coerces types; note `forbidNonWhitelisted` is **not** on, an open item
   in the security checklist).
2. Add the controller method. Use `@UseGuards(AuthGuard)` and assert the role. Browser-cookie routes also
   need `CsrfGuard`. Throw `HttpException` subclasses with `{ code, message }` bodies:
   `AppExceptionFilter` shapes every error as `{ "error": { "code", "message", "request_id" } }`. Codes are a
   stable contract (vault `40-backend/error-codes.md`); add new ones, never repurpose.
3. Put logic in a service/repository, not in the controller. Money is paise, times are UTC.
4. If it creates something a client will wait on, make it idempotent (`Idempotency-Key`, see
   `rides/idempotency.ts`) and write the fingerprint check.
5. Add a unit test next to the code and an integration test under `test/integration/`.
6. Update `docs/ARCHITECTURE.md` section 3, vault `40-backend/rest-endpoints.md`, and the typed client
   (`packages/api-client`). Run `pnpm code:graph` so the graph lists the route.
7. Add rate limits via policy (`rateLimits.*`) rather than hardcoding `@Throttle` numbers where possible.

### Add or change a socket event

1. Constants and payload builders live in `modules/realtime/realtime.protocol.ts`. Add the event name
   there. If it describes mutable state, give it a **version** (pool: `state_version`; ride: status rank) so
   clients can order it.
2. Server to client: emit through `RealtimeBus` (`toUser`, `toDriver`, `toRide`, `toPool`; rooms are
   `user:<id>`, `driver:<id>`, `ride:<id>`, `pool:<id>`), and **only after the transaction committed**.
3. Client to server: add an `@SubscribeMessage` handler in `realtime.gateway.ts`; validate the payload
   strictly (for example `ride_offer_response` requires a UUID `offerId` and a boolean `accept`) and authorize
   against Postgres, not against what the client claims. Return an ack the client can act on.
4. Update both clients' types (`apps/web/src/lib/booking/types.ts`, Dart models, and
   `native-contract-parity.spec.ts`/`test/fixtures/native-auth-contract.json` if auth shapes change) and
   vault `40-backend/websocket-events.md`.

### Add a migration

1. Create `apps/api/migrations/00NN_short_name.sql` with the next number. Hand-written SQL, one logical
   change, **idempotent** (`IF NOT EXISTS`, conditional `ALTER`): the runner executes the body and records
   the file in separate statements, so a crash in between re-runs the file.
2. Edit `apps/api/src/db/schema.ts` to match, and `db/constraints.ts` if you add a named constraint the
   code needs to recognise.
3. No `DROP COLUMN`/`DROP TABLE` or rename in one release: expand, migrate, contract across two releases,
   because rollback does not reverse migrations (see [`scripts/deploy/README.md`](../../../scripts/deploy/README.md)).
4. Apply locally with `docker compose ... exec api npx tsx src/migrate.ts` (or `/db-migrate`). Integration
   tests apply every file via `runMigrations()` in `@rcab/test-fixtures`.
5. Migrations that touch existing active data may create `migration_conflict` rows instead of guessing
   (0014 and 0016 do). A person resolves them; see the runbook section 6.
6. Update vault `40-backend/schema-postgres.md`, `30-domain/data-model.md`, and `docs/ARCHITECTURE.md` section 5.

### Change a business rule

Edit its entry in `apps/api/src/config/policy/policy.schema.ts` (default, bounds, unit, `decision`), run
`pnpm policy:doc` and commit the regenerated `docs/POLICY.md` and the policy block of
`infra/docker/env.example/api.env.example`. `pnpm policy:doc:check` (in `pnpm verify` and Jenkins lint)
fails on drift. Inject `@Inject(POLICY) policy: Policy` in services; decorator arguments and plain functions
use `getPolicy()`. Cross-field rules go in `POLICY_RULES`. Never read a knob env var directly. If the change
alters an acceptance criterion or a product decision, that is a HITL stop (section 6).

---

## 4. Transactions, lock order and the outbox (read before touching dispatch, rides or pools)

The full contract is [`docs/remediation/stage-c-contract.md`](../../remediation/stage-c-contract.md)
section 1.3. The rules, in short:

1. **Lock order, always:** (1) the trip row (`rides` or `shared_rides`) `SELECT ... FOR UPDATE`;
   (2) `dispatch_offer` rows `FOR UPDATE`; (3) `driver_active_assignment` insert/delete;
   (4) `pool_member` and `ride_stops`; (5) `outbox` insert and `idempotency_record`. No transaction locks two
   trip rows. To find the trip from an offer: read the offer unlocked, lock the trip, re-read the offer
   `FOR UPDATE`, re-validate.
2. **DB clock** for expiry and deadlines, after the lock is held.
3. **Typed conflicts.** Map expected 23505/23514 with `pgConstraintViolation(err)` and the `Constraint.*`
   names into result unions; never match message text. Wrap a statement whose expected failure must not abort
   the outer transaction in a savepoint (`tx.transaction(...)`). On deadlock (40P01) or serialization failure
   (40001) retry the whole transaction at most twice (`withTxRetry` in `modules/dispatch/tx-retry.ts`), then
   return a typed `conflict`.
4. **After commit only:** Socket.IO emits, Redis projection writes, queue removals, timers and relay kicks.
   A failure there must never turn a committed success into an error; log it and let reconciliation repair it.
5. **No network inside a lock:** no OSRM, Redis or BullMQ call between BEGIN and COMMIT.
6. **Generation on everything**; a stale generation is a successful no-op.
7. **BullMQ job IDs are deterministic and colon-free:** `dispatch-start-<tripId>-g<g>`,
   `dispatch-wave2-<tripId>-g<g>`, `dispatch-hardfail-<tripId>-g<g>`, `scheduled-wake-<rideId>-g<g>`,
   `pool-expire-<poolId>`. Legacy colon IDs may still be in flight at deploy; handle a missing generation as
   "current" and remove both ID forms.
8. **No Lua decision points.** The old `pool_claim`/`pool_slot` scripts are gone; Redis is a projection.

### The outbox

- Write: `enqueueOutbox(tx, message)` (`modules/outbox/outbox.writer.ts`) inside the business transaction.
  The dedupe key is `<topic>:<aggregateId>:g<generation>`, so retries are no-ops.
- Topics (`outbox.types.ts`): `ride.dispatch.requested`, `ride.wake.schedule`, `pool.dispatch.requested`,
  `pool.expire.schedule`.
- Publish: `OutboxRelay` polls (policy `outbox.relayPollMs`), leases due rows in a short transaction,
  publishes to BullMQ with the deterministic job ID, then acks fenced by the lease token. Publish failure
  backs off exponentially; exhausted rows stay visible (metric `rcab_outbox_exhausted`).
- Repair: `DispatchReconciler` runs at boot and every 5 minutes (policy `outbox.reconcileIntervalMs`),
  re-arms wake jobs, dispatch waves, pool timers and unpublished work, and logs a `ReconcileReport`.
  `DriverAssignmentProjection` re-projects `current_ride_id` every 30 s.
- To add a new durable intent: add a topic and payload type, map it to a publication in the relay, give it a
  deterministic job ID in `outbox.jobs.ts`, make the consumer guard on state and generation, and add the case
  to the reconciler. Then write an integration test that kills the process between each step.

### Accept race (the shape to copy)

`acceptOffer` is one transaction: unlocked offer lookup, lock trip, lock offer, idempotent replay check
(before expiry rules), state checks, `expires_at <= now()` check (mark expired and commit), generation check,
trip state check, eligibility (active driver and active vehicle with enough seats), acquire the assignment
guard, claim the row, mark accepted, revoke sibling offers, COMMIT. After commit: projection write, remove
timers, emit `ride_offer_accepted` / `ride_offer_revoked` / `ride_state_changed`. Section 2.3 of the contract
lists every step.

---

## 5. Conventions and gotchas

- **Hot reload:** the dev api runs `node --watch` with an SWC loader (`apps/api/scripts/dev-register.cjs`) that
  emits decorator metadata, which Nest needs for implicit constructor injection. Do not run the api itself with
  `tsx watch` (esbuild emits no metadata, so providers arrive as `undefined`); `tsx` is fine for one-off scripts such
  as `src/migrate.ts`. SWC does not type-check, so run `pnpm --filter @rcab/api typecheck` yourself.
- **Fail-closed env:** outside `NODE_ENV=development|test`, a missing or weak `JWT_SECRET` (< 32 bytes or a
  placeholder) or an invalid `CORS_ORIGINS` (missing, wildcard, non-https) aborts startup. A bad policy value
  also aborts startup and the message lists every offending key (never the value).
- **Test seams** (`RCAB_DISABLE_BULL_AUTORUN`, `RCAB_DISABLE_WS_ADAPTER`, `RCAB_DISABLE_OUTBOX_RELAY`) turn off
  timers, workers and the Redis adapter for specs that boot `AppModule`. Specs that need the relay or
  reconciler construct them and drive `drainOnce()` / `reconcile()` deterministically.
- **Test fixtures:** every driver needs `app_user` + `driver` rows and an active `vehicle` when eligibility is
  checked; every pool passenger needs an `app_user`. Use `uniquePhone()` / `uniqueRegNo()`. Contention tests
  use **independent** `pg` connections, never `Promise.all` on one client. Unhandled rejections fail the run.
- **Integration tests are serial** (`singleFork`); a full run starts real containers and takes minutes.
- **Presence is advisory.** The geo index is Redis-only; the sweep removes drivers silent for 60 s; nothing
  resurrects presence except the driver calling `POST /v1/drivers/online` or reconnecting.
- **OSRM can fail** (`OsrmUnavailableException`). It must degrade a request, not wedge a transaction; fetch
  geometry before taking locks.
- **Logging:** pino JSON with `request_id` on the per-request log line and on error bodies. Never log tokens,
  phone numbers or Firebase ID tokens (an open item in the security checklist is to verify redaction).
- **Metrics:** instruments live only in `src/metrics.ts`; labels come from closed vocabularies, never ids,
  coordinates or raw paths. Record at the commit that made it true.
- **Throttling:** the global limit and auth limits come from policy `rateLimits.*`.
- **Commits:** `<type>(api): <subject>` with a `Story: RCAB-Ex.Sy` trailer (a hook blocks code commits without
  it). Update the vault note in the same change; a PostToolUse hook warns on dangling `[[links]]`.

---

## 6. Quality gates and HITL

| Gate | Command |
|---|---|
| Types and lint | `pnpm --filter @rcab/api typecheck` and `lint` |
| Unit with coverage floor | `pnpm --filter @rcab/api test:cov` |
| Production artifact | `pnpm --filter @rcab/api test:artifact` and `test:dev-loader` (Jenkins "API artifact" stage) |
| Integration (real containers) | `pnpm test:int` |
| Policy drift | `pnpm policy:doc:check` |
| Code graph drift | `pnpm code:graph:check` |
| Story gate | `pnpm verify`, then `/close-story` |

**Ask before** (see [`95-delivery/hitl-touchpoints.md`](../../../95-delivery/hitl-touchpoints.md)):

- Creating, superseding or revising an ADR under `99-decisions/`.
- Anything touching secrets handling or `80-infrastructure/secrets-management.md`.
- A new external service or vendor with cost or lock-in.
- Changing a story's acceptance criteria, bumping a demo headline, reordering or splitting epics.
- Product rules the code currently stands in for: shared-fare readjustment (E8.S9), member cancel/no-show in
  pools, pool fallback to solo, early assignment for scheduled trips, any cancel fee, and the 24 h RPO.
- Deploying to a real VPS, quarantining a flaky test, anything that tempts you toward multi-host or Kubernetes
  (ADR-0009; raise it as an impact-analysis trigger).

---

## 7. First 5 good tasks (from real open gaps)

1. **Central `RolesGuard` and DTO hardening (RCAB-E8.S4 security sweep).** Role checks are hand-written per
   controller and `forbidNonWhitelisted` is off. Introduce a guard or decorator, turn on strict validation,
   and add negative tests. About 30 boxes in `90-quality/security-checklist.md` are unchecked; some may
   already be true, so verifying and ticking them is part of the job.
2. **Shared fare readjustment (RCAB-E8.S9) groundwork.** Needs an owner pricing decision first (story is
   draft). You can prepare by writing the characterization tests for `fixed_at_join` and the settlement-record
   shape options, and by listing the questions for the owner.
3. **Rating aggregation (RCAB-E7.S2).** Ratings are captured (`ratings` table, `rating` module) but
   `client.rating_avg/count` and `driver.rating_avg` are not computed. Implement the weighted-recency job with
   cold-start handling (vault `70-algorithms/algo-rating-aggregation.md`) and a BullMQ-backed schedule. Needs a
   story generated first (`/gen-story`).
4. **Drop the deprecated `shared_rides.members` jsonb column.** It is no longer written (stage-C flag F-4).
   First remove the remaining readers (the `/pool-inspect` and `/redis-inspect` skills and docs), then ship an
   expand/contract migration. Touches a migration, so follow the section 3 rules.
5. **Make the migration runner transactional.** `migrate.ts` has the advisory lock but runs the SQL body and the
   `_rcab_migrations` insert as separate statements. Wrap each file plus its history row in one transaction
   (and keep a path for the rare statement that cannot run in a transaction, such as `CREATE INDEX CONCURRENTLY`),
   and add an integration test with a deliberately failing migration. Coordinate with DevOps: the release
   `migrator` runs this file.

Also open: an `idempotency_record` cleanup/TTL job, a real `seedPilotCity`, and the E8.S5 k6 budget confirmation
on target hardware (shared with DevOps).

---

## 8. References

| Topic | Where |
|---|---|
| Orientation | [`CLAUDE.md`](../../../CLAUDE.md), [`00-index/HOME.md`](../../../00-index/HOME.md), [`00-index/reading-paths.md`](../../../00-index/reading-paths.md) ("Backend implementation" paths) |
| Architecture | [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| Business numbers | [`docs/POLICY.md`](../../POLICY.md), vault `40-backend/policy-config.md` |
| Transaction contract | [`docs/remediation/stage-c-contract.md`](../../remediation/stage-c-contract.md) |
| Recovery and invariants | [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md); invariant SQL in the contract section 6 |
| Bring-up and demo walk | [`docs/manual-testing/RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md) |
| Module and API notes | vault `40-backend/` (`module-map`, `module-rides`, `module-dispatch`, `module-matching`, `module-realtime`, `module-auth`, `rest-endpoints`, `websocket-events`, `schema-postgres`, `redis-usage`, `migrations`, `error-codes`, `api-conventions`, `nestjs-structure`) |
| Domain and state machines | vault `30-domain/` (`sm-ride-lifecycle`, `sm-shared-ride-pool`, `sm-booking-flow`, `sm-driver-availability`) and [`../state-machines.md`](../state-machines.md) |
| Algorithms | vault `70-algorithms/` |
| Testing strategy | vault `90-quality/testing-strategy.md` |
| Decisions | `99-decisions/` (ADR-0001 NestJS, 0005 Postgres+Redis, 0008 Socket.IO, 0009 single VPS, 0010 route similarity) |
| Skills | `/code-graph`, `/db-migrate`, `/seed-db`, `/redis-inspect`, `/pool-inspect`, `/osrm-check`, `/api-smoke`, `/coverage`, `/code-review` (see `.claude/skills/`) |
