---
title: Delivery roadmap
tags: [layer/delivery, kind/moc]
status: living
phase: 0
depends_on: [[phase-0]], [[demo-cadence]]
related: [[stories-index]], [[hitl-touchpoints]], [[impact-analysis]]
audience: both
---

# Delivery roadmap

*Production is reached one runnable demo at a time. Each demo is a hard waypoint: docker-up, tests green, dev sign-off.*

## The demos (in order)

| # | Demo | Headline | Owning epic |
|---|---|---|---|
| 0 | **Hello, stack** | `docker compose up` brings up nginx + api + postgres + redis + osrm; `/v1/health/ready` returns 200 across all services; CI runs unit + integration tests green on PR | [[epic-e1-foundation]] |
| 1 | **I am a real user** | Phone OTP signup works end-to-end in the web app; user row in Postgres; rcab JWT issued; logout + refresh work | [[epic-e2-auth]] |
| 2 | **The driver is online** | Driver app: phone OTP, register vehicle, toggle online; Redis geo index populated; location stream visible in ops dashboard | [[epic-e3-driver-presence]] |
| 3 | **Book a normal ride** | Client picks pick/drop on OSM map, gets a quote, places request; top-K dispatch lights up driver app; accept → ride lifecycle → complete → rating | [[epic-e4-normal-booking]] |
| 4 | **Shared works** | Two simultaneous shared requests on similar routes pool into one ride; driver sees pool grow; both passengers picked up and dropped in order | [[epic-e5-shared-booking]] |
| 5 | **Scheduled works** | A booking placed for T+30 min wakes its dispatch at T-10 min; driver assignment, ride completion as for normal | [[epic-e6-scheduled-booking]] |
| 6 | **Dashboards & ratings** | Two-sided ratings persist and aggregate; client history page + driver earnings page render real data; weighted-recency means computed | [[epic-e7-rating-dashboards]] |
| 7 | **Production-grade** | Observability dashboards live; alerts fire on synthetic faults; backups round-trip; security checklist green; load test confirms Phase-0 performance budget on the target VPS class | [[epic-e8-production-hardening]] |
| 8 | **Real drivers, real city** | Closed pilot with 10–20 hand-picked drivers in the pilot city for one week; weekly review; bug log + iteration; then scale to Phase-0 targets (100 drivers, 5,000 clients) | [[epic-e9-pilot-rollout]] |

## Definition of done for a demo

A demo is "done" when **all** of:

1. The flow runs against `docker compose up` from a fresh checkout — no manual steps beyond what's in the README.
2. Tests required by the demo's stories are green in CI (unit + integration + the demo's e2e).
3. The demo is observable: relevant Grafana panels show data; key metrics in [[performance-budget]] are within budget for this stage.
4. Stories' acceptance criteria all pass.
5. The developer has personally walked through the demo flow and signed off (see [[hitl-touchpoints]]).

See [[demo-cadence]] for the rhythm.

## What this roadmap is NOT

- Not a timeline. We do not put dates on demos.
- Not a Gantt. Demos are sequential because each builds on the previous.
- Not a backlog. Stories are the backlog ([[stories-index]]).

## How stories map onto this

- Every epic is **named after its demo**: completing the epic ⇒ demo passes.
- Every story belongs to exactly one epic.
- Stories are atomic units of work. Some are 1 hour, some are 2 days. We don't normalize size.

## When the roadmap changes

The roadmap itself changes only when a demo's *headline* changes. If we add a story to an existing epic, the roadmap stays; only [[stories-index]] updates. If we reorder demos or split/merge epics, run [[impact-analysis]] first and commit the roadmap edit as `refactor(vault): roadmap reorder ...`.

## See also
- [[stories-index]] · [[story-template]] · [[story-id-scheme]]
- [[demo-cadence]] · [[hitl-touchpoints]] · [[impact-analysis]] · [[commit-story-linkage]]
- [[phase-0]] · [[phase-1]] · [[performance-budget]]
