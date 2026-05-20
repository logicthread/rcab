---
title: Entity — SharedRide
tags: [layer/domain, kind/entity]
status: accepted
phase: 0
depends_on: [[entity-ride]]
related: [[features-shared-rides]], [[algo-shared-ride-matching]], [[sm-shared-ride-pool]]
audience: both
---

# SharedRide

*Adjunct to a [[entity-ride]] of type `shared`. Holds the pool concept.*

## Fields

| Field | Type | Notes |
|---|---|---|
| ride_id | uuid | pk, fk → ride.id |
| route_id | uuid | fk → route.id (the emergent corridor) |
| seat_count | int | how many pooled requests |
| max_seats | int | cap (3 for Phase-0) |
| pool_opened_at | timestamptz | when the pool was created |
| pool_closed_at | timestamptz | when joining ends — pool no longer accepts adds |
| detour_budget_m | int | how much extra distance we allow for adds |
| origin_centroid | geography(Point,4326) | for fast matching against new requests |
| dest_centroid | geography(Point,4326) | |

## Lifecycle

- Created when a new shared request **opens** a pool (no existing match).
- Other compatible requests are **slotted** in via [[algo-shared-ride-matching]].
- Pool closes when:
  - Driver starts the ride, or
  - `pool_closed_at` reaches now, or
  - `seat_count == max_seats`.

See [[sm-shared-ride-pool]] for full state machine.

## See also
- [[entity-ride]] · [[entity-route]]
- [[algo-shared-ride-matching]] · [[features-shared-rides]]
- [[sm-shared-ride-pool]]
