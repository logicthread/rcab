---
title: Epic E8 — Production hardening
tags: [layer/delivery, kind/epic]
status: living
phase: 0
epic_id: E8
demo: 7
depends_on: [[delivery-roadmap]]
related: [[observability]], [[backups]], [[security-checklist]], [[performance-budget]], [[testing-strategy]]
audience: both
---

# Epic E8 — Production hardening

*Demo 7: "Production-grade"*

Alerts, backups, security, load.

## Goal

Completing every story in this epic ⇒ Demo 7 passes.

## Stories

| ID | Title | Status |
|---|---|---|
| RCAB-E8.S1 | Grafana dashboards filled with real query expressions | · |
| RCAB-E8.S2 | Alertmanager rules wired to Slack | · |
| RCAB-E8.S3 | [[story-rcab-e8-s3-backup-restore-drill]] — Backup container + restore drill | ▶ |
| RCAB-E8.S4 | Security checklist sweep — every item green | · |
| RCAB-E8.S5 | k6 load test: confirm Phase-0 perf budget on target VPS class | · |
| RCAB-E8.S6 | TLS + HSTS + CSP audit | · |
| RCAB-E8.S7 | [[story-rcab-e8-s7-review-remediation-stage-ab]] — Review remediation Stage A+B (runtime, config, sessions, booking, idempotency) | ▶ |
| RCAB-E8.S8 | [[story-rcab-e8-s8-review-remediation-stage-c]] — Review remediation Stage C (offer auth, driver exclusivity, durable dispatch, pool transactions) | ▶ |
| RCAB-E8.S9 | [[story-rcab-e8-s9-shared-fare-readjustment-policy]] — Shared fare readjustment policy (replaces the fixed-at-join stand-in) | · |
| RCAB-E8.S10 | [[story-rcab-e8-s10-central-policy-config]] — Centralize business policy configuration (one typed, validated table + generated overview) | ▶ |
| RCAB-E8.S11 | [[story-rcab-e8-s11-release-pipeline]] — Release pipeline: immutable images, verified deploy, rollback | ▶ |
| RCAB-E8.S12 | [[story-rcab-e8-s12-business-metrics-load]] — Business metrics + realistic load scenarios | ▶ |
| RCAB-E8.S13 | [[story-rcab-e8-s13-scheduled-cutoff-searching-ui]] — Scheduled retry cutoff + passenger searching state (+ optimistic shared pricing) | ▶ |

## Demo 7 headline (verbatim from [[delivery-roadmap]])

> Production-grade

## See also
- [[delivery-roadmap]] · [[stories-index]] · [[demo-cadence]]
- [[observability]], [[backups]], [[security-checklist]], [[performance-budget]], [[testing-strategy]]
