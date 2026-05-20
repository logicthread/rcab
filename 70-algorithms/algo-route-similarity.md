---
title: Algorithm — Route similarity
tags: [layer/algorithm, kind/algo]
status: accepted
phase: 0
depends_on: [[integration-osrm]]
related: [[algo-shared-ride-matching]], [[entity-route]]
audience: both
---

# Route similarity

*A scalar in [0,1] expressing how much two origin-dest pairs are "on the same route."*

## Phase-0 metric — Fréchet-lite

For two ride pairs `(O₁, D₁)` and `(O₂, D₂)`:

1. Get OSRM-routed polylines `P₁`, `P₂`.
2. Resample each to 25 equally-spaced points.
3. Compute mean nearest-neighbor distance from `P₂.points → P₁` and vice versa; call it `d̄` in meters.
4. Similarity:
   `s = max(0, 1 - d̄ / 1200)`
   (1200 m is the saturation distance; tunable.)

This is a cheap proxy for Fréchet distance. Good enough for Phase-0; we don't need an exact metric — we need a stable, comparable score.

## Why not just origin/dest geohash equality?

Two corridors can share endpoints but diverge midway (one detours via a flyover). The polyline-based metric catches this.

## Caching

- Cache by `(orig1_geohash7, dest1_geohash7, orig2_geohash7, dest2_geohash7)` for 1 h. In practice the polylines are stable across that window.

## Improvements (Phase-1)

- Replace with proper discrete Fréchet distance.
- Or learn an embedding from historical successful shared rides.

## See also
- [[algo-shared-ride-matching]] · [[integration-osrm]]
- [[entity-route]]
