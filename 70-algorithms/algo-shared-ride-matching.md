---
title: Algorithm — Shared-ride matching
tags: [layer/algorithm, kind/algo]
status: accepted
phase: 0
depends_on: [[entity-shared-ride]]
related: [[algo-route-similarity]], [[module-matching]], [[features-shared-rides]]
audience: both
---

# Shared-ride matching

*Decide whether a new shared `RideRequest` slots into an open pool or opens a new one.*

## Decision tree

```
input: request R (origin O, dest D)

candidates ← shared_ride WHERE
  ST_DWithin(origin_centroid, O, 1500)
  AND ST_DWithin(dest_centroid, D, 1500)
  AND state = 'open'
  AND seat_count < max_seats

# spatial pre-filter cheap; then refine

for each c in candidates:
  s ← route_similarity(R, c)    # see [[algo-route-similarity]]
  detour_origin ← walking_distance(O, c.origin_centroid)
  detour_dest   ← walking_distance(D, c.dest_centroid)
  fits ← s ≥ 0.7
       AND detour_origin ≤ c.detour_budget_m
       AND detour_dest  ≤ c.detour_budget_m
  if fits:
    score ← s − 0.0005 * (detour_origin + detour_dest)
    keep best

if best exists:
  slot_request_into_pool(R, best)   # Lua: pool_slot
  return { mode: 'slotted', sharedRideId: best.ride_id }
else:
  open_new_pool(R)
  return { mode: 'opened',  sharedRideId: new.ride_id }
```

## Tunables

| Param | Default | Rationale |
|---|---|---|
| spatial pre-filter radius | 1500 m | cheap cast-net; refined by detour budget |
| similarity threshold | 0.7 | empirically separates "same corridor" from "vaguely parallel" |
| origin/dest detour budget | 800 m | walking-acceptable on either end |

## Open-pool defaults

- `max_seats = 3`
- `detour_budget_m = 800`
- `pool_closed_at = now + 60s`

## Race conditions

Two new requests arriving simultaneously could both decide to open a pool for the same corridor. We accept this — they'll both open pools, and the matcher will try once more on each new request. The cost is one extra dispatch event for the second pool.

## See also
- [[algo-route-similarity]] · [[module-matching]]
- [[entity-shared-ride]] · [[features-shared-rides]]
- [[sm-shared-ride-pool]]
