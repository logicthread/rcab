---
title: Entity — Driver
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[entity-user]]
related: [[entity-vehicle]], [[sm-driver-availability]], [[features-history-dashboard]]
audience: both
---

# Driver

*Profile attached to a [[entity-user]] with `role=driver`.*

## Fields

| Field | Type | Notes |
|---|---|---|
| user_id | uuid | pk, fk → user.id, unique |
| license_no | text | manual offline verification in Phase-0 |
| verified_at | timestamptz | nullable; null = pending |
| availability | enum('offline', 'online', 'on_ride') | see [[sm-driver-availability]] |
| current_vehicle_id | uuid | fk → vehicle.id, nullable |
| rating_avg | numeric(3,2) | nullable |
| rating_count | int | default 0 |
| total_rides | int | denormalized; reconciled nightly |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Availability is not in Postgres alone

The authoritative "is this driver online right now?" lives in **Redis** (`active_drivers` geo set + a hash for state). Postgres `availability` is a denormalized convenience. See [[redis-usage]] and [[sm-driver-availability]].

## See also
- [[entity-user]] · [[entity-vehicle]]
- [[sm-driver-availability]] · [[redis-usage]]
- [[module-realtime]]
