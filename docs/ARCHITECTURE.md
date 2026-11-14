# rcab — Architecture & Interfaces (authoritative, 2026-07-17)

> This is the current, code-verified architecture reference. It supersedes the
> older `docs/manual-testing/technical-guide.md` (written 2026-06-15, pre-E4/E5/E6,
> with several speculative table/port names that never shipped). Facts here were
> pulled from the running code, the code graph (`codegraph/graph.json`), the
> Drizzle schema, the Socket.IO gateway, and the compose file. For the hands-on
> bring-up + demo flows, read `docs/manual-testing/RUN-GUIDE.md` alongside this.

---

## 1. What rcab is

A phase-0 ride-hailing platform: a **web client** books rides, a **Flutter driver app**
accepts + drives them, a **NestJS API** orchestrates matching/dispatch/lifecycle over
**Postgres** (durable state) + **Redis** (presence, locks, queues, pub/sub) + **OSRM**
(routing). Auth is **Firebase phone-OTP** exchanged for first-party JWTs.

**Phase-0 contract (ADR-0009):** everything runs on **one VPS** under **one
docker-compose**. No Kubernetes, no managed cloud services. Deliberate.

---

## 2. Service topology & ports

```
                      Firebase Auth (phone OTP) ── ID token ──┐
                                                              ▼
  Web (Next.js 14)  ──HTTP /v1 + Socket.IO──►  ┌───────────────────────────┐
  host :3002                                   │        API  :3000         │
                                               │   NestJS 10 (HTTP + WS)   │
  Driver app (Flutter) ──HTTP + Socket.IO──►   │                           │
                                               │  ┌── 14 feature modules ──┐│
                                               └──┼────────────┬──────────┼┘
                                     Postgres 16 ◄┘   Redis 7 ◄┘   OSRM ◄──┘ HTTP
                                        :5432           :6379       :5000
  Observability (compose profile `obs`):
    Grafana :3001 · Prometheus :9090 · Uptime-Kuma :3003 · Loki + Promtail + Alertmanager (no host port)
```

| Service | Image | Host port | Role |
|---|---|---|---|
| `api` | built (`apps/api`) | **3000** | NestJS HTTP `/v1/*` + Socket.IO WS |
| `web` | built (`apps/web`) | **3002** | Next.js client (container listens on 3000, mapped to 3002) |
| `postgres` | `postgis/postgis:16` | **55432** | durable state (container 5432; host 5432 is usually a local install); creds `rcab` / `rcab` / db `rcab` |
| `redis` | `redis:7-alpine` | **6379** | geo presence, BullMQ, Socket.IO adapter |
| `osrm` | `osrm/osrm-backend` | **5000** | routing (`/route/v1/driving/...`); dev graph = **NE-India (Guwahati)** |
| `osrm-prep` / `osrm-extract` | alpine / osrm | — | one-shot graph build on first up |
| `grafana` | `grafana/grafana:11` | **3001** | dashboards (profile `obs`) |
| `prometheus` | `prom/prometheus` | **9090** | scrapes API `/metrics` (profile `obs`) |
| `uptime-kuma` | `louislam/uptime-kuma` | **3003** | synthetic health monitor (profile `obs`) |
| `loki`/`promtail`/`alertmanager` | grafana/prom | — | logs + alert routing (profile `obs`, not fully wired — E8) |

Driver app (Flutter) runs on a device/emulator **outside** compose; it points at the
laptop LAN IP, not `localhost`.

---

## 3. API surface — all routes

All under `/v1` except `/` and `/metrics`. Auth = first-party JWT `Authorization: Bearer`
via `AuthGuard`, except the public health/auth-entry routes. `POST /v1/auth/refresh` is
also CSRF-guarded (Origin, then Referer, against the `CORS_ORIGINS` allowlist). Native clients
(driver app) use `/v1/auth/native/{firebase-exchange,refresh,logout}`: JSON tokens, no cookie, no CSRF.
Access JWTs are HS256 with `iss=rcab`, `aud=rcab-api`, `typ=access`. `JWT_SECRET` and
`CORS_ORIGINS` are validated at startup and **fail closed** unless `NODE_ENV` is `development`/`test`.

| Method + path | Module | Auth | Purpose |
|---|---|---|---|
| `GET /` | health | public | alias of readiness |
| `GET /v1/health/live` | health | public | liveness probe |
| `GET /v1/health/ready` | health | public | readiness (checks pg/redis/osrm) |
| `GET /v1/health/version` | health | public | running build identity `{version, builtAt}` (commit SHA in release images, `dev` locally; RCAB-E8.S11) |
| `GET /metrics` | health | unauthenticated in the API; 404 on the public nginx vhost (f581d09) | Prometheus metrics |
| `POST /v1/auth/firebase-exchange` | auth | public | Firebase ID token → rcab JWT pair + refresh cookie |
| `POST /v1/auth/refresh` | auth | cookie+CSRF | single-use rotation of the refresh cookie; replay revokes the session family |
| `POST /v1/auth/native/*` | auth | public / JWT (logout) | native exchange/refresh/logout, JSON tokens |
| `POST /v1/auth/logout` | auth | JWT | revoke refresh token (Postgres `auth_refresh_token.revoked_at`) |
| `POST /v1/auth/google/login` | auth | public | Google ID token → JWT (linked users) |
| `POST /v1/auth/google/link` | auth | JWT | link a Google account |
| `POST /v1/vehicles` | vehicles | JWT (driver) | register a vehicle |
| `GET /v1/vehicles` | vehicles | JWT (driver) | list my vehicles |
| `PATCH /v1/vehicles/:id` | vehicles | JWT (driver) | edit a vehicle |
| `POST /v1/drivers/online` | drivers | JWT (driver) | go online (writes geo presence) |
| `POST /v1/drivers/offline` | drivers | JWT (driver) | go offline |
| `PATCH /v1/drivers/me/vehicle` | drivers | JWT (driver) | set current vehicle |
| `POST /v1/rides/quote` | rides | JWT (client) | fare + route + signed quote token; `type` normal/shared/scheduled |
| `POST /v1/rides` | rides | JWT (client) | request a ride; `Idempotency-Key` scoped to account+operation, 422 `idempotency_key_conflict`, 409 `idempotency_request_in_progress` (shared); branches by `type` |
| `GET /v1/rides/:id` | rides | JWT (owner) | ride status + timestamp trail |
| `GET /v1/rides/:id/stops` | rides | JWT (driver) | shared-ride stop sequence |
| `POST /v1/rides/:id/state` | rides | JWT (driver) | solo state transition (en_route/arrived/…) |
| `POST /v1/rides/:id/cancel` | rides | JWT (client/driver) | cancel / no-show |
| `POST /v1/rides/:id/ratings` | rating | JWT (both) | two-sided rating (post-completion) |

Dispatch has **no HTTP surface** — it's event/queue-driven (see §7).

---

## 4. Realtime — Socket.IO (WS on the API port)

Stage D (R09): clients call `pool:subscribe` / `ride:subscribe` (authorized against Postgres) and get a Postgres snapshot (`pool:snapshot`, `ride:snapshot`; drivers also `driver:assignment` / `driver:sync`). Incremental events are versioned (pool = `shared_rides.state_version`, ride = status rank) so clients ignore stale ones. Offer results are `ride_offer_outcome` events.

Gateway: `apps/api/src/modules/realtime/realtime.gateway.ts`. Rooms: `user:<id>`,
`driver:<id>`, `ride:<id>`, `pool:<id>`. Multi-node fan-out uses the Redis adapter
(`socketio:*`); single-node it's a no-op.

**Client → server (`@SubscribeMessage`):**

| Event | Sender | Payload | Effect |
|---|---|---|---|
| `driver:location` | driver | `{lat,lng,heading,speed}` | geo-index update (3s throttle) + live fan-out to the ride room (1 Hz) |
| `ride:subscribe` | client/driver | `{rideId}` | join the ride room after ownership check |
| `ride_offer_response` | driver | `{offerId,accept,sharedRideId?}` | accept/decline a dispatch offer |
| `stop:pickup_confirmed` / `stop:drop_confirmed` | driver | `{rideId,sequenceIndex}` | shared-ride stop progress |

**Server → client (via `RealtimeBus`):**

| Event | To | Meaning |
|---|---|---|
| `ride_offer` | `driver:<id>` | an offer (solo `{rideId,fareCents,…}` or shared `{sharedRideId,stops[]}`) |
| `ride_offer_accepted` / `ride_offer_revoked` | `driver:<id>` | claim result (winner / race-loser) |
| `ride_no_driver` | `user:<id>` | dispatch exhausted all waves |
| `ride_state_changed` | `ride:<id>` | lifecycle transition `{state, by?}` |
| `driver_location` | `ride:<id>` | live driver position during an active ride |
| `pool:update` | `pool:<id>` | shared pool seat-count / status change |
| `driver_state` | on connect | replay of the driver's availability/current ride |

---

## 5. Data model — Postgres (Drizzle, `apps/api/src/db/schema.ts`)

**15 tables** in `schema.ts` (the tables below, plus `idempotency_record` and the Stage C tables `migration_conflict`, `dispatch_offer`, `driver_active_assignment`, `outbox`, `pool_member`). FKs shown with →. (Stage C added `dispatch_offer`, `driver_active_assignment`, `outbox`, `pool_member` and `migration_conflict` (migrations 0014-0017) — offers, assignment and pool membership are authoritative in Postgres, not Redis. No `ride_events`/`jwt_revocations`
tables exist. Refresh-token revocation is the
`auth_refresh_token.revoked_at` column, **not** a Redis set.)

| Table | Purpose | Key columns / FKs |
|---|---|---|
| `app_user` | every user (client or driver) | `id`, `firebase_uid` uniq, `phone_e164` uniq, `google_sub`, `role` (client/driver), `status` |
| `client` | client profile | `user_id` → app_user (PK), `rating_avg`, `rating_count` |
| `driver` | driver profile | `user_id` → app_user (PK), `availability` (offline/online/on_ride), `current_vehicle_id`, `rating_avg` |
| `vehicle` | driver vehicles | `id`, `driver_id` → driver, `type`, `reg_no` uniq, `seats`, `active` |
| `auth_refresh_token` | refresh tokens | `token_hash` (SHA-256 digest), `user_id` → app_user, `family_id`, `auth_method`, `expires_at`, `revoked_at` |
| `rides` | solo/normal + scheduled rides | `id`, `passenger_id` → app_user, origin/dest lat/lng, `fare_cents`, `status`, **`type` (normal/shared/scheduled)**, **`scheduled_for`**, `idempotency_key`+`idempotency_operation`+`request_fingerprint` (unique per passenger/operation/key), `driver_id`, lifecycle + cancel timestamps |
| `shared_rides` | pooled rides | `ride_id` (PK), `seat_count`, `max_seats`, `pool_state`, `members` jsonb, `claimed_by_driver_id`, detour budget |
| `ride_stops` | shared-ride stops | (`ride_id` → shared_rides, `sequence_index`) PK, `passenger_id`, `type` (pickup/dropoff), lat/lng |
| `ratings` | two-sided ratings | `id`, `ride_id`, `rater_id`, `subject_id`, `stars` (1–5), uniq per direction. **Capture only** — aggregation is E7 |

`rides.status` ∈ `requested, dispatching, accepted, en_route, arrived, in_progress,
completed, cancelled, no_driver, no_show`.

### Migrations
Hand-authored SQL in `apps/api/migrations/` (`0001`…`0017`), applied in order by a
custom runner `apps/api/src/migrate.ts` (tracks applied files in `_rcab_migrations`; serialised by a Postgres advisory lock).
**Not auto-applied on `pnpm dev` / container restart** — run the runner explicitly:
```bash
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts
```
Integration tests apply the same files via `@rcab/test-fixtures` `runMigrations()`.

---

## 6. Redis keyspaces

| Key | Type | Owner | Purpose |
|---|---|---|---|
| `active_drivers` | GEO ZSET | drivers/realtime | online driver positions (dispatch candidate source) |
| `driver:state:<id>` | HASH | drivers/realtime | availability, `current_ride_id` (projection of `driver_active_assignment`), `last_seen` |
| `pool:<rideId>` | HASH | matching | **projection** of the Postgres pool (`shared_rides` + `pool_member`), reconciled at boot and periodically |
| `bull:dispatch:*`, `bull:matching:*`, `bull:scheduled-dispatch:*` | BullMQ | dispatch/matching/scheduled | wave-timeout, hard-fail, pool-expire, and scheduled-wake delayed jobs |
| `socketio:*` | pub/sub | realtime | Socket.IO Redis adapter (multi-node) |

Idempotency is no longer in Redis: it is durable in Postgres (migration 0013). Offers, claims and seat counters are not in Redis either (Stage C): `dispatch_offer`, `driver_active_assignment`, `outbox` and `pool_member` in Postgres are authoritative; the `claim:ride:*`, `offer:*`, `pool:*:seats|offered|stops` keys and the `pool_claim`/`pool_slot` Lua scripts were removed.

Inspect with `/redis-inspect` (geo/queues/projections) and `/pool-inspect` (shared pools; Postgres first).

---

## 7. Modules & flows

**14 NestJS module directories** (`apps/api/src/modules/`: the 12 listed below plus `outbox` and `metrics`; `dispatch-runner.module.ts` lives in `dispatch/`), plus the global `PolicyModule` (`config/policy/`) and infra modules
(`infra/`: drizzle, redis, firebase, google). See `40-backend/module-map.md` (kept in
sync by `pnpm code:graph:check`) and `codegraph/graph.md` for the live DI graph.

`auth · vehicles · drivers · realtime · pricing · rides · dispatch · ride-lifecycle ·
matching · rating · health · scheduled · outbox · metrics`

### Solo ride lifecycle (state machine — `rides.status`)
```
requested → accepted → en_route → arrived → in_progress → completed
     └──────────────► no_driver            (any pre-complete) └► cancelled / no_show
```
(`dispatching` is allowed by the `rides.status` CHECK but no code writes it: a ride stays `requested` for its whole search.)
- **Dispatch** (`dispatch` module, Postgres outbox + BullMQ timers): the booking commit
  writes an `outbox` (`ride.dispatch.requested`) in the same transaction;
  `OutboxRelay` → `DispatchStartService` → `dispatchSolo` → geo top-K on `active_drivers`
  (wave-1 K1/R1) → persist `dispatch_offer` rows and fan out `ride_offer`. A
  `ride_offer_response{accept}` is validated in **one Postgres transaction** against the
  stored offer (owner, expiry, generation, trip state, eligibility); the
  `driver_active_assignment` guard allows one active trip per driver (solo or shared).
  The driver gets a `ride_offer_response` ack, everyone gets `ride_offer_outcome`
  (assigned/lost/expired/revoked/rejected). No accept → wave-2 (K2/R2) → hard-fail →
  `no_driver` + notify passenger. `DispatchReconciler` re-arms anything committed but
  never started; the in-memory `ride.requested` event no longer exists.
- **Lifecycle** (`rides` module, `RideStateMachine`; shared-trip stop confirmation is `ride-lifecycle`): driver drives the forward
  transitions via `POST /v1/rides/:id/state` (SELECT … FOR UPDATE guarded). Cancel /
  no-show via `POST /v1/rides/:id/cancel` (role-aware; no fee in Phase-0).

### Shared ride (E5)
`matching` scores a new request against open pools (route-similarity on cached OSRM
polylines) → slot into an open pool or open a new one → pool lifecycle
`open → grow → close → dispatch` (a join is one Postgres transaction over `pool_member`,
seat count and itinerary; Redis `pool:<id>` is a projection) → shared dispatch offers
carry the multi-stop sequence. Seat fare is quoted inside the join transaction and stored
in `pool_member.agreed_fare_cents`, fixed at join (`SHARED_FARE_POLICY='fixed_at_join'`,
stand-in until RCAB-E8.S9).

### Scheduled ride (E6)
`POST /v1/rides` with `type=scheduled` + `scheduled_for` (15 min–24 h) persists the ride
`requested` plus a `ride.wake.schedule` outbox intent that arms a BullMQ **delayed** job
on `scheduled-dispatch` (fires 10 min before pickup) **instead of** dispatching now. On
wake the same outbox-driven solo dispatch path runs (`dispatchSolo` guards
`status='requested'`, so a cancelled ride is safely skipped), but with a **4-minute**
accept window (`SCHEDULED_DISPATCH_WINDOW_MS=240000`). An unanswered scheduled ride is
re-armed with a new generation (no retry-count cap, but bounded in time: once
`scheduled_for + SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS`, 30 min, the first window to close ends the
ride as `no_driver`) and the passenger is told once (`ride_dispatch_retry`). Cancel before wake drops the delayed job.

---

## 8. Auth flow

```
app → Firebase signInWithPhoneNumber → ID token
app → POST /v1/auth/firebase-exchange {id_token}
     API verifies via firebase-admin → upserts app_user → mints:
        access JWT (Bearer, ~15 min)  +  refresh token (HttpOnly cookie `refresh_token`, `SameSite=Lax`, path `/v1/auth`; the JSON body carries no refresh token)
... access expires ...
app → POST /v1/auth/refresh (cookie auto-sent, Origin/CSRF-checked) → new access JWT
logout → refresh token marked revoked (Postgres `auth_refresh_token.revoked_at`)
         → subsequent refresh 401
```
Google link/login layer on top of the same JWT issuance.

---

## 9. Repo layout

```
apps/
  api/          NestJS 10 — src/{modules,infra,common,db,migrate.ts}
  web/          Next.js 14 App Router (src/app: /signin, /book) + Playwright e2e
  driver-app/   Flutter (Riverpod/Dio/Socket.IO/Firebase) — feature-first lib/
packages/
  shared/       cross-app TS types      api-client/ typed client      test-fixtures/ (unique data, migrations runner; seedPilotCity is a STUB)
infra/docker/   compose: dev / test / prod / prod-test  (+ nginx, postgres, backup, jenkins)
infra/load/     k6 (probe.js)           infra/observability/ grafana+prometheus
scripts/        dev-up / smoke / system-probe / codegraph/ (code knowledge graph)
codegraph/      graph.json + graph.md   (queryable code graph — `/code-graph`, `pnpm code:graph`)
00-index/…99-decisions/   Obsidian vault (source of truth for design + delivery)
.claude/skills/ 25+ project skills      .claude/hooks/ commit-trailer + vault-link + codegraph-stale
```

---

## 10. Quality & verification

- **Unit**: Vitest, `pnpm test` (per-package via turbo). API coverage floor enforced
  (stmts/lines 75, branches 85, funcs 70) — `pnpm --filter @rcab/api test:cov`.
- **Integration**: real Postgres + Redis via **Testcontainers** (never mocked),
  `pnpm test:int`. Includes concurrency tests (claim race, pool over-seat, idempotency,
  cancel FOR UPDATE) and the scheduled wake end-to-end.
- **Gate**: `pnpm verify` = lint + coverage-gated unit + integration. This is the
  story-done proof (wired into `/close-story`).
- **e2e**: Playwright (web) `pnpm test:e2e` against a running stack; k6 `pnpm test:load`.
- **CI**: Jenkins (`Jenkinsfile`, `Jenkinsfile.nightly`).

---

## 11. Config (`.env.dev`, auto-created by `pnpm dev:up`)

Key vars: `POSTGRES_USER/PASSWORD/DB` (rcab/rcab/rcab), `OSM_PBF_URL` (OSRM region),
`GOOGLE_CLIENT_IDS`, `AUTH_ENABLED_METHODS` (default `google`), `CORS_ORIGINS` (required outside dev/test), `FIREBASE_PROJECT_ID` +
`FIREBASE_SERVICE_ACCOUNT_JSON` (needed only while `phone` is enabled; the api boots without them when Google-only), `FIREBASE_PHONE_TEST_TOKEN`
(pre-minted test ID token to skip the SMS round-trip in smoke tests), `JWT_SECRET` (>=32 bytes, no placeholder, required unless `NODE_ENV` is development/test),
`NEXT_PUBLIC_API_URL`. Tunables read via `ConfigService` include
`SCHEDULED_WAKE_LEAD_MS`, `MATCHING_POOL_TIMEOUT_MS`, `SCHEDULED_DISPATCH_CONCURRENCY`.
Validate your file with `/env-validate`.

---

## 12. Deeper reading (vault)

Load via `00-index/reading-paths.md` (don't read the whole vault):
`40-backend/module-map.md` · `40-backend/redis-usage.md` · `30-domain/entity-ride-request.md`
· `10-product/features-scheduled-booking.md` · `90-quality/testing-strategy.md` ·
`99-decisions/ADR-0009-single-vps-phase-0.md`. Or query the code graph: `/code-graph`.
