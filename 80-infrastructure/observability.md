---
title: Observability
tags: [layer/infra]
status: accepted
phase: 0
depends_on: [[docker-compose]]
related: [[performance-budget]], [[vps-topology]]
audience: both
---

# Observability

*Logs, metrics, alerts. Phase-0 single-VPS stack: pino + Loki + Promtail + Prometheus + Grafana + Uptime Kuma.*

## Logging

- All Node code uses **pino** with `level=info` in prod, `debug` in dev.
- Logs are JSON to stdout; docker captures; Promtail ships to Loki.
- Request log line includes: `request_id`, `user_id`, `route`, `status`, `duration_ms`.
- `request_id` is created in middleware (`X-Request-Id` if present, else generated). Propagated through `RealtimeBus` to WS events for trace continuity.

## Metrics

- `prom-client` in the API exposes `/metrics` (bound only on the internal network; the public nginx API vhost answers 404 for it, f581d09).
- Standard process metrics + custom:
  - `rcab_dispatch_latency_seconds` (histogram)
  - `rcab_dispatch_outcome_total{outcome}` (counter)
  - `rcab_shared_match_rate` (gauge, computed every 5 min)
  - `rcab_ride_state_transition_total{from,to}` (counter)
  - `rcab_active_drivers` (gauge)
  - `rcab_ws_connections` (gauge)

## Dashboards (Grafana)

- **Overview** — RPS, p50/p95/p99, error rate, active drivers.
- **Dispatch** — latency, outcomes, K-wave usage.
- **Postgres** — connections, locks, slow queries.
- **Redis** — memory, ops/sec, blocked clients.
- **Logs** — Loki panel with request_id search. `request_id` is a parsed JSON field, not a Loki label (one stream per request would exceed Loki's stream limit): query `{container=~".*api.*"} | json | request_id = "<id>"` (`infra/observability/promtail.yml`).

The Postgres and Redis dashboards need exporters. The dev compose runs `redis-exporter` and `postgres-exporter` (obs profile) and Prometheus loads their scrape jobs from `infra/observability/scrape.dev/exporters.yml` via `scrape_config_files`; a stack that mounts nothing there scrapes only `api`. Recorded walkthroughs of every tool: [docs/onboarding/videos/ops/INDEX.md](../docs/onboarding/videos/ops/INDEX.md).

## Alerts (Alertmanager → Slack)

Target alert set (design). **Implementation status (verified against `infra/observability/alert_rules.yml` + `alertmanager.yml`):** only the first two rules are defined; Alertmanager has a single `default` receiver with no Slack/email wiring, so nothing is delivered anywhere yet. Remaining rules and the Slack receiver are RCAB-E8.S2.

| Alert | Threshold | Defined in code |
|---|---|---|
| API 5xx rate (`ApiHighErrorRate`, critical) | > 1% for 5 min | yes |
| API p99 latency (`ApiHighP99Latency`, warning) | > 1.5 s for 10 min | yes (note: the load-test budget gate is p99 800 ms, see [[performance-budget]]; the alert is deliberately looser) |
| Postgres connection saturation | > 80% for 5 min | no (E8.S2) |
| Redis memory | > 80% for 10 min | no (E8.S2) |
| Disk free | < 20 GB | no (E8.S2) |
| Dispatch fail rate | > 5% for 15 min | no (E8.S2; metric `rcab_dispatch_outcome_total` exists) |
| Cert expiry | < 30 days | no (E8.S2) |

## Uptime check

- Uptime Kuma probes `/v1/health/ready` every 60 s. `scripts/setup-uptime-kuma.ts` creates the monitor; the Slack notification is not provisioned by the repo (configure it in the Kuma UI once the owner supplies a webhook).

## See also
- [[performance-budget]] · [[docker-compose]] · [[vps-topology]]
