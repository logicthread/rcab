# Guide: Senior Architect

Audience: the person who will own technical direction of rcab. Assumes you read `docs/ARCHITECTURE.md` (code-verified reference) and will use this page as the "why, guarantees, risks" companion. Where this page and the vault disagree, the code wins; drift found while writing it was fixed (see the end).

Related onboarding pages: [README](../README.md) · [Manager guide](manager.md) · videos index per area: [web](../videos/web/INDEX.md), [driver app](../videos/driver-app/INDEX.md), [ops](../videos/ops/INDEX.md).

## 1. Shape of the system in one paragraph

Phase-0 ride-hailing: a Next.js 14 web client (passengers), a Flutter driver app, one NestJS 10 API (HTTP `/v1/*` + Socket.IO on the same port), Postgres 16/PostGIS as the single system of record, Redis 7 for presence/geo, BullMQ timers and the Socket.IO adapter, self-hosted OSRM for routing. Everything runs on one VPS under one docker-compose (ADR-0009). Redis is a rebuildable projection; Postgres is truth.

## 2. Architecture decisions (`99-decisions/`)

ADRs are HITL: do not create, supersede or edit them without owner approval (`95-delivery/hitl-touchpoints.md`).

| ADR | One-line summary |
|---|---|
| ADR-0001 Backend on NestJS | NestJS 10 on Node 20 + TypeScript; modular DI monolith. |
| ADR-0002 Web on Next.js | Next.js 14 App Router; authenticated shell static, marketing routes may SSR. |
| ADR-0003 OTP via Firebase | Firebase Phone Auth issues ID tokens; API exchanges them for first-party JWTs. |
| ADR-0004 OSM for booking, Google for nav | Clients use Leaflet/OSM/Nominatim + self-hosted OSRM; drivers hand off to Google Maps for navigation. |
| ADR-0005 Postgres primary, Redis cache | Postgres 16 (+PostGIS) holds all transactional state; Redis is fast-path/ephemeral only. |
| ADR-0006 Flutter driver app | Flutter 3.x, Android-only in Phase-0, iOS left intact for Phase-1. |
| ADR-0007 Monorepo layout | pnpm workspaces + Turborepo; Flutter app lives beside, outside the workspace. |
| ADR-0008 Socket.IO realtime | Socket.IO 4 with the Redis adapter from day one so Phase-1 can split nodes with no protocol change. |
| ADR-0009 Single VPS Phase-0 | One host, one compose, off-host backups; thresholds in `20-architecture/scaling-strategy.md` trigger step-out. |
| ADR-0010 Polyline route similarity | Shared-ride matching = coarse spatial prefilter + mean nearest-neighbour distance between resampled OSRM polylines. |

Note: ADR-0005/ARCHITECTURE-era text said Redis held claims/offers/seat counters. After Stage C (RCAB-E8.S8) those are in Postgres; the ADR's "Redis for ephemeral" still holds but its detail text may mention the old split. Proposed (owner decision, not applied): add a short ADR addendum recording "offers, assignment guard, pool membership and outbox are authoritative in Postgres".

## 3. Guarantees and invariants, and where they are enforced

Full contract and the invariant SQL: `docs/remediation/stage-c-contract.md` (sections 1.3 and 6). Run those queries against any DB you care about; all must return zero rows.

| Guarantee | Enforced by |
|---|---|
| A driver holds at most one active trip (solo or shared) | `driver_active_assignment` guard table (unique on driver) written in the same transaction as accept; invariants I1, I2. |
| An offer can be accepted once, only by its recipient, before expiry, for the current dispatch generation | Single Postgres transaction against `dispatch_offer` (owner, expiry via DB clock, generation, trip state, eligibility). I3, I4. |
| Pool seats never exceed capacity; `seat_count` equals sum of members | `pool_member` rows + trigger + CHECK; `seat_count` derived. I5, I6. |
| Shared fare is fixed at join and immutable | `pool_member.agreed_fare_cents` (migration 0017) with trigger `pool_member_agreed_fare_guard`. |
| Committed intent is never lost (a booking always eventually dispatches; a scheduled ride always wakes) | Transactional outbox: the booking commit writes an `outbox` row; `OutboxRelay` leases and publishes to BullMQ; `DispatchReconciler` rebuilds missing work on boot and every 5 min. I7, I8, I9. |
| Stale timers/jobs are harmless | Every offer, job and outbox row carries `dispatch_generation`; a consumer with an old generation does nothing and returns success. Job IDs have no colons (`dispatch-start-<id>-g<g>`). |
| A retried create does not double-book | `Idempotency-Key` scoped to account + operation, durable in Postgres (`idempotency_record`, migration 0013); same key + different body = 422 `idempotency_key_conflict`; in-flight = 409 `idempotency_request_in_progress`; pending claims reclaimable after 60 s. |
| Refresh tokens are single-use with family revoke on replay | `auth_refresh_token` (SHA-256 hash, `family_id`, `revoked_at`) in Postgres; 10 s reuse grace returns plain 401. Web uses cookie + Origin/Referer CSRF check; native uses JSON `/v1/auth/native/*`. |
| Config is validated and fail-closed | Policy schema (`apps/api/src/config/policy/policy.schema.ts`) validates every knob and 10 cross-field rules at boot; `JWT_SECRET` and `CORS_ORIGINS` are required outside development/test. See `docs/POLICY.md`. |
| Ride state transitions are race-safe | `RideStateMachine` uses `SELECT ... FOR UPDATE` on the ride; cancel and driver transitions serialise on the same row. |

Ride states (`rides.status`): `requested, dispatching, accepted, en_route, arrived, in_progress, completed, cancelled, no_driver, no_show`. Pool states (`shared_rides.pool_state`): `open, closed_full, closed_timeout, closed_started, aborted, completed`. The diagrams live in the state-machine page of this pack and in `30-domain/sm-ride-lifecycle.md`, `30-domain/sm-shared-ride-pool.md`.

## 4. Concurrency model and lock order

Rules from the Stage C contract (section 1.3), which every transaction must follow:

1. Lock order: (1) the trip row (`rides` or `shared_rides`, `FOR UPDATE`), (2) `dispatch_offer` rows, (3) `driver_active_assignment` insert/delete, (4) `pool_member` and `ride_stops`, (5) `outbox` insert and `idempotency_record`. No transaction locks two trip rows. To find a trip from an offer: read offer unlocked, lock trip, re-read offer `FOR UPDATE`, re-validate.
2. Deadlines are compared with the DB clock (`now()`), after the lock, never with `Date.now()`.
3. Expected 23505/23514 violations are mapped via `pgConstraintViolation()` and `Constraint.*` names (`apps/api/src/db/constraints.ts`), never by message text; 40P01/40001 are retried at most twice.
4. Socket emits, Redis projection writes, queue removals and relay kicks happen after commit only. A failure there is logged and repaired by reconciliation, never surfaced as an error for a committed success.
5. No network inside a lock (no OSRM, Redis or BullMQ between BEGIN and COMMIT). Shared join therefore prices outside the lock and re-prices up to `MATCHING_JOIN_PRICE_RETRIES` (3) if the pool changed; `PRICING_OSRM_TIMEOUT_MS` bounds one routing call.
6. No Lua decision points; Redis compare-and-set, if any, is an inline `EVAL` constant.

Contention tests must use independent `pg.Client`/Pool connections (not `Promise.all` on one client).

## 5. Failure modes and recovery

Authoritative detail: `docs/operations/recovery-runbook.md`. Summary:

| Failure | Effect | Recovery |
|---|---|---|
| Redis lost/flushed | Availability only: no drivers shown online, timers missing, stale pool pages. | Restart api: `PoolProjectionService` rebuilds `pool:<id>`, `DispatchReconciler` re-arms timers (also every 5 min), `DriverAssignmentProjection` re-projects every 30 s. Presence returns when drivers reconnect. Drill: `scripts/recovery/redis-loss-drill.sh`. |
| Postgres loss/corruption | Data loss up to last backup. | Restore procedure runbook section 4; then invalidate all sessions and flush Redis. RPO about 24 h (nightly logical dump, no WAL/PITR). RTO not proven for production. |
| API crash mid-booking | Committed bookings are safe (outbox). | Restart; relay leases expire (30 s) and rows are re-published; reconciler repairs gaps. |
| OSRM down | Quotes and shared joins fail cleanly (bounded timeout); readiness probe reports it. | Restart OSRM; graph rebuilt from the OSM PBF by `osrm-prep`/`osrm-extract`. |
| Outbox row exhausted (10 attempts) | Row marked failed; operator action. | I9 queries; metric `rcab_outbox_exhausted`; reconciler may re-arm. |
| Migration conflict rows | Some trips have no driver guard until resolved. | Runbook section 6, `scripts/recovery/resolve-driver-conflict.sql`. Never auto-cancel. |
| Bad release | Auto-rollback in `scripts/deploy/deploy.sh` (exit 10 = rolled back, 11 = rollback failed). | `scripts/deploy/README.md`; migrations are forward-only, so ship destructive changes as expand/migrate/contract over two releases. |

## 6. Scaling path beyond Phase-0

Source: `20-architecture/scaling-strategy.md` (a staircase). Trigger when any signal holds for two consecutive weeks: more than 300 active drivers, more than 10,000 completed rides/day, API p99 above 800 ms, VPS CPU above 70% sustained, Postgres connections above 70% of pool, Redis above 50k ops/s.

1. Vertical on the same VPS (8 vCPU/32 GB), tune Postgres, add PgBouncer (transaction pooling) and a read replica.
2. Split the data tier (Postgres and Redis on their own hosts).
3. Horizontal API behind nginx/HAProxy. Socket.IO already uses the Redis adapter; add LB affinity for driver sockets. Check first: `ScheduledModule`/outbox relay use leases and DB guards so multiple API nodes are designed to be safe, but this has never been run multi-node. Verify with a multi-node integration test before relying on it.
4. Extract dispatch+matching+geo (and maybe realtime) into a service.
5. Event log/MongoDB for ride traces, CDC bridge. Not before a second consumer exists.

Anything that tempts multi-host/Kubernetes earlier is an impact-analysis trigger and an ADR-0009 conversation with the owner.

## 7. Known risks and tech debt

From the review remediation stories (RCAB-E8.S7 Stage A+B, S8 Stage C, plus stage D/E work merged on main) and the open E8 stories:

- **Backups**: encrypted nightly dump exists and a restore drill ran on fixtures only. No offsite store configured, no production drill, no PITR. RPO up to 24 h.
- **Alerting is a skeleton**: only two Prometheus rules; Alertmanager has no receiver (RCAB-E8.S2). Dashboards partially filled (E8.S1).
- **Shared fare policy is a stand-in** (`fixed_at_join`); no refund/adjustment/settlement record (E8.S9, needs owner policy). Related open: member cancel/no-show inside a pool, pool fallback to solo, early assignment for scheduled trips.
- **Ratings**: capture exists for completed solo rides; aggregation, moderation and history are E7. Check whether shared-ride completion offers rating before promising it.
- **Driver earnings screen is a placeholder** ("coming in E7").
- **Deprecated column** `shared_rides.members` jsonb is no longer written; drop in a later migration once no reader remains (some inspect skills/docs still mention it).
- **Vehicle eligibility** (F-2): drivers without an active vehicle with enough seats get no offers; pilot onboarding must create vehicles.
- **Security sweep, TLS/HSTS/CSP audit and load run on target VPS class** are open (E8.S4, S5, S6). `pnpm test:load` thresholds are targets, not measured results on production hardware.
- **Stories index drift**: E8 rows show several `▶` (S7, S8, S10-S13) although main contains their merged work (last merge: remediation stage E). Reconcile statuses with the owner before reporting progress.
- **Demo sign-offs**: only Demo 4 has a recorded `Sign-off:` trailer in git history; the Demo 5 walk is still owed per CLAUDE.md.
- **Single points of failure** by design: one host, one Postgres, one Redis, one API process.
- **Docs generated from code**: `docs/POLICY.md` is generated (`pnpm policy:doc`); editing it by hand fails CI (`pnpm policy:doc:check`).

## 8. Decisions still owed by the owner

- Shared-fare readjustment policy and settlement record (E8.S9 questions 1-5).
- Pool member cancel/no-show behaviour; pool-to-solo fallback; early assignment for scheduled rides.
- Offsite backup target and credentials (S3-compatible, any vendor), age identity custody.
- Deploy credentials and first real VPS deploy (HITL: demo 7+ deploys, secrets handling).
- Slack webhook (or other channel) for Alertmanager and Uptime Kuma.
- Whether cancellation fees ever apply (Phase-0: none).
- Logout-everywhere scope and other open session decisions listed in the E8.S7 notes.
- ADR addendum noting the post-Stage-C Postgres authority (see section 2).

## 9. Review hotspots (read these first)

| Area | Files |
|---|---|
| Config/policy | `apps/api/src/config/policy/policy.schema.ts`, `docs/POLICY.md` |
| Schema and constraints | `apps/api/src/db/schema.ts`, `apps/api/src/db/constraints.ts`, `apps/api/migrations/` (0014-0017 are Stage C) |
| Dispatch | `apps/api/src/modules/dispatch/dispatch.service.ts`, the outbox module (`outbox.writer.ts`, relay, reconciler) |
| Ride lifecycle | `apps/api/src/modules/rides/ride-state-machine.service.ts`, `rides.repository.ts`, `rides.controller.ts` |
| Shared rides | `apps/api/src/modules/matching/`, `modules/pricing/shared-fare-policy.ts` |
| Auth/sessions | `apps/api/src/modules/auth/`, CSRF guard |
| Realtime | `apps/api/src/modules/realtime/realtime.gateway.ts` (subscribe authorisation, snapshots, versioned events) |
| Metrics | `apps/api/src/metrics.ts` |
| Client resilience | `apps/web/src/lib/booking/ws.ts`, `apps/driver-app/lib/features/offer/`, `shared_ride/` |
| Ops | `infra/docker/docker-compose.prod.yml`, `infra/docker/backup/`, `scripts/deploy/`, `scripts/recovery/` |

Tools: `/code-graph` answers "who imports X / which route / which tables" from `codegraph/graph.json` without grepping.

## 10. Drift found and fixed while writing this guide

- `80-infrastructure/observability.md` presented seven alerts and Slack delivery as fact; code defines two alert rules and no Alertmanager receiver. Now annotated with implementation status.
