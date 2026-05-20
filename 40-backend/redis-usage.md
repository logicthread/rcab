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
| `active_drivers` | GEO | online drivers' positions; queried for dispatch | none — entries `ZREM`ed on offline |
| `driver:state:<id>` | HASH | `{availability, last_seen, current_ride_id}` | none |
| `offer:<offer_id>` | STRING (lock) | dispatch offer lock; first-to-set wins | 12s (`SET NX EX`) |
| `offer:list:<request_id>` | SET | offer ids currently outstanding for a request | 5 min |
| `request:<request_id>:dispatch` | HASH | retry counter, wave, last_tried_at | 10 min |
| `bull:scheduled-dispatch:*` | BullMQ keys | scheduled-booking jobs | per-job |
| `socketio:*` | Socket.IO adapter | pub/sub for multi-node (kept since day 1) | n/a |
| `cache:user:<id>:dashboard` | STRING JSON | client/driver dashboard read cache | 60s |
| `route-cache:<origin_cell>:<dest_cell>` | STRING | OSRM-cached route polyline + distance | 1h |

## Lua scripts

A few atomic ops live in Lua to avoid races:

- `dispatch_claim.lua` — `SET offer:<id> driver_id NX EX 12` and emit pub/sub if won.
- `dispatch_revoke.lua` — bulk delete `offer:list:<request_id>` and notify each loser.
- `pool_slot.lua` — atomically incr `shared_ride.seat_count` if `< max_seats` and stamp `pool_seat_index`.

## Memory bound

At 100 drivers + 5000 users, Redis footprint < 200 MB. We size 1 GB and alert at 70 %.

## Persistence

- AOF `appendfsync everysec`. We treat Redis as **mostly recoverable** from Postgres in a disaster — see [[backups]].

## Why not Postgres for the geo index?

Postgres can do `KNN` lookups via PostGIS, but at 100 drivers the dispatch hot path is small and we want < 5 ms — Redis `GEOSEARCH` is consistently fastest and keeps the dispatch path off the OLTP DB.

## See also
- [[database-choice]] · [[module-dispatch]] · [[module-realtime]]
- [[sm-driver-availability]] · [[algo-top-k-dispatch]]
