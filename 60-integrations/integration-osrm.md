---
title: Integration — OSRM
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[integration-openstreetmap]]
related: [[algo-eta-calculation]], [[algo-shared-ride-matching]], [[docker-compose]]
audience: both
---

# OSRM

*Open Source Routing Machine. Self-hosted from day 1.*

## Endpoints we use

| Endpoint | Use |
|---|---|
| `/route/v1/driving/{o};{d}` | quote a single ride (distance, duration, polyline) |
| `/table/v1/driving/{o};{d1};{d2}…` | many-to-many ETAs for shared-ride detour checks |
| `/nearest/v1/driving/{p}` | snap a GPS sample to the road network when needed |

## Hosting

- Container on the same VPS. India-wide PBF pre-extracted to MLD format (multi-level Dijkstra).
- ~4 GB RAM working set for an India extract; we budget 4 GB.
- Reloaded out-of-band when we refresh the underlying OSM data (monthly).

## Caching

- Cache by `(origin_geohash7, dest_geohash7)` for 1 h (`route-cache:*` in [[redis-usage]]). Most quotes during peak hours are repeats along common corridors.

## Failure modes

- OSRM down → `503 routing_unavailable`. Booking is disabled until restored. We do not fake quotes — pricing depends on real distances.

## Why not Google Directions API?

- Cost scales with usage; we'd be paying for every quote.
- Vendor lock-in.
- Latency variability over the internet vs. localhost.
- OSRM is good enough for Indian city routing in our experience.

## See also
- [[integration-openstreetmap]] · [[algo-eta-calculation]] · [[algo-shared-ride-matching]]
- [[docker-compose]]
