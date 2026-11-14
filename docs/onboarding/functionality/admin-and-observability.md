# Admin and observability

What an operator can see and do in Phase-0. There is **no admin UI and no admin API**: administration is SQL, scripts and the observability stack. This page lists the health endpoints, the metrics, the logs, the dashboards, the alert and uptime setup, and the operator tooling.

Back to [README](../README.md) · see also [idempotency-and-durability](idempotency-and-durability.md) (outbox gauges), [driver-onboarding-and-presence](driver-onboarding-and-presence.md) (provisioning), [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md), [`scripts/deploy/README.md`](../../../scripts/deploy/README.md) · vault: `80-infrastructure/observability.md`, `90-quality/performance-budget.md` · videos M01 to M06 in the [ops index](../videos/ops/INDEX.md).

## Health and version endpoints

| Endpoint | Meaning |
|---|---|
| `GET /v1/health/live` | `{ "ok": true }` while the process runs (liveness) |
| `GET /v1/health/ready` and `GET /` | `{ ok, postgres, redis, osrm }`; 200 only if all three probes pass, else 503. OSRM is probed with `GET <OSRM_URL>/nearest/v1/driving/91.7,26.1` (1 s timeout) |
| `GET /v1/health/version` | `{ version, builtAt }` from `RCAB_VERSION` / `RCAB_BUILT_AT` (commit SHA in release images; `dev` / `unknown` locally). The release pipeline asserts it equals the deployed commit. The web serves the same shape at `/version.json` in release builds |
| `GET /metrics` | Prometheus text. Unauthenticated in the API; the production nginx answers 404 for it on the public vhost (fixed in f581d09), Prometheus scrapes `api:3000` directly |

`pnpm dev:smoke` polls `/` until 200; the `/smoke-check` and `/api-smoke` skills print a per-service table with latencies; `pnpm obs:smoke` generates traffic and waits until Prometheus has `http_request_duration_seconds_count` series.

## Metrics (`apps/api/src/metrics.ts`)

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `method, route, status_code` | Every request. `route` is the Express route **template** (`/v1/rides/:id`), unmatched paths collapse to a fixed label (bounded cardinality) |
| `rcab_dispatch_latency_seconds` | histogram | `stage` (`intent_to_first_offer`, `offer_to_accept`), `kind` | Dispatch speed, measured on the DB clock |
| `rcab_dispatch_outcome_total` | counter | `outcome` (`assigned`, `no_driver`, `pool_aborted`, `scheduled_retry`, `scheduled_no_driver`, `cancelled`, `infra_failure`), `kind` (`solo`, `pool`) | Committed verdict per dispatch generation (replays are not recounted) |
| `rcab_ride_state_transition_total` | counter | `from, to` | Every committed solo ride transition |
| `rcab_pool_joins_total` | counter | `result` (`opened`, `joined`, `pool_full`, `pool_closed`, `not_found`, `already_member`, `idempotent_replay`, `passenger_has_active_pool`, `conflict`) | Shared seat requests |
| `rcab_pool_closures_total` | counter | `reason` (`closed_full`, `closed_timeout`, `aborted_empty`) | Pools leaving `open` |
| `rcab_shared_match_rate` | gauge | | Riders who shared / riders in pools closed within `METRICS_MATCH_RATE_WINDOW_MS` (15 min); removed when there is no data |
| `rcab_outbox_pending`, `rcab_outbox_oldest_pending_age_seconds`, `rcab_outbox_exhausted` | gauges | | Outbox backlog |
| `rcab_outbox_publish_total` | counter | `result` | Relay publish attempts |
| `rcab_active_drivers`, `rcab_busy_drivers` | gauges | | Geo-index members / active assignments |
| `rcab_ws_connections` | gauge | | Authenticated sockets on this node |
| default `process_*`, `nodejs_*` | | | prom-client defaults |

State-shaped gauges are sampled by `BusinessMetricsSampler` every `METRICS_SAMPLE_INTERVAL_MS` (15 s); a source that cannot be read **removes** its series so missing telemetry is distinguishable from "all quiet". Event-shaped metrics are incremented at the commit that made them true.

Try it (video M02): in Prometheus (`http://localhost:9090`) run `sum(rate(rcab_dispatch_outcome_total[5m])) by (outcome, kind)` or `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))`. Targets page: job `api` (`api:3000/metrics`, 10 s) and, in dev only, `redis` and `postgres` exporters from `infra/observability/scrape.dev/exporters.yml`.

## Logs

- The API writes **pino JSON to stdout** (`{ level, time, service: "api", ... }`; level numbers 30 info, 40 warn). Docker captures it; **Promtail** discovers containers over the Docker socket and ships to **Loki** (internal port 3100) with labels `container`, `stream`, `request_id`, `level`.
- Every response carries `x-request-id` (a client-supplied value is honoured). `MetricsMiddleware` writes one `msg: "request"` line per request with `method, route, path, status, duration_ms, request_id` (health and metrics routes at debug level). The error body repeats the id as `error.request_id`.
- Find a request (video M03): Grafana > Explore > Loki, `{container=~".*api.*"} | json | request_id = "<id>"`, or the **Logs** dashboard (`rcab-logs`) with the *Request ID* textbox.
- Retention and storage are Loki defaults (filesystem, 168 h reject-old-samples window); there is no log-based alerting.

## Dashboards (Grafana :3001, `admin`/`admin` in dev, provisioned from `infra/observability/grafana/`)

| Dashboard (uid) | Panels |
|---|---|
| Overview (`rcab-overview`) | API RPS, error rate, latency p50/p95/p99, active drivers |
| Dispatch (`rcab-dispatch`) | latency by stage, outcomes, active and busy drivers, shared match rate, ride state transitions, pool joins and closures, outbox backlog / oldest age / publish results, HTTP p95 by route |
| Postgres (`rcab-postgres`), Redis (`rcab-redis`) | connections, locks, slow queries / memory, ops/sec, blocked clients (from the dev exporters; prod does not run them yet) |
| Logs (`rcab-logs`) | application logs, logs by request id |

Video M01 shows Overview and Dispatch with live traffic.

## Alerts and uptime

- `infra/observability/alert_rules.yml` defines two rules: `ApiHighErrorRate` (5xx ratio > 1 % for 5 min, critical) and `ApiHighP99Latency` (p99 > 1.5 s for 10 min, warning). Prometheus sends to Alertmanager (`alertmanager:9093`, no host port). Alertmanager has one `default` receiver with **no delivery configured**, so alerts are visible only in the Alertmanager/Prometheus UIs (video M05). Slack routing and the remaining alerts (Postgres, Redis, disk, dispatch failure rate, cert expiry) are RCAB-E8.S2.
- Uptime Kuma (:3003) probes `http://api:3000/v1/health/ready`; `pnpm setup:uptime-kuma` (`scripts/setup-uptime-kuma.ts`) creates the admin and the monitor idempotently (defaults `admin` / `admin1234!` for dev only). Notifications are not provisioned (video M04).

## Operating the system without an admin console

| Need | How |
|---|---|
| Promote a driver, suspend a user, fix a row | `psql` / Drizzle Studio (`/drizzle-studio`); examples in [driver-onboarding-and-presence](driver-onboarding-and-presence.md) and [auth-and-sessions](auth-and-sessions.md) |
| Apply migrations | `docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts` (or `/db-migrate`); never auto-applied; a Postgres advisory lock serialises runners |
| Seed fixtures | `./scripts/seed-dev.sh [--reset] [--drivers N] [--offline] [--keepalive]` (`/seed-db`) |
| Inspect Redis / pools | `/redis-inspect`, `/pool-inspect` (Postgres first, then the Redis projection and queue depth) |
| Check OSRM | `/osrm-check`, or `docker compose ... exec -T api sh -c 'curl http://osrm:5000/route/v1/driving/...'` |
| Capacity | `/docker-stats`, `pnpm system:probe`, `pnpm test:load` / `/k6-load` against the budget in [POLICY](../../POLICY.md#performance-budget-load-test-gates) |
| Backup / restore / Redis-loss drills | `scripts/recovery/*` and the [recovery runbook](../../operations/recovery-runbook.md) (video M06 shows the drills as terminal recordings) |
| Release / rollback | `scripts/deploy/*` ([README](../../../scripts/deploy/README.md)); real VPS deploys are a HITL stop |
| Security sweep | `/security-scan`, checklist `90-quality/security-checklist.md` |

## Policy knobs

[Observability sampling](../../POLICY.md#observability-sampling): `METRICS_SAMPLE_INTERVAL_MS`, `METRICS_MATCH_RATE_WINDOW_MS`. [Performance budget](../../POLICY.md#performance-budget-load-test-gates) (k6 gates only; the API does not read them). `LOG_LEVEL` (default `debug` in dev, `info` when `NODE_ENV=production`).

## Code entry points

`modules/health/*`, `metrics.ts`, `modules/metrics/business-metrics.sampler.ts`, `common/middleware/{request-id,metrics}.middleware.ts`, `common/filters/app-exception.filter.ts`, `logger.ts`, `main.ts`; `infra/observability/*`; `scripts/{obs-smoke.sh,dev-smoke.sh,setup-uptime-kuma.ts,system-probe.mjs}`.

## Tests

`health-version.spec.ts`, `metrics.middleware.spec.ts`, `business-metrics.sampler.spec.ts`; integration `health-ready.int.spec.ts`, `business-metrics.int.spec.ts`, `osrm-connectivity.int.spec.ts`; `app.spec.ts`. Load: `infra/load/*` (k6). Smoke scripts double as manual checks.

## Known gaps (found while writing this pack)

1. ~~**Nest `Logger` output is discarded.**~~ Fixed in 74a1b38: `main.ts` calls `app.useLogger(new PinoNestLogger())`, so Nest `warn`/`error`/`log` lines reach pino (stdout and Loki), and the pino logger redacts credential-like fields (`password`, `token`, `accessToken`, `refreshToken`, `secret`, `authorization` and `cookie` headers). 5xx are also logged via pino with the stack (7c31b31).
2. ~~**Validation errors report `code: "internal_error"`.**~~ Fixed in 7c31b31: a `ValidationPipe` 400 now returns `code: "validation_error"` and `OsrmUnavailableException` returns `routing_unavailable`.
3. **The OSRM readiness probe proves less than it looks.** `/nearest/v1/driving/91.7,26.1` snaps to the nearest road anywhere in the loaded graph; the same call for `0,0` (tested on the dev OSRM) returns `Ok` with a waypoint about 1000 km away. Readiness therefore means "OSRM is up with a graph", not "a given trip is routable" (`POST /v1/rides/quote` returns 503 when routing fails). The probe coordinate is Guwahati-specific; harmless today, revisit when the pilot city is chosen (E9).
4. **Only two alert rules and no receiver** (see above); `80-infrastructure/observability.md` already says so but still describes `rcab_shared_match_rate` as "computed every 5 min" (it is sampled every 15 s over a 15 min window).
5. ~~**`/metrics` is reachable through the production nginx.**~~ Fixed in f581d09: `infra/docker/nginx/conf.d/api.conf` has `location = /metrics { return 404; }`; Prometheus still scrapes `api:3000` on the internal network.
6. The `auth` throttle policy text says "exchange / refresh / logout"; in code only the two exchange routes and native logout carry the 10 per minute limit.
7. The web landing page `/` was the Phase-0 scaffold ("rcab - Phase 0 scaffold", stack status) with no link to sign-in; replaced under RCAB-E8.S14 by a landing page with "Book a ride" and "Sign in" links (video W01).
