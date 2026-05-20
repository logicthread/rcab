---
title: Feature — Normal booking
tags: [layer/product, kind/feature]
status: accepted
phase: 0
depends_on: [[vision]]
related: [[features-shared-rides]], [[features-scheduled-booking]], [[algo-top-k-dispatch]], [[journey-client-book-normal]], [[sm-ride-lifecycle]]
audience: both
---

# Normal booking

*Solo, on-demand, point-to-point. The fallback when sharing doesn't fit.*

## Flow

1. Client picks origin + destination on the OSM map (see [[web-osm-integration]]).
2. App calls `POST /rides/quote` to get an OSRM-routed distance/ETA/fare.
3. Client confirms → `POST /rides/requests` with `type=normal`.
4. Backend places the request into [[sm-booking-flow]] and runs [[algo-top-k-dispatch]] with K=5.
5. First driver to accept gets the ride; the others' offers expire.
6. Ride moves into the lifecycle [[sm-ride-lifecycle]].

## Constraints

- If no driver accepts within 30 s, top-K expands to K=10 (wave 2). After 60 s total, the request fails with an actionable error.
- Quote is valid for 5 min. After that, a re-quote is required.

## See also
- [[features-shared-rides]] · [[features-scheduled-booking]]
- [[algo-top-k-dispatch]] · [[sm-booking-flow]] · [[sm-ride-lifecycle]]
- [[journey-client-book-normal]]
