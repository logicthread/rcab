---
title: Entity — Location (driver position samples)
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[entity-driver]]
related: [[entity-ride]], [[redis-usage]]
audience: both
---

# Location

*A driver's GPS sample. Mostly Redis-resident; partly archived to Postgres.*

## Two-tier storage

- **Hot (Redis):** the *current* position only (GEO index keyed by `driver_id`). Updated every ~5 s while online.
- **Warm (Postgres `ride_location_sample`):** position samples are persisted **only during active rides** for billing reconciliation and disputes.

We deliberately do **not** persist every position of every driver continuously. That data has no business value in Phase-0 and is expensive.

## Schema (ride_location_sample)

| Field | Type | Notes |
|---|---|---|
| ride_id | uuid | fk |
| ts | timestamptz | |
| point | geography(Point,4326) | |
| speed_mps | real | nullable |

Indexed `(ride_id, ts)`. Pruned after 90 days.

## See also
- [[entity-driver]] · [[entity-ride]]
- [[redis-usage]] · [[driver-background-location]]
