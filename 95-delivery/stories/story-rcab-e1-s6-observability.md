---
title: RCAB-E1.S6 — Observability stack (Loki + Prometheus + Grafana + Uptime Kuma)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: m
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[observability]], [[performance-budget]]
owner: claude
audience: both
---

# RCAB-E1.S6 — Observability stack (Loki + Prometheus + Grafana + Uptime Kuma)

## Goal

Bring up the observability stack alongside the API and ship logs, metrics, and uptime probes from day 1. Defaults dashboards loaded as code. Alertmanager wired but rules are minimal (production-grade rules land in [[epic-e8-production-hardening]]).

## User-facing acceptance criteria

- `Given` the dev or prod stack is up, `When` I open `http://localhost:3001`, `Then` Grafana shows me an Overview dashboard with API RPS, p50/p95/p99 latency, error rate, and active drivers gauge.
- `Given` a deliberate 500 from the API, `When` I look at Loki via Grafana's "Explore", `Then` I see the structured log line with a `request_id` and the stack trace.
- `Given` the API is down, `When` Uptime Kuma's `/v1/health/ready` probe runs, `Then` an alert is sent (Slack webhook in prod; stdout in dev).

## Technical acceptance criteria

- `loki`, `promtail`, `prometheus`, `grafana`, `uptime-kuma`, `alertmanager` containers in both `docker-compose.dev.yml` and `docker-compose.prod.yml`.
- pino logger configured in `apps/api` with `request_id` interceptor.
- `prom-client` exposes `/metrics` on the API (internal-network only).
- Default Grafana dashboards live as JSON in `infra/observability/dashboards/`, loaded via provisioning.
- Default Prometheus scrape config in `infra/observability/prometheus.yml`.

## Test plan

- Smoke: CI job hits the API, then queries Prometheus for `http_request_duration_seconds_count` and asserts non-zero.

## Out of scope

- Tracing (OpenTelemetry) — deferred to Phase-1.
- Alert rule tuning beyond the defaults — that's RCAB-E8.S2.

## See also
- [[epic-e1-foundation]] · [[observability]] · [[performance-budget]]
