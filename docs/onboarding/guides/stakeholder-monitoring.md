# Stakeholder guide: Monitoring and on-call

For on-call staff and monitoring owners. Videos in the [ops video index](../videos/ops/INDEX.md): M01 Grafana dispatch/API dashboards with live traffic, M02 Prometheus targets and a business-metric query, M03 Loki logs by request id, M04 Uptime Kuma, M05 Alertmanager, M06 terminal tooling (smoke check, redis/pool inspect, restore drill). Config lives in `infra/observability/`; the design note is `80-infrastructure/observability.md`.

## 1. The stack and where to look

| Tool | Dev URL | Role | Video |
|---|---|---|---|
| Grafana | http://localhost:3001 | Dashboards: overview, dispatch, postgres, redis, logs (`infra/observability/grafana/dashboards/`) | M01 |
| Prometheus | http://localhost:9090 | Scrapes API `/metrics` every 10 s; evaluates alert rules | M02 |
| Loki + Promtail | inside the compose network only | Logs; search by `request_id` (every request gets an `x-request-id`) | M03 |
| Uptime Kuma | http://localhost:3003 | Probes `/v1/health/ready` every 60 s | M04 |
| Alertmanager | inside the compose network only | Routes alerts (receiver not wired yet) | M05 |

In production, reach internal-only services over the VPS network, not a public port.

## 2. Key metrics and what normal looks like

| Metric (Prometheus name) | Meaning | Normal |
|---|---|---|
| `http_request_duration_seconds` (labels method, route template, status_code) | API latency and error rate | p95 under 400 ms, p99 under 800 ms, 5xx under 0.5% |
| `rcab_dispatch_latency_seconds` (stage: intent_to_first_offer, offer_to_accept) | How fast offers go out and get taken | Ride request to first offer p95 under 3 s |
| `rcab_dispatch_outcome_total` (outcome, kind) | Verdicts: assigned, no_driver and so on, for solo and shared | Mostly assigned; spikes of no_driver mean supply problem |
| `rcab_ride_state_transition_total` (from, to) | Ride flow through the state machine | Smooth; cancelled and no_show are minority |
| `rcab_active_drivers`, `rcab_busy_drivers` | Online and on-trip drivers | Matches shift size; busy never exceeds active for long |
| `rcab_pool_joins_total`, `rcab_pool_closures_total`, `rcab_shared_match_rate` | Shared-ride health (match rate = riders who shared, over a 15 min window) | Depends on demand; a drop to 0 with joins present is a bug |
| `rcab_outbox_pending`, `rcab_outbox_oldest_pending_age_seconds`, `rcab_outbox_exhausted` | Durable work queue | Pending near 0, oldest age under a minute, **exhausted always 0** |
| `rcab_ws_connections` | Authenticated realtime connections | Tracks drivers plus open passenger screens |

Gauges are sampled every 15 s. Example query for M02: `sum(rate(rcab_dispatch_outcome_total[5m])) by (outcome)`.

### Thresholds (perfBudget policy)

The load-test gates, from `docs/POLICY.md` (category "Performance budget"), are targets that k6 asserts; the running API does not read them:

| Gate | Value |
|---|---|
| API p95 / p99 | 400 ms / 800 ms |
| Quote p95 | 250 ms |
| Dispatch (request to first offer) p95 | 3 s |
| 5xx error rate | 0.5% |
| Business operations that must succeed | 99% |
| Driver location interval simulated | 5 s |

Production alert thresholds are deliberately looser than the budget: see below.

## 3. Alerts and what to do

Implemented in `infra/observability/alert_rules.yml`:

| Alert | Fires when | First actions |
|---|---|---|
| `ApiHighErrorRate` (critical) | 5xx above 1% for 5 min | 1) Check the `ready` endpoint and Kuma. 2) Grafana overview: which route (route label is a template, not a raw id). 3) Loki: filter errors, pick a `request_id`, follow it. 4) If a release just went out, roll back (`scripts/deploy/rollback.sh --previous`, see `scripts/deploy/README.md`). |
| `ApiHighP99Latency` (warning) | p99 above 1.5 s for 10 min | Check Postgres and Redis dashboards for saturation, OSRM health (quotes and shared joins slow when routing is slow), host CPU. |

**Known gap**: Alertmanager has one receiver named `default` with no Slack or email configured, so these alerts are visible in Prometheus/Alertmanager UIs only. Someone must watch them until RCAB-E8.S2 wires delivery. The additional designed alerts (Postgres connections, Redis memory, disk, dispatch fail rate, certificate expiry) do not exist yet; watch those on dashboards.

Manual alert-equivalents until then:

| Condition | Action |
|---|---|
| `rcab_outbox_exhausted` above 0 | Escalate to a developer: run the outbox health queries (I9) in `docs/remediation/stage-c-contract.md` section 6. |
| `rcab_outbox_oldest_pending_age_seconds` above 300 | Check api logs and Redis; restart api; reconciler repairs within about 5 minutes. |
| `rcab_active_drivers` is 0 during shift | Presence expired (Redis flush or api restart) or drivers offline: ask drivers to re-toggle. See recovery runbook section 5. |
| Dispatch `no_driver` spike | Supply issue or OSRM/Redis trouble; check `/osrm-check`, active drivers. |
| Backup marker `.last_success` older than 26 h | Run/inspect the backup container; page DevOps. |

## 4. Runbooks and tooling

- Recovery (Postgres restore, Redis loss, migration conflicts): `docs/operations/recovery-runbook.md`.
- Release, rollback, verify: `scripts/deploy/README.md`.
- Stage-C invariant SQL (audit queries, all must return zero rows): `docs/remediation/stage-c-contract.md` section 6.
- Terminal tooling (M06): `pnpm dev:smoke` (api and dependencies), `/smoke-check`, `/api-smoke`, `/redis-inspect`, `/pool-inspect`, `/osrm-check`, `/docker-stats`, `scripts/recovery/restore-drill.sh`.
- Local dev stack details: `docs/manual-testing/RUN-GUIDE.md`.

## 5. Following one request (M03)

Every response carries an `x-request-id`. In Grafana Explore (Loki), filter on that id to see the request's log lines; metrics logs include `request_id`. Ask the reporter for the time and ride id when no request id is available.

## 6. Escalation

1. Triage using sections 2 and 3 for at most 10 minutes.
2. Page the on-call backend or DevOps developer for: sustained 5xx, exhausted outbox, database or Redis down, failed backup, suspected data loss.
3. Inform the manager for user-visible outages; the owner for security or data-loss incidents.
4. After resolution record what happened (blameless note) and add a drill result to the recovery runbook table if a restore was involved.

No paging tool or rota is configured in the repo; defining it is part of E8.S2 and the pilot launch checklist (E9.S2).
