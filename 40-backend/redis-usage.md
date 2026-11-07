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
| `driver:state:<id>` | HASH | `{availability, last_seen, current_ride_id}`; `current_ride_id` is a **projection** of Postgres `driver_active_assignment`, reconciled at boot and periodically; `last_seen` updated by goOnline and by each accepted location event; read on WS reconnect for state replay | none |
| `request:<request_id>:dispatch` | HASH | retry counter, wave, last_tried_at | 10 min |
| `bull:scheduled-dispatch:*` | BullMQ keys | scheduled-booking jobs | per-job |
| `socketio:*` | Socket.IO adapter | pub/sub for multi-node (kept since day 1) | n/a |
| `cache:user:<id>:dashboard` | STRING JSON | client/driver dashboard read cache | 60s |
| `osrm:poly:<orig_geohash7>:<dest_geohash7>` | STRING JSON | OSRM polyline coords for a single O→D pair; used by `RouteSimilarityService` (E5.S1) | 1h |
| `pool:<ride_id>` | HASH | **Projection** of the Postgres pool (`shared_rides` + `pool_member`) for low-latency reads; fields `state`, `seat_count`, `max_seats`, `version`; rebuilt from Postgres at boot and periodically. Never authoritative. | 10 min |
| `bull:matching:*` | BullMQ keys | `matching` queue — currently carries `pool:expire:<ride_id>` delayed jobs (E5.S3) | per-job |
| `bull:dispatch:*` | BullMQ keys | `dispatch` queue — wave-2 timeout (`dispatch:wave2-timeout:<ride_id>`) and hard-fail (`dispatch:hard-fail:<ride_id>`) jobs (E5.S4) | per-job |

## Removed (Stage C)

Offers, claims and pool seats are no longer Redis state. Deleted: `claim:ride:*`, `offer:*`, `offer:meta:*`, `offer:type:*`, `offer:list:*`, `ride:*:offered`, `pool:*:offered`, `pool:*:stops`, `pool:<id>:seats`, and the Lua scripts `pool_claim.lua` / `pool_slot.lua` (claim and revoke now run as Postgres transactions). Truth lives in Postgres: `dispatch_offer`, `driver_active_assignment`, `outbox`, `pool_member` — see [[schema-postgres]] and [[module-dispatch]].

## Memory bound

At 100 drivers + 5000 users, Redis footprint < 200 MB. We size 1 GB and alert at 70 %.

## Persistence

- AOF `appendfsync everysec`. Redis is recoverable from Postgres (offers, assignment and pool state are projections; geo presence repopulates from driver heartbeats) — see [[backups]].

## Why not Postgres for the geo index?

Postgres can do `KNN` lookups via PostGIS, but at 100 drivers the dispatch hot path is small and we want < 5 ms — Redis `GEOSEARCH` is consistently fastest and keeps the dispatch path off the OLTP DB.

## See also
- [[database-choice]] · [[module-dispatch]] · [[module-realtime]]
- [[sm-driver-availability]] · [[algo-top-k-dispatch]]
