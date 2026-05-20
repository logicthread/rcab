---
title: ADR-0009 — Single VPS for Phase-0
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[vps-topology]], [[docker-compose]], [[deployment-topology]], [[scaling-strategy]]
audience: both
---

# ADR-0009 — Single VPS for Phase-0

*All containers (api, postgres, redis, osrm, nginx, observability stack) on one Linux VPS.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

We need a defensible, cheap, debuggable production environment for 5,000 users and 100 drivers. We don't need redundancy at the multi-region level. We do need to be ready to scale out in Phase-1.

## Decision

Use a **single VPS** running everything via docker-compose. Off-host backups. Trigger thresholds in [[scaling-strategy]] determine when to step out.

## Consequences

- Positive
  - Low cost, low complexity.
  - Easy to debug — everything in one host.
  - docker-compose is well-understood; no Kubernetes overhead.
- Negative
  - Single point of failure. 30-min RTO is acceptable for Phase-0; we accept this trade.
  - No regional redundancy.
  - The VPS being the OSRM host couples its memory to ours.
- Neutral
  - Migration path to Step-2 in [[scaling-strategy]] is mechanical.

## Alternatives considered

- **Managed Postgres + managed Redis + container host** — better resilience, ~3× cost. Phase-1.
- **Kubernetes from day one** — operational overhead exceeds value at 100 drivers.

## See also
- [[vps-topology]] · [[docker-compose]] · [[deployment-topology]]
- [[scaling-strategy]] · [[backups]]
