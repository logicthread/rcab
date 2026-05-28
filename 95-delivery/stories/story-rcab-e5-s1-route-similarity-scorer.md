---
title: RCAB-E5.S1 — Route similarity scorer + cached OSRM polylines
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e5-shared-booking]]
demo: 4
estimate: s
hitl: no
depends_on: [[algo-route-similarity]], [[integration-osrm]], [[redis-usage]], [[entity-route]]
blocks: [[story-rcab-e5-s2-matching-service-slot-vs-open]]
affected_notes: [[algo-route-similarity]], [[module-matching]], [[redis-usage]]
owner: claude
audience: both
---

# RCAB-E5.S1 — Route similarity scorer + cached OSRM polylines

## Goal

The shared-ride matching decision tree (see [[algo-route-similarity]]) needs a scalar score `s ∈ [0,1]` expressing how much two origin-destination corridors overlap. This story implements that scorer as a NestJS service, fetches OSRM polylines once per trip pair, caches them in Redis with a 1-hour TTL, and exposes the scorer to the matching module. No booking endpoints are wired in this story — those follow in E5.S2.

## User-facing acceptance criteria

- `Given` two route pairs whose OSRM paths overlap heavily (same corridor), `When` the scorer runs, `Then` it returns a score ≥ 0.8.
- `Given` two route pairs travelling in opposite directions, `When` the scorer runs, `Then` it returns a score ≤ 0.2.
- `Given` the OSRM polyline for an origin-destination pair has been fetched once, `When` the same pair is scored a second time within 1 h, `Then` no OSRM HTTP call is made (Redis cache hit).
- `Given` OSRM returns an error for a polyline fetch, `When` the scorer is called, `Then` it throws a typed `OsrmUnavailableException` and does not cache the failure.

## Technical acceptance criteria

- `apps/api/src/modules/matching/route-similarity.service.ts`:
  - `scoreRoutes(a: RouteInput, b: RouteInput): Promise<number>` — fetches (or reads from cache) OSRM polylines for both routes, resamples each to 25 equally-spaced points, computes mean nearest-neighbour distance `d̄` metres, returns `max(0, 1 − d̄ / 1200)` per [[algo-route-similarity]] § Phase-0 metric.
  - `RouteInput = { originLat, originLng, destLat, destLng }`.
- Redis cache key: `osrm:poly:<orig_geohash7>:<dest_geohash7>` (geohash precision 7 ≈ 76 m cells). TTL: 3600 s.
- `MatchingModule` (`apps/api/src/modules/matching/matching.module.ts`) imports and exports `RouteSimilarityService`.
- Saturation distance (`1200`) is read from `ConfigService` key `ROUTE_SIMILARITY_SATURATION_M`; default `1200`.
- OSRM base URL is the existing `OSRM_BASE_URL` env var (already wired in [[integration-osrm]]).

## Test plan

- **Unit (Vitest):** `route-similarity.service.spec.ts` — mock `HttpService` and `RedisService`; assert score formula for known `d̄` values; assert cache `SET` called on first fetch; assert `GET` returned on second call with no HTTP invocation; assert `OsrmUnavailableException` thrown on HTTP error.
- **Integration (Testcontainers Redis):** spin up real Redis; call `scoreRoutes` twice for identical inputs; assert Redis key exists after first call; assert second call returns same result without HTTP call (mock OSRM HTTP at integration boundary).

## Out of scope

- Wiring scorer into booking or dispatch flows — that is E5.S2+.
- A public REST endpoint for the scorer — it is internal to `MatchingModule`.
- Proper Fréchet distance — Phase-1 upgrade noted in [[algo-route-similarity]].

## Notes / questions

- Geohash-7 cells are ≈76 m × 76 m. Two origin points within the same cell get the same cache key. Acceptable for Phase-0.
- OSRM's `/route/v1/driving/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson` endpoint returns a GeoJSON `LineString`; decode from the `geometry.coordinates` array.
- Resampling: compute cumulative arc-lengths along the polyline, interpolate at 25 evenly-spaced arc-length fractions.

## See also

- [[epic-e5-shared-booking]] · [[algo-route-similarity]] · [[integration-osrm]]
- [[redis-usage]] · [[entity-route]] · [[module-matching]]
- [[story-rcab-e5-s2-matching-service-slot-vs-open]]
