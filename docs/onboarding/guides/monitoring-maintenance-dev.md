# Onboarding guide: monitoring and maintenance developer

You own the answer to "is it healthy, and how will we know when it is not?": the metrics the API
exports, the dashboards, logs, alerts, health and version endpoints, the outbox and reconciler signals,
and the recurring maintenance (backups, restore drills, dependency hygiene). You work closely with the
backend owner (who adds metrics) and the DevOps owner (who runs the stack and the release pipeline).

Back to the [onboarding index](../README.md). Facts were checked against the code on branch
`onboarding/walkthrough`. Where the vault says something different from the code, the code wins, and the
differences are called out in section 5.

---

## 1. Day-1 / week-1 checklist

### Day 1: see the signals

1. Read [`CLAUDE.md`](../../../CLAUDE.md) (ports, commands), then vault
   [`80-infrastructure/observability.md`](../../../80-infrastructure/observability.md) and
   [`90-quality/performance-budget.md`](../../../90-quality/performance-budget.md).
2. Bring up the stack **with** the observability profile and smoke it:

   ```bash
   pnpm dev:up              # includes the `obs` profile (use dev:up:slim to skip it)
   pnpm dev:smoke           # api / -> 200
   pnpm obs:smoke           # generates traffic, waits for Prometheus to have http_request_duration_seconds_count
   ```

3. Open the tools (dev credentials: Grafana `admin` / `admin`):

   | Tool | URL | Notes |
   |---|---|---|
   | API metrics | http://localhost:3000/metrics | raw Prometheus text |
   | Prometheus | http://localhost:9090 | Status, Targets must show `api` UP |
   | Grafana | http://localhost:3001 | 5 provisioned dashboards (section 3) |
   | Uptime Kuma | http://localhost:3003 | first run: `pnpm setup:uptime-kuma` creates the admin and the `/v1/health/ready` monitor |
   | Loki, Alertmanager, OSRM | **no host port** | reach them inside the compose network, for example `docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec -T api sh -c 'curl -s http://osrm:5000/...'`. Grafana already has Loki as a datasource. |

4. Generate real traffic so the business dashboards are not empty: seed drivers (`./scripts/seed-dev.sh --keepalive`),
   then drive a booking from the web app, or replay the realistic k6 workload
   (`pnpm load:prepare && pnpm test:load:workload`).
5. Watch the ops videos: [`../videos/ops/INDEX.md`](../videos/ops/INDEX.md), scenes **M01** (Grafana dispatch and
   API dashboards under live traffic), **M02** (Prometheus targets and a business-metric query), **M03** (Loki logs by
   request id), **M04** (Uptime Kuma), **M05** (Alertmanager), **M06** (dev tooling: smoke check, redis/pool inspect,
   restore drill).

### Week 1: first checks and a first change

| Step | How | Expected |
|---|---|---|
| Health | `curl -s localhost:3000/v1/health/ready \| jq` | `{ok, postgres, redis, osrm}` all true |
| Build identity | `curl -s localhost:3000/v1/health/version \| jq` | `version: "dev"` locally; the commit SHA in release images |
| Find one request in logs | Grafana, Logs dashboard, set the `request_id` variable (take it from any `x-request-id` response header) | the `request` log line plus anything logged with that id |
| Query a business metric | Prometheus: `sum(rate(rcab_dispatch_outcome_total[5m])) by (outcome, kind)` | a series per outcome after a booking |
| Run the monitoring tests | `pnpm --filter @rcab/api test -- src/modules/metrics src/common/middleware/metrics.middleware.spec.ts` and `pnpm --filter @rcab/api test:int -t "business"` | green |
| Smoke prod-like compose | `pnpm prod:test` (builds, smokes, tears down; needs Docker and a few GB) | exits 0 |
| Rehearse backup and restore | `scripts/recovery/backup-rehearsal.sh` | PASS (fixture data, no secrets) |

First small change (suggested): add a panel to `infra/observability/grafana/dashboards/dispatch.json` for a
metric that exists but is not charted (for example `rcab_busy_drivers` or `rcab_ws_connections`), reload
Grafana, and confirm it renders under traffic. Dashboards are provisioned from the repo, so the file is the
source of truth; edits made in the Grafana UI are lost on re-provision unless you export the JSON back.

---

## 2. What you own and the mental model

```
 api (prom-client, pino) --/metrics--> Prometheus --rules--> Alertmanager --(receiver: none yet)
        |  JSON logs on stdout                  |
        +--> Docker --> Promtail --> Loki       +--> Grafana  <-- Loki
 Uptime Kuma --> GET /v1/health/ready (synthetic)
 Backup container --> nightly encrypted dump --> /opt/rcab/backups (+ optional offsite)
```

Principles the code follows (read the header comment of `apps/api/src/metrics.ts`):

1. A metric must have a real call site at an authoritative state change (after the transaction committed) or in
   the periodic sampler. A metric nothing updates is deleted.
2. Labels come from small closed vocabularies. Never a user, ride or driver id, coordinate, token or raw URL path.
   HTTP uses the **route template** (`/v1/rides/:id`), or the fixed label `unmatched` for 404s and scanners.
3. Event counters count committed changes once; retries and attempts are counted separately
   (`rcab_outbox_publish_total{result}`).
4. **Absent is not healthy.** The sampler removes a gauge whose source it cannot read, so a missing series means
   "we could not measure", not "all quiet". Alert on `absent(...)` for the gauges you depend on.

### Code map

| What | Where |
|---|---|
| All instruments | `apps/api/src/metrics.ts` |
| HTTP histogram and request log line | `apps/api/src/common/middleware/metrics.middleware.ts` (logs `method, route, path, status, duration_ms, request_id`; health routes at debug level) |
| Request id | `apps/api/src/common/middleware/request-id.middleware.ts` (honours incoming `X-Request-Id`, else a UUID; echoed in the response header and in error bodies `{error:{request_id}}`) |
| Sampled gauges | `apps/api/src/modules/metrics/business-metrics.sampler.ts` (active and busy drivers, outbox backlog, shared match rate; every `METRICS_SAMPLE_INTERVAL_MS`, default 15 s) |
| Health, version, metrics endpoints | `apps/api/src/modules/health/health.controller.ts`, `health.service.ts` |
| Outbox and reconciler | `apps/api/src/modules/outbox/` |
| Prometheus, rules, Alertmanager | `infra/observability/prometheus.yml`, `alert_rules.yml`, `alertmanager.yml` |
| Logs pipeline | `infra/observability/promtail.yml`, `loki.yml` |
| Dashboards (provisioned) | `infra/observability/grafana/dashboards/{overview,dispatch,logs,postgres,redis}.json`, datasources in `grafana/provisioning/datasources/datasources.yml` (UIDs pinned: `prometheus`, `loki`) |
| Compose wiring | dev: `infra/docker/docker-compose.dev.yml` (profile `obs`); prod: `infra/docker/docker-compose.prod.yml` |
| Smoke scripts | `scripts/obs-smoke.sh`, `scripts/dev-smoke.sh`, `scripts/prod-smoke.sh`, `scripts/setup-uptime-kuma.ts` |
| Recovery and drills | `scripts/recovery/`, [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md) |
| Budgets and load | `infra/load/` (`probe.js`, `workload.js`, `perf-budget.generated.json` generated from policy `perfBudget.*`) |

### Metrics catalogue (`apps/api/src/metrics.ts`)

| Metric | Type | Labels | Meaning and what to watch |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `method, route, status_code` | RPS, error rate (5xx) and latency percentiles. Budget: p50 <= 120 ms, p95 <= 400 ms, p99 <= 800 ms, 5xx <= 0.5%. |
| `rcab_dispatch_latency_seconds` | histogram | `stage, kind` | `intent_to_first_offer` (outbox row to first offer, includes relay and queue delay) and `offer_to_accept`. Budget: request to first offer p50 <= 1 s, p95 <= 3 s. |
| `rcab_dispatch_outcome_total` | counter | `outcome, kind` | Verdict per dispatch generation: `assigned, no_driver, pool_aborted, scheduled_retry, scheduled_no_driver, cancelled, infra_failure`; `kind` is `solo` or `pool`. `infra_failure` means a BullMQ job exhausted its attempts. |
| `rcab_ride_state_transition_total` | counter | `from, to` | Committed ride transitions (`from=none` for the creating insert). A stalled `accepted -> en_route` shows here first. |
| `rcab_pool_joins_total` | counter | `result` | Seat requests: `opened`, `joined` are committed; others are typed refusals (`pool_full, pool_closed, not_found, already_member, idempotent_replay, passenger_has_active_pool, conflict`). |
| `rcab_pool_closures_total` | counter | `reason` | `closed_full, closed_timeout, aborted_empty`. |
| `rcab_shared_match_rate` | gauge | none | Share of riders in pools closed within the window (default 15 min) who rode with at least one other rider. Absent when no pool closed. |
| `rcab_outbox_pending` | gauge | none | Outbox rows not yet published or exhausted. |
| `rcab_outbox_oldest_pending_age_seconds` | gauge | none | Age of the oldest **due** unpublished row (0 when nothing is due). The key "work is stuck" signal. |
| `rcab_outbox_exhausted` | gauge | none | Rows that used up their publish attempts; need the reconciler or an operator. Should be 0. |
| `rcab_outbox_publish_total` | counter | `result` | Attempts: `published, retry, exhausted, lost_lease`. A rising `retry` rate means BullMQ or Redis trouble. |
| `rcab_active_drivers` | gauge | none | Members of the Redis geo index (presence is swept after 60 s without a heartbeat). |
| `rcab_busy_drivers` | gauge | none | Rows in `driver_active_assignment` (Postgres). Compare with active: drivers busy but not active is normal; large divergence is not. |
| `rcab_ws_connections` | gauge | none | Authenticated WebSocket connections **on this node**. |
| default `process_*`, `nodejs_*` | various | | `collectDefaultMetrics()`; event loop lag and heap are your first suspects for latency. |

Adding a metric: define it in `metrics.ts` with a closed label type, record it at the commit that made it true
(or in the sampler), add a unit test, and add a panel. Do not add a metric nobody reads.

### Health and version endpoints

| Endpoint | Meaning |
|---|---|
| `GET /v1/health/live` | process is up (`{ok:true}`); use for container liveness |
| `GET /v1/health/ready` (and `GET /`) | 200 only if Postgres `SELECT 1`, Redis `PING` and OSRM `/nearest` (1 s timeout) all succeed; otherwise 503 with the per-dependency booleans. Use for Uptime Kuma and deploy verification. |
| `GET /v1/health/version` | `{version, builtAt}`; the commit SHA in release images, `dev` in local builds. The release pipeline asserts it equals the deployed SHA. |
| web `GET /version.json` | same shape, baked into the web image |
| `GET /metrics` | Prometheus exposition |

### Logs

- pino JSON on stdout (`service: "api"`), level from `LOG_LEVEL` (info in production, debug otherwise).
- The per-request line has `request_id`; Promtail extracts `request_id` and `level` into Loki labels. Dashboard
  **Logs** has a `request_id` variable; the raw query is
  `{container=~".*api.*"} | json | request_id = "<id>"`.
- Reconciler and outbox warnings to search for: `reconcile repaired missing durable work` (carries the
  `ReconcileReport` counts), `outbox backlog`, `reconcile step failed; next pass retries`,
  `boot reconcile failed`, `periodic reconcile failed`.
  Example: `{container=~".*api.*"} | json | msg=~"reconcile.*|outbox backlog"`.

---

## 3. Key workflows for this role

Workflow documents are in [`../workflows/`](../workflows/README.md) (see [incident and recovery](../workflows/incident-and-recovery.md), [debugging and tooling](../workflows/debugging-and-tooling.md), [release and deploy](../workflows/release-and-deploy.md)), behaviour per area in
[`../functionality/`](../functionality/) (start with [realtime protocol](../functionality/realtime-protocol.md)), the machines your metrics describe in
[`../state-machines.md`](../state-machines.md). Videos: ops scenes M01 to M06
([`../videos/ops/INDEX.md`](../videos/ops/INDEX.md)); watch W03 and W07 on the web side to see which signals a
normal and a shared ride produce.

### 3.1 Is the platform healthy right now? (5-minute check)

1. `GET /v1/health/ready` on the public API host: which dependency is false?
2. Grafana **Overview**: RPS, error rate, latency, active drivers.
3. Grafana **Dispatch**: outcomes (a spike in `no_driver` with low `rcab_active_drivers` is a supply problem,
   not a bug), latency by stage, **outbox panels** (`rcab_outbox_pending`, oldest due age, publish results).
4. Uptime Kuma: green history for the `/v1/health/ready` monitor.
5. Backup marker: `ls -l /opt/rcab/backups/.last_success` is within the last 24 h; `.last_offsite_failure` does
   not exist (if offsite is enabled).

### 3.2 A rider says "my ride is stuck"

1. Get the ride id or the request id (a failed API call returns `request_id` in the error body).
2. Logs dashboard by `request_id`; then search the ride id in the api logs.
3. Check the authoritative row, not Redis: `/pool-inspect` for pools, or SQL on `rides`, `dispatch_offer`,
   `outbox` (pending rows for that aggregate id).
4. `rcab_outbox_oldest_pending_age_seconds` high: the relay or Redis is the problem; `rcab_outbox_exhausted` > 0:
   look at the failing topic in the logs. Do not delete rows or "cancel stuck rides" by SQL; the reconciler runs at
   boot and every 5 minutes and repairs missing timers and unpublished work. Wait one cycle first
   ([runbook section 5](../../operations/recovery-runbook.md)).
5. Offers expired or lost races are normal outcomes (`ride_offer_outcome`), not incidents.

### 3.3 Redis lost or restarted

Availability problem only. Symptoms: no drivers online, no offers, stale pools. Restart the api (it rebuilds
projections, re-arms timers) and ask drivers to go online again. Details and the proof drill:
[runbook section 5](../../operations/recovery-runbook.md), `scripts/recovery/redis-loss-drill.sh`.

### 3.4 `migration_conflict` rows

After migrations 0014 and 0016, conflicts are stored instead of guessed. List open ones:

```sql
SELECT id, migration, kind, subject, detail, detected_at
  FROM migration_conflict WHERE resolved_at IS NULL ORDER BY id;
```

A person must resolve each (`scripts/recovery/resolve-driver-conflict.sql` for double-assigned drivers). Never
auto-cancel trips. Full procedure: [runbook section 6](../../operations/recovery-runbook.md). The invariant SQL I1
to I9 (all must return zero rows) is in `docs/remediation/stage-c-contract.md` section 6; the restore drill runs it
for you.

### 3.5 Backup and restore

- Backups: nightly 21:00 UTC (02:30 IST), `pg_dump -Fc` piped into `age`, manifest written last, 30 daily + 12
  monthly retained locally, optional rclone offsite (off by default). **RPO is up to about 24 h and RTO is not
  proven on production-sized data.** Offsite is optional and off by default: without it, losing the VPS disk
  loses the backups too.
- Restore drill on a **real** backup (run from an operator machine that holds the age identity, never from the
  VPS): `scripts/recovery/restore-drill.sh --dir <backup dir> --identity <identity file>`. Record every real drill
  in the table in the runbook (date, dump size, restore seconds, total minutes, who).
- Fixture rehearsal (no secrets): `scripts/recovery/backup-rehearsal.sh`; Jenkinsfile.nightly runs it on the 1st
  of each month.
- The age identity must live off the VPS. If nobody can find it, every encrypted backup is unreadable. Test that
  you can find it.

### 3.6 Maintenance calendar

| Cadence | Task | How |
|---|---|---|
| Every deploy | Verify the release | `verify-release.sh` runs inside `deploy.sh`; confirm `/v1/health/version` equals the SHA and watch error rate and outbox gauges for 15 minutes |
| Daily | Glance at Overview, Dispatch (outbox panels), Kuma; confirm the backup marker is fresh | section 3.1 |
| Daily | Check the nightly Jenkins job (`Jenkinsfile.nightly`: e2e + load against an isolated stack) | Jenkins UI; a red nightly is a real finding |
| Weekly | Open `migration_conflict` rows, reconciler warnings, exhausted outbox rows, 5xx by route | Loki and SQL above |
| Weekly | Disk and volume growth on the VPS (Postgres, Loki, Prometheus 30 d retention, backups) | `docker system df`, `df -h`, `/docker-stats` skill |
| Weekly | Dependency advisories | `/security-scan` (npm audit + secret scan); Dependabot-style bumps for patch and minor versions are allowed without a stop |
| Monthly (2nd, 06:00 suggested) | **Restore drill on the newest real backup** | `scripts/recovery/restore-drill.sh` (cron example in the runbook section 3) and record the result |
| Monthly (1st) | Fixture backup rehearsal | runs automatically in the nightly job |
| Monthly | TLS certificate expiry and certbot renewal | no alert exists yet (see tasks); check the cert on the public host |
| Quarterly | Full-host-loss tabletop using runbook section 7; confirm the age identity and secrets store are retrievable | owner involved |
| Quarterly | Review load budget with `pnpm test:load:workload` against the target VPS class (E8.S5) | compare with `docs/POLICY.md` "Performance budget" |
| On owner schedule | Secret rotation | follows `80-infrastructure/secrets-management.md`; **HITL** |

---

## 4. Conventions and gotchas

- **Dashboards are code.** Edit the JSON under `infra/observability/grafana/dashboards/`, keep datasource UIDs
  `prometheus` and `loki` (a past bug: unpinned UIDs made every panel empty; see
  `docs/manual-testing/findings-2026-06-15.md`).
- **Only some panels have data today.** Overview, Dispatch and Logs query real metrics. The **Postgres** and
  **Redis** dashboards query `pg_*` and `redis_*` series that need exporters. The committed Prometheus config
  scrapes only the `api` job; this branch adds dev-only `redis-exporter` and `postgres-exporter` services and a
  `scrape.d` drop-in (`infra/observability/scrape.dev/exporters.yml`), while the production compose has no
  exporters. Expect empty Postgres and Redis panels in production until that is decided (task 1 below).
- **Production access to the tools.** In the prod compose Grafana, Prometheus, Alertmanager, Loki and Uptime Kuma
  publish **no host ports** and nginx has no vhost for them (only `api` and `app`). Reach them from the VPS over an
  SSH tunnel to the container network or via `docker compose exec`; this access path is not yet documented or
  automated. Treat that as a gap, not an oversight to work around by opening a port.
- **`/metrics` is public in prod.** nginx's `location /` on the API vhost proxies every path, including `/metrics`,
  so the exposition is reachable on the public API hostname although the vault says it is internal-only. Prometheus
  scrapes `api:3000` directly, so blocking it at nginx is safe. This is a DevOps fix to schedule (E8.S6).
- **Alerting is not live.** `alert_rules.yml` defines only `ApiHighErrorRate` (5xx > 1% for 5 min, critical) and
  `ApiHighP99Latency` (p99 > 1.5 s for 10 min, warning; deliberately looser than the 800 ms load-test budget).
  `alertmanager.yml` has a single receiver named `default` with no Slack, email or webhook, so nothing is
  delivered. Postgres, Redis, disk, dispatch-failure and certificate alerts from the design are not defined.
  Vault `observability.md` describes the design as if it were built; trust the YAML. This is RCAB-E8.S2 (draft).
- **Uptime Kuma** setup script uses default dev credentials (`admin` / `admin1234!`, overridable with `KUMA_USER`
  and `KUMA_PASS`). Change them for any shared or production instance. Slack notification is configured by hand in
  the Kuma UI once an owner supplies a webhook (a secrets-handling step; HITL).
- **Loki labels.** Promtail promotes `request_id` to a Loki **label**, which is high-cardinality and against Loki
  guidance; it works at Phase-0 volume but keep it in mind before adding more promoted fields. Retention: Loki
  rejects samples older than 168 h; Prometheus keeps 15 d in dev and 30 d in prod.
- **Cardinality and PII.** Never add a label with an id, phone, coordinate or path. Logs must not carry tokens or
  phone numbers (the security checklist still lists "no PII in logs" as unverified).
- **Per-node gauges.** `rcab_ws_connections` is per api process; Phase-0 has one node. If a second node is ever
  added, sum across instances in queries.
- **Business gauges vs events.** Outcomes and transitions are counters recorded at commit; active/busy drivers,
  outbox backlog and match rate are sampled (15 s). A freshly restarted api resets counters; use `rate()` and
  `increase()`, never raw values.
- **Dev presence expires.** Seeded drivers vanish from `rcab_active_drivers` after about 60 s; use
  `./scripts/seed-dev.sh --keepalive` while building dashboards.
- **Quality gates for this area:** `pnpm lint`, the metrics unit tests, `pnpm test:int` (includes
  `business-metrics.int.spec.ts`), `pnpm obs:smoke`, `pnpm prod:test`, and for load `pnpm test:load` (probe) /
  `pnpm test:load:workload` (needs `pnpm load:prepare` first). Commit as `<type>(infra|api): ...` with a
  `Story:` trailer.

---

## 5. Escalate (HITL) before you act

From [`95-delivery/hitl-touchpoints.md`](../../../95-delivery/hitl-touchpoints.md):

- **Secrets:** Slack webhooks, Grafana admin passwords, SMTP or pager credentials, rotating the JWT key,
  the backup age identity. Anything touching `80-infrastructure/secrets-management.md` needs the owner.
- **A new external service with cost or lock-in** (hosted Grafana, Datadog, PagerDuty, Sentry, an offsite backup
  vendor). The repo deliberately uses a self-hosted stack under ADR-0009.
- **Deploying to a real VPS**, and any restore onto production data (decide RPO consciously, fence the old host).
- **Accepting the RPO/RTO** (24 h and unproven): this is a business decision, not a tuning knob.
- **A flaky test or smoke** you want to quarantine rather than fix.
- **Changing what a dashboard or alert is allowed to page for** when it changes acceptance criteria of a story.
- Never "fix" a stuck ride, `migration_conflict` row or pool by editing rows to make a graph go green; a person
  decides, with a backup taken first.

---

## 6. First 5 good tasks (from real open gaps)

1. **RCAB-E8.S2: real alerts and a receiver.** Add rules for outbox stuck
   (`rcab_outbox_oldest_pending_age_seconds > 60` for 5 min), exhausted rows (`rcab_outbox_exhausted > 0`),
   `absent(rcab_outbox_pending)`, dispatch failure ratio
   (`rate(rcab_dispatch_outcome_total{outcome=~"no_driver|infra_failure"}[15m])` over all outcomes > 5%),
   active drivers at zero during service hours, backup marker age, disk free and certificate expiry. Wire an
   Alertmanager receiver (webhook or Slack) using a secret supplied by the owner (HITL). Test with `promtool
   check rules` and by firing a rule on purpose.
2. **RCAB-E8.S1: make every Grafana panel real in production.** Decide on `redis_exporter` and `postgres_exporter`
   for the prod compose (small, self-hosted; confirm with the DevOps owner), move the dev drop-in pattern to prod,
   and add dashboard panels for the metrics that are not charted yet (`rcab_busy_drivers`, `rcab_ws_connections`,
   pool closures).
3. **Document and automate production access** to Grafana, Prometheus and Kuma (SSH tunnel recipe or a
   password-protected, TLS-terminated nginx vhost with the owner's approval), and close the public `/metrics`
   exposure.
4. **Backup health signal (runbook section 8, last bullet).** The backup healthcheck and alerting are not wired.
   Export the age of `.last_success` and `.last_offsite_failure` (a tiny textfile exporter or a Kuma push
   monitor) and alert on staleness; then run the first monthly restore drill on a real backup and record it.
5. **Log hygiene audit.** Verify no tokens, phone numbers or Firebase ID tokens reach the logs (grep the Loki
   output after exercising W02/W03), decide whether `request_id` should remain a Loki label, and tick the matching
   items in `90-quality/security-checklist.md` with evidence. Also correct the stale lines in vault
   `observability.md` (see below).

Known documentation drift to correct (kept out of this pack because another change is editing that note):
`80-infrastructure/observability.md` says the request log line includes `user_id` (it does not), that
`rcab_shared_match_rate` is computed every 5 minutes (it is sampled every 15 s over a 15 min window), that
`/metrics` is bound only on the internal network (it is proxied publicly), and its metric list omits
`rcab_pool_*`, `rcab_outbox_*` and `rcab_busy_drivers`.

---

## 7. References

| Topic | Where |
|---|---|
| Orientation | [`CLAUDE.md`](../../../CLAUDE.md), [`00-index/HOME.md`](../../../00-index/HOME.md), [`00-index/reading-paths.md`](../../../00-index/reading-paths.md) |
| Architecture, ports, topology | [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) sections 2 and 6 |
| Recovery, backup, drills, conflicts | [`docs/operations/recovery-runbook.md`](../../operations/recovery-runbook.md) |
| Outbox, invariants I1 to I9, lock rules | [`docs/remediation/stage-c-contract.md`](../../remediation/stage-c-contract.md) |
| Tunables incl. outbox cadence, sampler, perf budget | [`docs/POLICY.md`](../../POLICY.md) (`outbox.*`, `observability.*`, `perfBudget.*`) |
| Release identity and verification | [`scripts/deploy/README.md`](../../../scripts/deploy/README.md) |
| Observability design note (see drift above) | [`80-infrastructure/observability.md`](../../../80-infrastructure/observability.md), [`backups.md`](../../../80-infrastructure/backups.md) |
| Budgets and security checklist | [`90-quality/performance-budget.md`](../../../90-quality/performance-budget.md), [`security-checklist.md`](../../../90-quality/security-checklist.md) |
| Bring-up and hand walks | [`docs/manual-testing/RUN-GUIDE.md`](../../manual-testing/RUN-GUIDE.md) |
| Skills | `/smoke-check`, `/api-smoke`, `/redis-inspect`, `/pool-inspect`, `/docker-stats`, `/osrm-check`, `/k6-load`, `/security-scan` (in `.claude/skills/`) |
| Sibling guides | [`backend-dev.md`](backend-dev.md), [`devops-dev.md`](devops-dev.md) |
