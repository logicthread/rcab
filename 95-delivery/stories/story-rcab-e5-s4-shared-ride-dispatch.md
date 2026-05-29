---
title: RCAB-E5.S4 — Shared-ride dispatch (offer reflects pool span)
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e5-shared-booking]]
demo: 4
estimate: m
hitl: no
depends_on: [[story-rcab-e5-s3-pool-lifecycle]], [[module-dispatch]], [[module-realtime]], [[websocket-events]], [[redis-usage]], [[entity-shared-ride]]
blocks: [[story-rcab-e5-s7-driver-app-multi-stop]]
affected_notes: [[module-dispatch]], [[websocket-events]], [[entity-shared-ride]]
owner: claude
audience: both
---

# RCAB-E5.S4 — Shared-ride dispatch (offer reflects pool span)

## Goal

When a shared pool closes (via timeout or full-seats) the existing top-K dispatch path must be adapted to fan-out a richer offer to candidate drivers — one that shows the full multi-stop span rather than a single origin-destination pair. This story modifies the dispatch module and Lua claim script to handle pool IDs, and ensures the driver app's offer event carries all passenger stops so the driver can evaluate the detour before accepting.

## User-facing acceptance criteria

- `Given` a pool closes with 2 passengers, `When` dispatch fans out, `Then` the WS offer event sent to each candidate driver includes the pickup and drop locations for all passengers in chronological stop order.
- `Given` a driver accepts a shared ride offer, `When` the Lua claim script runs, `Then` all slots in the pool are atomically locked to that driver and no second driver can accept.
- `Given` no driver accepts within the offer timeout (30 s, wave 1), `When` wave 2 fires, `Then` the search radius expands and a fresh fan-out is sent.
- `Given` all dispatch waves fail, `When` the pool is exhausted, `Then` the pool transitions to `aborted` and each passenger's `RideRequest` is individually re-queued for normal (solo) dispatch.

## Technical acceptance criteria

- `DispatchService.dispatchPool(pool: SharedRide): Promise<void>` added alongside existing `dispatch()`:
  - Fetches top-K geo candidates from `active_drivers` Redis sorted set, same geo-query as normal dispatch.
  - Emits `ride:offer` WS event per candidate with payload extension: `stops: Array<{ type: 'pickup'|'dropoff', lat: number, lng: number, passengerId: string, sequenceIndex: number }>`.
  - Stop order: pickups interleaved with drops in OSRM-optimal order (greedy nearest-unserved for Phase-0; no TSP solver).
- `lua/pool_claim.lua` — atomic: checks `pool:<pool_id>` HASH `state = 'closed_*'` and `claimed_by` not set; sets `claimed_by = driver_id`; returns 1 on success, 0 on race.
- `RealtimeGateway.handleRideOfferResponse()` — updated to detect `sharedRideId` in response payload; calls `dispatchPool.claim()` instead of normal `dispatch.claim()`.
- `DispatchService.dispatchPool()` is called by `PoolLifecycleService.closePool()` via an event `pool:closed`.
- Wave-2 / hard-fail paths reuse the existing wave machinery from normal dispatch (E4.S4).

## Test plan

- **Unit (Vitest):** `dispatch.service.spec.ts` — mock Redis geo query and WS gateway; assert `ride:offer` payload shape includes `stops` array; assert Lua `pool_claim` returns 0 on second call (race); assert `aborted` transition triggered after all waves fail.
- **Integration (Testcontainers Redis + Socket.IO test client):** open pool with 2 slots → close → connect a mock driver socket → assert offer event received with correct `stops` array → emit accept → assert pool HASH `claimed_by` set.

## Out of scope

- Driver turn-by-turn navigation per stop — Google Maps deep link is E4.S6 / [[driver-google-maps-handoff]].
- Per-stop pickup/drop confirmation screen — that is E5.S7.
- TSP-optimal stop ordering — Phase-0 uses greedy nearest-unserved.

## Notes / questions

- "OSRM-optimal" in Phase-0 means: sort all pickup points by proximity to pool `origin_centroid`, then all drop points by proximity to pool `dest_centroid`. This gives a reasonable order without an OSRM TSP call.
- The `stops` array in the offer event must be stable across re-broadcasts (same order each wave) — compute once and cache in Redis at `pool:<pool_id>:stops`.

## Implementation

- New module `apps/api/src/modules/dispatch/` (built from scratch — E4.S3/S4 will reuse).
  - `DispatchService.dispatchPool(rideId)` — load pool, fan out wave 1 via `RealtimeBus.toDriver(driverId, 'ride_offer', payload)`.
  - `DispatchService.@OnEvent('pool.closed')` — auto-dispatch when `PoolLifecycleService` emits the event for `closed_full` or `closed_timeout` (not for `closed_started` or `aborted`).
  - `DispatchService.@OnEvent('dispatch.ride_offer_response')` — driven by gateway; routes accepts to `claimPool`, declines just release the offer lock.
  - `DispatchService.claimPool(rideId, driverId)` — atomic Lua via `lua/pool_claim.lua`; returns 1/0/-1/-2. On success: `setClaimed` in DB, revoke all `offer:list:<rideId>` entries, remove wave-2 + hard-fail BullMQ jobs.
  - `DispatchService.handleHardFail(job)` — closes pool to `aborted` and revokes offers. Per-passenger solo re-queue is **carved out** as `TODO(RCAB-E4.S3)` since the solo dispatch path does not yet exist.
  - Stops computed once via `computeStops(pool)`: pickups sorted by proximity to pool origin centroid, drops by proximity to dest centroid. Cached at `pool:<id>:stops` for stable cross-wave ordering.
- `PoolLifecycleService` gains `EventEmitter2` dep and emits `pool.closed` on `closed_full` / `closed_timeout`.
- `SharedRideRepository` gains `findById`, `appendMember`, `setClaimed`. New columns `members jsonb DEFAULT '[]'` + `claimed_by_driver_id uuid` + `claimed_at timestamptz` via migration `0004_shared_rides_dispatch.sql`.
- `MatchingService.findOrCreatePool` now requires `passengerId` so each slot/open seeds a `SharedRideMember` into `shared_rides.members`. The dispatch stop list is built from this column.
- `RidesController` generates a fresh `passengerId` (UUID v4) on each `POST /v1/rides` request — `TODO(RCAB-E4.S2)`: replace with the authenticated user id when `RideRequest` lands.
- `RealtimeGateway` adds `@SubscribeMessage('ride_offer_response')`; it emits the internal Node event `dispatch.ride_offer_response` (avoids a realtime↔dispatch module cycle).
- BullMQ `dispatch` queue (`bull:dispatch:*`) registered in `DispatchModule`. Job IDs `dispatch:wave2-timeout:<ride_id>` and `dispatch:hard-fail:<ride_id>` are constrained to 3-colon form because BullMQ 5.77 rejects custom IDs with > 2 colons.
- Phase-0 carve-outs (recorded explicitly so they show up in [[hitl-touchpoints]] review for next epic):
  - Solo re-queue on hard-fail: deferred to `RCAB-E4.S3`.
  - The `closed_started` transition on actual ride start: deferred to `RCAB-E4.S6`.
  - Stops use greedy nearest-unserved; no OSRM TSP. See "Out of scope".

## See also

- [[epic-e5-shared-booking]] · [[module-dispatch]] · [[module-realtime]]
- [[websocket-events]] · [[redis-usage]] · [[entity-shared-ride]]
- [[story-rcab-e5-s3-pool-lifecycle]] · [[story-rcab-e5-s7-driver-app-multi-stop]]
