---
title: ADR-0010 — Polyline-based route similarity for shared-ride matching
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[algo-route-similarity]], [[algo-shared-ride-matching]], [[features-shared-rides]]
audience: both
---

# ADR-0010 — Polyline-based route similarity (not geohash equality) for shared-ride matching

*The matching algorithm scores candidate pools using a Fréchet-lite distance over OSRM-routed polylines, not just origin/dest geohash equality.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

The first version of shared-ride matching considered checking whether two requests share the same origin and destination geohash cells. That misses cases where the cells match but the natural driving path differs (one goes via a flyover, the other via a service road) and over-matches cases where the cells differ slightly but the routes are essentially the same.

## Decision

Use a **polyline-based similarity metric** ([[algo-route-similarity]]) on top of a coarse spatial pre-filter. The metric is a simple mean nearest-neighbor distance between resampled polylines — fast, deterministic, good enough for Phase-0.

## Consequences

- Positive
  - Better matches → higher driver utilization and rider satisfaction.
  - Handles the "same endpoints, different middle" and "near endpoints, same middle" cases correctly.
- Negative
  - Requires an OSRM round-trip during matching (mitigated by route-cache in Redis).
- Neutral
  - The threshold (0.7) is a tunable; we'll learn from Phase-0 data.

## Alternatives considered

- **Geohash equality only** — too coarse, rejected above.
- **Exact Fréchet distance** — expensive without commensurate quality gain at our scale.
- **Learned embedding** — Phase-1; insufficient data Phase-0.

## See also
- [[algo-route-similarity]] · [[algo-shared-ride-matching]] · [[features-shared-rides]]
- [[entity-route]] · [[entity-shared-ride]]
