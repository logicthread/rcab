---
title: Performance budget
tags: [layer/quality]
status: accepted
phase: 0
depends_on: [[phase-0]]
related: [[observability]], [[testing-strategy]]
audience: both
---

# Performance budget

*Numbers we measure and alert on.*

## Backend (single VPS, 5k users / 100 drivers)

| Metric | Budget |
|---|---|
| API p50 | ≤ 120 ms |
| API p95 | ≤ 400 ms |
| API p99 | ≤ 800 ms |
| Dispatch p50 (request → first offer) | ≤ 1.0 s |
| Dispatch p95 | ≤ 3.0 s |
| Quote p95 | ≤ 250 ms (OSRM local) |
| WS reconnect p95 | ≤ 2 s |
| 5xx rate | ≤ 0.5% |

## Resource

| Metric | Budget |
|---|---|
| API memory | ≤ 1.5 GB steady |
| Postgres connections | ≤ 60% of pool |
| Redis memory | ≤ 600 MB |
| OSRM memory | ≤ 4 GB |

## Web client

| Metric | Budget (throttled 3G, mid-range Android) |
|---|---|
| TTI on `/book` | ≤ 4 s |
| JS bundle (initial) | ≤ 200 KB gz |
| Map mount delay | ≤ 1 s after route mount |

## Driver app

| Metric | Budget |
|---|---|
| Cold start to `/home` | ≤ 3 s on mid-range Android |
| Offer screen render after WS event | ≤ 200 ms |
| Battery (on_ride, 1 h) | ≤ 6% |
| APK size | ≤ 30 MB |

## See also
- [[observability]] · [[testing-strategy]] · [[phase-0]]
