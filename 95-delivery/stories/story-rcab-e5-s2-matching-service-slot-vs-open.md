---
title: RCAB-E5.S2 — Matching service: slot vs. open decision
tags: [layer/delivery, kind/story]
status: in_progress
phase: 0
epic: [[epic-e5-shared-booking]]
demo: 4
estimate: m
hitl: no
depends_on: [[story-rcab-e5-s1-route-similarity-scorer]], [[algo-shared-ride-matching]], [[entity-shared-ride]], [[module-matching]], [[redis-usage]]
blocks: [[story-rcab-e5-s3-pool-lifecycle]]
affected_notes: [[algo-shared-ride-matching]], [[module-matching]], [[redis-usage]]
owner: claude
audience: both
---

# RCAB-E5.S2 — Matching service: slot vs. open decision

## Goal

When a client requests a shared ride, the API must decide within 200 ms whether to slot the request into an existing open pool or open a new one. This story implements the full decision tree from [[algo-shared-ride-matching]], wired to the `RouteSimilarityService` from E5.S1. No booking API changes yet — this story is the pure matching logic layer that E5.S3 will call.

## User-facing acceptance criteria

- `Given` an open pool exists on the same corridor (similarity ≥ 0.7, origin detour ≤ 800 m, dest detour ≤ 800 m, seats < max), `When` a new shared request arrives, `Then` it is slotted into that pool and the pool's `seat_count` increments.
- `Given` no open pool qualifies, `When` a new shared request arrives, `Then` a new pool is opened with `seat_count = 1` and `status = open`.
- `Given` multiple qualifying pools exist, `When` the matcher runs, `Then` the best-scoring pool wins (`score − 0.0005 * detour_total`).
- `Given` two simultaneous requests for the same corridor arrive with no existing pool, `When` both are processed concurrently, `Then` at most one extra empty pool is created (race accepted, documented in [[algo-shared-ride-matching]] § Race conditions).

## Technical acceptance criteria

- `apps/api/src/modules/matching/matching.service.ts`:
  - `findOrCreatePool(request: SharedRideRequest): Promise<MatchResult>` where `MatchResult = { mode: 'slotted' | 'opened', sharedRideId: string }`.
  - Spatial pre-filter: query Postgres `shared_rides WHERE ST_DWithin(origin_centroid, $origin, 1500) AND ST_DWithin(dest_centroid, $dest, 1500) AND state = 'open' AND seat_count < max_seats`.
  - Calls `RouteSimilarityService.scoreRoutes()` for each candidate; filters by `s ≥ 0.7` and both detours `≤ detour_budget_m`.
  - Selects best candidate: `score − 0.0005 * (detour_origin + detour_dest)`.
  - Slots via a Lua script `lua/pool_slot.lua`: atomically increments `seat_count` and checks it hasn't exceeded `max_seats` (guards against the race condition).
  - Opens new pool via `SharedRideRepository.create()` with defaults from [[algo-shared-ride-matching]] § Open-pool defaults.
- `MatchingController` is NOT created in this story — the service is called internally.
- `max_seats`, `similarity_threshold`, `detour_budget_m` are all `ConfigService` keys with documented defaults.

## Test plan

- **Unit (Vitest):** `matching.service.spec.ts` — mock `RouteSimilarityService`, `SharedRideRepository`, Lua script runner; assert slotting when score ≥ 0.7 and detour ≤ 800; assert new pool opened when no candidate; assert best pool chosen by composite score; assert Lua script called for slot.
- **Integration (Testcontainers Postgres + Redis):** create two open pools with known centroids; POST a shared request close to one; assert `seat_count` incremented in DB; assert correct `sharedRideId` returned.

## Out of scope

- Pool lifecycle state transitions (open → closed_*) — that is E5.S3.
- Dispatch fan-out from the matching decision — that is E5.S4.
- `POST /v1/rides` shared type handling — wired in E5.S3 or E5.S4 once the pool lifecycle exists.

## Notes / questions

- `detour_origin` = straight-line (haversine) from request's origin to pool's `origin_centroid`. Good enough for Phase-0; could swap for OSRM walking later.
- `origin_centroid` / `dest_centroid` in `shared_rides` table must be `GEOGRAPHY(POINT, 4326)` for `ST_DWithin` to accept metres, not degrees.

## See also

- [[epic-e5-shared-booking]] · [[algo-shared-ride-matching]] · [[algo-route-similarity]]
- [[entity-shared-ride]] · [[module-matching]] · [[redis-usage]]
- [[story-rcab-e5-s1-route-similarity-scorer]] · [[story-rcab-e5-s3-pool-lifecycle]]
