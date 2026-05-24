---
title: Local system probe & load-capacity estimator
tags: [layer/quality]
status: accepted
phase: 0
depends_on: [[performance-budget]], [[testing-strategy]]
related: [[docker-dev-environment]], [[story-rcab-e1-s9-system-probe]]
audience: both
---

# Local system probe & load-capacity estimator

*A reproducible "what can this box do" answer. Run on a fresh dev machine or on a candidate VPS to know whether it'll hold the load before we commit to it.*

## Why this exists

The Phase-0 target is "single VPS, vertical scaling." The single most important pre-commit question is: **how big does the VPS need to be for our user count?** The probe answers that with measurement, not guesswork.

## What the probe does

```
1. Inventory the host
   - CPU model + cores, RAM total + available, disk free,
     OS, kernel, Docker version, available ports for our dev stack.
2. Match / install missing deps (consent-gated)
   - macOS: brew formulae (docker, pnpm, node ≥ 20, git)
   - Debian/Ubuntu: apt packages (docker.io, docker-compose-plugin,
     pnpm via corepack, node 20 via nodesource)
3. Bring up the dev stack if not already up
4. Run synthetic loads (k6) for ~60 s each:
   - quote path (read-heavy, OSRM-bound)
   - dispatch path (write + Redis-bound)
   - driver-online flood (WS + Redis-bound)
5. Measure: p50/p95/p99 latency, error rate, CPU, RAM, Redis ops/s,
   Postgres connections.
6. Derive: estimated *user-handling envelope* for this host class.
7. Emit: system-probe-report.json + a human summary.
```

## The capacity model

For each measured path, the probe records the per-request CPU-ms and the per-request memory delta. Given a target CPU and memory budget (defaults: 70% sustained CPU, 70% RAM), it extrapolates to a sustainable RPS and converts via expected per-user request rates (in [[performance-budget]]) into a concurrent-active-user count.

Two numbers are reported:

- **Concurrent active drivers** the host can keep online without degrading p95 dispatch latency past [[performance-budget]].
- **Concurrent active clients** the host can support at the booking RPS implied by 100% drivers × historical booking rate.

The numbers are intentionally conservative (target-budget is 70%, not 100%).

## Output shape

```json
{
  "host": { "cpu": "Apple M2 Pro", "cores": 12, "ram_gb": 32, "disk_free_gb": 412 },
  "deps":  { "docker": "26.1.1", "node": "20.12.2", "pnpm": "9.0.6" },
  "missing": [],
  "load": {
    "quote":    { "p95_ms": 213, "rps": 540, "error_rate": 0.0 },
    "dispatch": { "p95_ms": 880, "rps": 110, "error_rate": 0.0 },
    "online":   { "ws_connections_per_s": 120 }
  },
  "envelope": {
    "concurrent_active_drivers": 240,
    "concurrent_active_clients": 6800
  },
  "phase_0_budget_status": "within"
}
```

## What it is NOT

- Not a benchmark for marketing. The numbers are budget-relative.
- Not a perf-regression tracker. That's CI-managed via k6 nightly.

## When to run

- Once on a new dev machine (before joining a story).
- Once on a candidate VPS class (before signing the cloud invoice).
- After any change to [[performance-budget]] (re-baseline).

## See also
- [[performance-budget]] · [[testing-strategy]] · [[docker-dev-environment]]
- [[story-rcab-e1-s9-system-probe]]
