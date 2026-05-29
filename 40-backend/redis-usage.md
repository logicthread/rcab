---
title: Redis usage
tags: [layer/backend]
status: accepted
phase: 0
depends_on: [[database-choice]]
related: [[sm-driver-availability]], [[module-dispatch]], [[module-realtime]], [[algo-top-k-dispatch]]
audience: both
---

# Redis usage

*Every Redis key, what holds it, what it expires to.*

## Keyspace map

| Key | Type | Purpose | TTL |
|---|---|---|---|
| `active_drivers` | GEO | online drivers' positions; `GEOADD` on goOnline and each accepted `driver:location` WS event; `ZREM` on offline | none |
| `driver:state:<id>` | HASH | `{availability, last_seen, current_ride_id}`; `last_seen` updated by goOnline and by each accepted location event; read on WS reconnect for state replay | none |
| `offer:<offer_id>` | STRING (lock) | dispatch offer lock; first-to-set wins | 12s (`SET NX EX`) |
| `offer:list:<request_id>` | SET | offer ids currently outstanding for a request | 5 min |
| `request:<request_id>:dispatch` | HASH | retry counter, wave, last_tried_at | 10 min |
| `bull:scheduled-dispatch:*` | BullMQ keys | scheduled-booking jobs | per-job |
| `socketio:*` | Socket.IO adapter | pub/sub for multi-node (kept since day 1) | n/a |
| `cache:user:<id>:dashboard` | STRING JSON | client/driver dashboard read cache | 60s |
| `osrm:poly:<orig_geohash7>:<dest_geohash7>` | STRING JSON | OSRM polyline coords for a single O→D pair; used by `RouteSimilarityService` (E5.S1) | 1h |
| `pool:<ride_id>:seats` | STRING int | Atomic seat counter for an open pool; seeded from Postgres on cold start; used by `pool_slot.lua` (E5.S2) | 5 min |
| `pool:<ride_id>` | HASH | Pool lifecycle state for low-latency dispatch reads; fields: `state`, `seat_count`, `max_seats`, `expiry_job_id`, `closed_at`, `claimed_by`, `claimed_at`; written by `PoolLifecycleService` (E5.S3) and `DispatchService.claimPool` (E5.S4 — sets `claimed_by`/`claimed_at` via `pool_claim.lua`) | 10 min |
| `pool:<ride_id>:offered` | SET | Driver IDs already invited for this pool's dispatch; consulted on wave 2 to exclude (E5.S4) | 10 min |
| `pool:<ride_id>:stops` | STRING JSON | Cached `OfferStop[]` (pickups + drops, stop-ordered) so reposting offers across waves emits a stable order (E5.S4) | 10 min |
| `offer:list:<ride_id>` | SET | Outstanding offer IDs for a shared pool; consumed by the revoke path on claim or hard-fail (E5.S4) | 10 min |
| `offer:meta:<offer_id>` | STRING | Pool id for a shared-ride offer; lets the gateway resolve `sharedRideId` if the driver's response omits it (E5.S4) | 10 min |
| `bull:matching:*` | BullMQ keys | `matching` queue — currently carries `pool:expire:<ride_id>` delayed jobs (E5.S3) | per-job |
| `bull:dispatch:*` | BullMQ keys | `dispatch` queue — wave-2 timeout (`dispatch:wave2-timeout:<ride_id>`) and hard-fail (`dispatch:hard-fail:<ride_id>`) jobs (E5.S4) | per-job |

## Lua scripts

A few atomic ops live in Lua to avoid races:

- `dispatch_claim.lua` — `SET offer:<id> driver_id NX EX 12` and emit pub/sub if won.
- `dispatch_revoke.lua` — bulk delete `offer:list:<request_id>` and notify each loser.
- `pool_slot.lua` — atomically incr `shared_ride.seat_count` if `< max_seats` and stamp `pool_seat_index`.
- `pool_claim.lua` (E5.S4) — validates `pool:<ride_id>` HASH `state` is a `closed_*` value, then HSETs `claimed_by` + `claimed_at` if not already set. Return codes: `1` claimed, `0` already_taken, `-1` not_closed, `-2` not_found.

## Memory bound

At 100 drivers + 5000 users, Redis footprint < 200 MB. We size 1 GB and alert at 70 %.

## Persistence

- AOF `appendfsync everysec`. We treat Redis as **mostly recoverable** from Postgres in a disaster — see [[backups]].

## Why not Postgres for the geo index?

Postgres can do `KNN` lookups via PostGIS, but at 100 drivers the dispatch hot path is small and we want < 5 ms — Redis `GEOSEARCH` is consistently fastest and keeps the dispatch path off the OLTP DB.

## See also
- [[database-choice]] · [[module-dispatch]] · [[module-realtime]]
- [[sm-driver-availability]] · [[algo-top-k-dispatch]]
