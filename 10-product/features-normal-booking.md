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
4. Backend places the request into [[sm-booking-flow]] and runs [[algo-top-k-dispatch]] (waves of 20 drivers within 3 km, then 5 km, then 7 km).
5. First driver to accept gets the ride; the others' offers expire.
6. Ride moves into the lifecycle [[sm-ride-lifecycle]].

## Constraints

- If no driver accepts within 30 s the search widens to 5 km (wave 2), and at 45 s to 7 km (wave 3). After 60 s total, the request fails with an actionable error.
- **Pickup and drop-off are snapped to the nearest road** before quoting (`GET /v1/rides/snap`); the rider is told when a point moved 15 m or more, and a spot more than 500 m from any road is refused (RCAB-E8.S22). The driver's navigation therefore targets the same on-road point the rider sees.
- The booking screen offers a vehicle choice (Bike, Auto, Cab, SUV, 6 seater). **UI-only for now**: fares and dispatch do not yet depend on it (RCAB-E8.S18).
- Quote is valid for 5 min. After that, a re-quote is required.

## See also
- [[features-shared-rides]] · [[features-scheduled-booking]]
- [[algo-top-k-dispatch]] · [[sm-booking-flow]] · [[sm-ride-lifecycle]]
- [[journey-client-book-normal]]
