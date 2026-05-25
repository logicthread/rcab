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

- `prom-client` in the API exposes `/metrics` (bound only on the internal network).
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
- **Logs** — Loki panel with request_id search.

## Alerts (Alertmanager → Slack)

| Alert | Threshold |
|---|---|
| API 5xx rate | > 1% for 5 min |
| API p99 latency | > 1.5 s for 10 min |
| Postgres connection saturation | > 80% for 5 min |
| Redis memory | > 80% for 10 min |
| Disk free | < 20 GB |
| Dispatch fail rate | > 5% for 15 min |
| Cert expiry | < 30 days |

## Uptime check

- Uptime Kuma probes `/v1/health/ready` every 60 s and pings Slack on failure.

## See also
- [[performance-budget]] · [[docker-compose]] · [[vps-topology]]
