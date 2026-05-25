---
title: Epic E1 — Foundation
tags: [layer/delivery, kind/epic]
status: living
phase: 0
epic_id: E1
demo: 0
depends_on: [[delivery-roadmap]]
related: [[ADR-0009-single-vps-phase-0]], [[docker-compose]], [[vps-topology]], [[ci-cd]], [[observability]]
audience: both
---

# Epic E1 — Foundation

*Demo 0: "Hello, stack"*

Repo, dockerized environments, CI/CD, observability scaffolding.

## Goal

Completing every story in this epic ⇒ Demo 0 passes.

## Stories

| ID | Title | Status |
|---|---|---|
| RCAB-E1.S1 | [[story-rcab-e1-s1-repo-scaffold]] — monorepo skeleton | ■ |
| RCAB-E1.S2 | [[story-rcab-e1-s2-docker-dev]] — docker-compose.dev + devcontainer | ■ |
| RCAB-E1.S3 | [[story-rcab-e1-s3-docker-test]] — docker-compose.test + testcontainers | ■ |
| RCAB-E1.S4 | [[story-rcab-e1-s4-docker-prod]] — docker-compose.prod + nginx + TLS | ■ |
| RCAB-E1.S5 | [[story-rcab-e1-s5-ci-cd]] — Jenkins in docker-compose | ■ |
| RCAB-E1.S6 | [[story-rcab-e1-s6-observability]] — Loki + Prometheus + Grafana | ■ |
| RCAB-E1.S7 | [[story-rcab-e1-s7-db-bootstrap]] — Postgres + Redis + OSRM + migrations | □ |
| RCAB-E1.S8 | [[story-rcab-e1-s8-health-endpoints]] — /v1/health/live + /ready | □ |
| RCAB-E1.S9 | [[story-rcab-e1-s9-system-probe]] — host probe + load estimator | □ |

## Demo 0 headline (verbatim from [[delivery-roadmap]])

> Hello, stack

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[ADR-0009-single-vps-phase-0]], [[docker-compose]], [[vps-topology]], [[ci-cd]], [[observability]]
