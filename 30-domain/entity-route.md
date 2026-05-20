---
title: Entity — Route
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[data-model]]
related: [[entity-shared-ride]], [[algo-route-similarity]]
audience: both
---

# Route

*An emergent corridor — origin region → destination region — that has carried at least one ride.*

## Fields

| Field | Type | Notes |
|---|---|---|
| id | uuid (v7) | pk |
| origin_cell | text | geohash precision-6 (~1.2km) |
| dest_cell | text | geohash precision-6 |
| canonical_polyline | text | OSRM-encoded |
| samples_count | int | how many rides have used this route |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Notes

- Phase-0 uses **geohash binning** (precision-6) for fast origin/dest grouping. Routes that map to the same `(origin_cell, dest_cell)` are considered the same Route.
- The `canonical_polyline` is the OSRM-routed path between the cell centroids; we update it when more samples arrive (rolling average not needed — OSRM is deterministic per cell pair).
- This is a coarse model; [[algo-route-similarity]] sharpens matching beyond just geohash equality.

## See also
- [[entity-shared-ride]] · [[algo-route-similarity]] · [[algo-shared-ride-matching]]
