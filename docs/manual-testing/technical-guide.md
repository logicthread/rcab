# rcab — Technical Guide (What's Built, What to Test)

Read this alongside [`demo-walkthrough.md`](./demo-walkthrough.md). This doc explains **what exists**, **why it's structured this way**, and **what to probe** as you test. Source of truth for architecture lives in the Obsidian vault (`00-index/HOME.md`); this guide is a flattened, testing-focused view of just the shipped parts.

---

## 1. System at a glance

```
                                ┌──────────────┐
                                │  Firebase    │  (phone OTP only)
                                │   Auth       │
                                └──────┬───────┘
                                       │ ID token
                                       ▼
┌──────────┐   HTTPS+WS   ┌────────────────────────┐    Postgres   ┌──────────┐
│ Web app  │◄────────────►│        API             │◄─────────────►│ Postgres │
│ Next.js  │              │     NestJS (3000)      │               │ 16       │
│  :3001   │              │  HTTP + Socket.IO WS   │               └──────────┘
└──────────┘              │                        │    Redis      ┌──────────┐
                          │ ┌────────────────────┐ │◄─────────────►│  Redis   │
┌──────────┐   HTTPS+WS   │ │  modules below     │ │   pub/sub +   │  7       │
│  Driver  │◄────────────►│ └────────────────────┘ │   GEO + JWT   └──────────┘
│ Flutter  │              │                        │    HTTP       ┌──────────┐
└──────────┘              └────────────┬───────────┘◄─────────────►│  OSRM    │
                                       │                           │ routing  │
                                       ▼                           └──────────┘
                              ┌──────────────────┐
                              │ Loki/Promtail    │
                              │ Prometheus       │
                              │ Grafana :3002    │
                              │ Uptime-Kuma :3003│
                              └──────────────────┘
```

**Phase-0 contract:** everything runs on **one VPS** under **one `docker-compose`** file. No Kubernetes, no managed cloud anything. This is intentional (ADR-0009).

---

## 2. Repository layout

```
rcab/
  apps/
    api/          NestJS 10, port 3000
    web/          Next.js 14 app router, port 3001
    driver-app/   Flutter (Riverpod, Dio, Socket.IO, Firebase Auth)
  packages/
    shared/       Cross-app TS types + Zod schemas (single source of truth for DTOs)
    api-client/   Typed HTTP/WS client used by web (and tests)
    test-fixtures/ Seed data + scenario helpers
  infra/
    docker/       compose files: dev, test, prod, prod-test
    nginx/        reverse proxy for prod
    postgres/     init scripts
    backup/       pg_dump container (E8 territory; placeholder today)
  scripts/        bring-up + smoke + system probes
  00-index/ … 99-decisions/    Obsidian vault — architecture and delivery
  .claude/skills/              Project-specific Claude Code skills
```

---

## 3. Backend — API modules

Located in `apps/api/src/modules/`. Each module is a NestJS module: controller (HTTP) + gateway (WS where relevant) + service (logic) + repository (Drizzle).

| Module | What it does | Built in | Key endpoints / events |
|---|---|---|---|
| `health` | Liveness + readiness probes, Prometheus metrics | E1 | `GET /v1/health/live`, `GET /v1/health/ready`, `GET /metrics` |
| `auth` | Firebase ID-token exchange → rcab JWT; refresh + revocation; Google link/login | E2 | `POST /v1/auth/firebase-exchange`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `POST /v1/auth/google/{login,link}` |
| `vehicles` | Vehicle CRUD per driver | E3 | `POST /v1/vehicles`, `GET /v1/vehicles`, `PATCH /v1/vehicles/:id` |
| `drivers` | Online/offline toggle, vehicle update, presence-write side effect | E3 | `POST /v1/drivers/online`, `POST /v1/drivers/offline`, `PATCH /v1/drivers/me/vehicle` |
| `realtime` | Socket.IO gateway for driver location stream, ride subscription, offer responses, stop confirmations | E3, E4, E5 | WS events: `driver:location`, `ride:subscribe`, `ride_offer_response`, `stop:pickup_confirmed`, `stop:drop_confirmed` |
| `pricing` | Fare quote computation; per-seat split for shared rides | E4, E5 | (internal; surfaced via `/v1/rides/quote`) |
| `rides` | Quote, request (with idempotency key), read | E4 | `POST /v1/rides/quote`, `POST /v1/rides`, `GET /v1/rides/:id`, `GET /v1/rides/:id/stops` |
| `dispatch` | Geo-candidate pick + offer fan-out + claim + wave-2 + hard-fail | E4 | Background — driven by ride request; emits offers over WS |
| `ride-lifecycle` | State machine: `accepted → en_route → arrived → in_progress → completed`; cancellation paths; no-show timer | E4 | `POST /v1/rides/:id/state`, `POST /v1/rides/:id/cancel` |
| `matching` | Route similarity scorer; slot-vs-open decision for shared rides | E5 | Internal — used by pool lifecycle |
| `rating` | Two-sided rating insert post-completion; aggregation deferred to E7 | E4.S9 | `POST /v1/rides/:id/ratings` |

### State machine (solo ride)

```
        request
          │
          ▼
    ┌─────────┐  driver accept   ┌──────────┐  start  ┌──────────┐
    │ pending │─────────────────►│ accepted │────────►│ en_route │
    └────┬────┘                  └────┬─────┘         └────┬─────┘
         │                            │ cancel             │ arrived
         │ no driver / cancel         ▼                    ▼
         │                       ┌───────────┐        ┌──────────┐
         └──────────────────────►│ cancelled │        │ arrived  │
                                 └───────────┘        └────┬─────┘
                                                          │ begin
                                                          ▼
                                                    ┌───────────┐ complete  ┌───────────┐
                                                    │ in_progress├──────────►│ completed │
                                                    └───────────┘           └───────────┘
```

Cancellation can happen from any pre-`completed` state. No-show timer fires after `arrived` if begin doesn't follow within window.

### Shared-ride pool lifecycle (E5)

```
request (share=true)
    │
    ▼
 score against open pools (matching)
    │
    ├── score > threshold ─► attach to pool ──► pool size hit OR open-ttl elapsed ──► close ──► dispatch
    │
    └── no match ─► open new pool ──► (waits for grow window) ──► same close path
```

### Realtime channels (Socket.IO)

| Event | Direction | Sender → Receiver | Payload |
|---|---|---|---|
| `driver:location` | inbound | driver app → API | `{lat, lng, heading, ts}` (throttled to 1 Hz at gateway) |
| `ride:subscribe` | inbound | client/driver → API | `{rideId}` |
| `ride_offer_response` | inbound | driver → API | `{offerId, accept: bool}` |
| `stop:pickup_confirmed` | inbound | driver → API | `{rideId, stopId}` |
| `stop:drop_confirmed` | inbound | driver → API | `{rideId, stopId}` |
| `ride:state` | outbound | API → subscribers | state-machine transition |
| `ride:location` | outbound | API → client | driver position during active ride |
| `pool:update` | outbound | API → client | pool size / seat count changes |

Gateway lives in `apps/api/src/modules/realtime/realtime.gateway.ts`.

---

## 4. Data — Postgres schema

Drizzle ORM. Schema files under `apps/api/src/modules/*/schema.ts`. Open `/drizzle-studio` to browse.

Core tables (shipped):

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | Phone-OTP'd users (clients) | `id`, `phone`, `created_at`, `firebase_uid` |
| `drivers` | Driver profile | `id`, `user_id`, `online`, `last_seen_at` |
| `vehicles` | Per-driver vehicle | `id`, `driver_id`, `plate`, `make`, `model`, `seats` |
| `rides` | One row per ride (solo or shared) | `id`, `client_id`, `driver_id`, `state`, `pickup_geom`, `drop_geom`, `quoted_fare`, `final_fare`, `share` |
| `ride_stops` | For shared rides — ordered pickups + drops | `ride_id`, `seq`, `kind`, `passenger_id`, `geom`, `done_at` |
| `ride_events` | Audit trail of state transitions | `ride_id`, `from_state`, `to_state`, `ts`, `actor_id` |
| `dispatch_offers` | One row per offer made | `id`, `ride_id`, `driver_id`, `expires_at`, `outcome` |
| `pools` | Shared-ride pools | `id`, `state`, `seats_filled`, `open_until`, `route_centroid` |
| `ratings` | Two-sided rating rows | `ride_id`, `rater_id`, `ratee_id`, `score`, `comment`, `created_at` |
| `jwt_revocations` | Logout / refresh-bumping | `jti`, `revoked_at` |

(Open Drizzle Studio for the authoritative shape — column names may have drifted slightly.)

### Migrations

```bash
/db-migrate status        # what's pending
/db-migrate generate      # diff schema → SQL
/db-migrate migrate       # apply
```

Migrations live in `apps/api/drizzle/`.

---

## 5. Redis usage — three namespaces

Inspect with `/redis-inspect`.

| Namespace | Key shape | Used by | TTL/Eviction |
|---|---|---|---|
| Driver geo | `ZSET drivers:geo` (geo-encoded score), `HASH driver:<id>:presence` | E3 location stream; E4/E5 dispatch candidate pick | Pruned on offline, stale entries swept by background sweeper |
| BullMQ queues | `bull:dispatch:*`, `bull:offers:*`, `bull:no-show:*` | E4 dispatch + offers + no-show timer; E5 pool close | Per-job, BullMQ-managed |
| JWT revocation | `SET jwt:revoked:<jti>` | E2 logout / refresh-bumping | TTL = remaining token lifetime |

---

## 6. Frontend — Web (Next.js)

Pages live under `apps/web/src/app/`:

| Route | Purpose |
|---|---|
| `/` | Landing / signed-in home |
| `/signin` | Firebase OTP flow (reCAPTCHA + verify) |
| `/book` | Map (Leaflet + OSM tiles), pick/drop, fetch quote, request ride, watch live state |

Client state via React hooks; API access via `@rcab/api-client`; WS via `socket.io-client`.

Things to test on the web side:
- **Auth state** survives page reload (refresh-token roll).
- **Map**: pan, click to set pickup, click to set drop; quote re-fetches on any pin change.
- **Quote**: shows fare in ₹ + ETA; matches OSRM round-trip latency.
- **Live map**: driver pin updates at ~1 Hz during ride.
- **Cancel** button is enabled until state ≥ `in_progress`.
- **Rating modal** opens once on `completed`, not on re-open of completed ride.

---

## 7. Frontend — Driver app (Flutter)

`apps/driver-app/lib/features/`:

| Screen | Purpose |
|---|---|
| `auth/sign_in_screen.dart` | Phone-OTP |
| `profile/vehicle_form_screen.dart` | Register / edit vehicle |
| `profile/profile_screen.dart` | Profile view |
| `home/home_screen.dart` | Online/offline toggle + earnings glimpse |
| `offer/offer_screen.dart` | Inbound ride offer card with accept/decline + countdown |
| `ride/ride_screen.dart` | Solo-ride state machine UI (start → arrived → begin → complete) |
| `shared_ride/shared_ride_screen.dart` | Multi-stop UI for shared rides |
| `rating/rating_screen.dart` | Post-ride rate-the-passenger |
| `earnings/earnings_screen.dart` | Placeholder — real data lands in E7 |

State: Riverpod. HTTP: Dio with refresh interceptor. WS: socket_io_client. Push: Firebase Messaging.

Things to test on the driver side:
- **Foreground service** notification stays put while online; location updates continue with screen off.
- **OEM-kill mitigation** modal shows correctly per device manufacturer.
- **Offer expiry** countdown is visible and accurate; auto-declines on zero.
- **Multi-stop**: stop completion buttons enable in correct order (no "drop" before its "pickup").
- **Reconnect**: turn airplane mode on for 30 s, off — socket reconnects and re-subscribes to active ride.

---

## 8. Auth flow (end-to-end)

```
Web/Driver app                 API                    Firebase
     │                          │                        │
     │ signInWithPhoneNumber    │                        │
     ├─────────────────────────────────────────────────► │
     │                          │                        │
     │ ID token                 │                        │
     │◄─────────────────────────────────────────────────┤
     │                          │                        │
     │ POST /v1/auth/           │                        │
     │   firebase-exchange      │                        │
     ├─────────────────────────►│                        │
     │                          │  verify ID token       │
     │                          ├───────────────────────►│
     │                          │◄───────────────────────┤
     │                          │  upsert user           │
     │                          │  mint rcab JWT pair    │
     │ {access, refresh-cookie} │                        │
     │◄─────────────────────────┤                        │
     │                          │                        │
     │ ... access expires ...   │                        │
     │                          │                        │
     │ POST /v1/auth/refresh    │                        │
     │ (cookie auto-sent)       │                        │
     ├─────────────────────────►│                        │
     │ new {access}             │                        │
     │◄─────────────────────────┤                        │
```

JWT details:
- **Access token** in `Authorization: Bearer …`. Short TTL (default 15 min).
- **Refresh token** in `rcab_refresh` cookie (`HttpOnly`, `SameSite=Strict`). Longer TTL (default 30 d).
- **Logout** writes `jti` to `jwt:revoked:<jti>` in Redis. Guard checks Redis on every request.

Test:
- Sign in → curl `/v1/rides/quote` with `Authorization: Bearer …` → 200.
- Sign out → same curl → 401.
- Drop the access token TTL to 60 s via env, leave a tab idle 90 s, take an action → should silently roll.

---

## 9. Dispatch internals (E4)

When a ride request lands:

1. **Geo candidate pick** — `GEOSEARCH drivers:geo BYRADIUS <pickup> <radius_m> COUNT <K>` → top-K nearest online drivers.
2. **Fan-out** — N parallel offers go out (`N` defaults to ~3) via WS push + FCM.
3. **Race-to-claim** — first driver to send `ride_offer_response` with `accept=true` wins; others get a revoke.
4. **Wave-2 fallback** — if all offers expire (no accept), expand radius / increase K, fan out again.
5. **Hard-fail** — after wave-2, return `no_drivers` to the client; ride row marked `cancelled` with reason.

To probe:
- Mid-dispatch: `/redis-inspect` shows the BullMQ `offers` queue with job rows per outstanding offer.
- After accept: `dispatch_offers` table has one `accepted` row + N-1 `revoked` rows.
- After wave-2 fail: ride row state = `cancelled`, `cancel_reason='no_drivers'`.

---

## 10. Shared-ride internals (E5)

The interesting modules:

- `matching/route-similarity.ts` — scores two routes by polyline overlap on cached OSRM geometries.
- `matching/decision.ts` — given a new request, decide: attach to an open pool (slot) vs. open a new one (open).
- `pool-lifecycle/*` — pool state machine `open → grown → closed → dispatched → completed`.
- `dispatch/shared/*` — offer carries the full multi-stop sequence (visit order optimized).
- `pricing/shared/*` — per-seat fare = base + (shared discount applied to non-overlapping segments).

To probe:
- During the open window: `/pool-inspect` shows the open pool, seats filled, similarity threshold, time to close.
- After close: the same key disappears; a `pools` row exists with `state='dispatched'`.
- Pricing sanity: solo fare for A's route alone vs. shared fare A pays — should be lower for the shared case (else pricing isn't applying the discount).

---

## 11. Observability (E1 baseline)

| Component | Port | What it sees today |
|---|---|---|
| Prometheus | 9090 | Scrapes `/metrics` from API every 15 s |
| Grafana | 3002 | Pre-loaded dashboards: API latency, request rate, error rate, container memory |
| Loki | (no host port) | Aggregates container logs via Promtail |
| Uptime Kuma | 3003 | Synthetic monitor pinging `/v1/health/live` |

Today the dashboards work but the **alerting rules are not wired** (planned E8.S2). The backup container exists (`infra/docker/backup/`) but the **restore drill is not exercised** (planned E8.S3).

When testing, take screenshots of empty/odd-looking panels — that's the E8 backlog input.

---

## 12. Testing infra (already shipped)

- **Unit tests**: Vitest across `packages/*` and `apps/api`. `pnpm test`.
- **Integration tests**: Testcontainers spins real Postgres + Redis per suite. `pnpm test:int`. **Never** mocks of infra — explicit policy.
- **API smoke**: `pnpm dev:smoke` polls health endpoints; CI runs it post-up.
- **Web e2e**: Playwright. `/playwright-run`.
- **Driver e2e**: Flutter `integration_test`. `/flutter-test integration`.
- **Load**: k6 in a sidecar. `/k6-load`. Not yet validated against the real VPS class (E8.S5).
- **Coverage gates**: 80% API / 70% driver. Run `/coverage`.

What's **not** covered yet:
- Cross-app e2e (web client makes ride, driver app accepts) — exists only as the manual demo above.
- Chaos testing — no fault injection framework.
- Security scan — `/security-scan` exists but the E8.S4 checklist sweep hasn't been done.

---

## 13. Configuration reference

Environment files:
- `.env.dev` — local stack defaults (auto-created by `pnpm dev:up`).
- `.env.dev.example` — committed template; diff yours against it with `/env-validate`.
- `apps/web/.env.local` — Next.js public Firebase config.

Key knobs you'll touch during testing:

| Var | Default | Effect |
|---|---|---|
| `JWT_ACCESS_TTL` | 15m | Drop to 60s to test refresh-roll. |
| `OFFER_TTL_MS` | 12000 | Drop to 3000 to test offer expiry quickly. |
| `DISPATCH_RADIUS_M` | 3000 | Increase to fan out wider. |
| `DISPATCH_CANDIDATES` | 3 | Increase to test concurrent offers. |
| `POOL_OPEN_TTL_MS` | (env) | Time between first request in a pool and close. |
| `POOL_SIMILARITY_THRESHOLD` | (env) | Lower to make rides pool more aggressively. |
| `NO_SHOW_TTL_MS` | (env) | Time at `arrived` before auto-cancel. |

(Real defaults live in `apps/api/src/config/*.ts` — read those to confirm.)

---

## 14. Known gaps (not bugs — just unbuilt)

- **No client app** for booking on mobile — web only. Phase-0 contract.
- **No earnings aggregation** in driver app (screen exists, data is placeholder).
- **No ratings aggregation** — rows insert; mean isn't computed; "New" cold-start displays as fallback.
- **No history page** on web.
- **No scheduled bookings**.
- **No real alerting**; Grafana is read-only today.
- **No backup restore drill**.
- **No production VPS deploy validated** under real load.

Each maps to a future epic. Do not file these as bugs.

---

## 15. Pointers (vault, deeper reads)

When you need to go deeper than this guide:

| Question | Where to read |
|---|---|
| Why is X this way architecturally? | `99-decisions/` (ADRs) |
| What does this module promise? | `40-api/` (API surface) or `30-domains/` (domain notes) |
| What's the testing policy? | `90-quality/testing-strategy.md` |
| What's the performance budget? | `90-quality/performance-budget.md` |
| Why no Kubernetes? | `99-decisions/ADR-0009-single-vps-phase-0.md` |
| What's the security posture? | `90-quality/security-checklist.md` |
| How do I add a new story? | `95-delivery/story-template.md` + `/gen-story` skill |

Load via the reading-paths system (`00-index/reading-paths.md`) — don't read the whole vault.

---

## 16. Cheat sheet — one-liners during testing

```bash
# Bring stack up
pnpm dev:up && pnpm dev:smoke

# Reset DB + seed
pnpm --filter=api tsx scripts/seed/seed.ts --reset --scenario=default

# Inspect driver presence
redis-cli ZRANGE drivers:geo 0 -1 WITHSCORES

# Inspect open shared-ride pools
/pool-inspect

# Watch a ride row evolve
watch -n1 'psql postgres://postgres:postgres@localhost:5432/rcab \
  -c "SELECT id,state,driver_id,quoted_fare FROM rides ORDER BY created_at DESC LIMIT 5"'

# Tail API logs only
docker logs -f rcab_api_dev

# Force a JWT to be revoked (test 401)
redis-cli SET jwt:revoked:<jti> 1 EX 3600

# Snapshot Postgres for a manual diff
docker exec rcab_postgres_dev pg_dump -U postgres rcab > /tmp/before.sql
# ... do the test ...
docker exec rcab_postgres_dev pg_dump -U postgres rcab > /tmp/after.sql
diff /tmp/before.sql /tmp/after.sql
```
