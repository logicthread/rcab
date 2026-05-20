---
title: Journey — Driver completes a ride
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[personas-driver]]
related: [[sm-ride-lifecycle]], [[features-rating-system]]
audience: both
---

# Driver completes a ride

## Solo ride flow

1. Driver hits "I'm here" at pickup → ride goes `arrived_pickup`.
2. Driver hits "Start ride" once client is on board → `in_progress`.
3. Driver hits "End ride" at drop → `completed`. App collects optional client signature for cash payment, then prompts driver to rate the client.

## Shared-ride flow

1. Each passenger is picked up in pool order. App shows a stop list.
2. After the last pickup, ride state is `in_progress` for all pooled requests.
3. Drops happen in order; each "I've dropped this passenger" call closes that request and recomputes the next-stop route via [[integration-osrm]].
4. After the last drop, ride is `completed`. Rating prompts cycle through the passengers.

## After completion

- Backend computes per-seat fares for shared rides, the driver payout, and the platform commission. See [[features-shared-rides]] §pricing.
- Both parties receive a notification when the *other* has rated them.
- The ride enters the driver's earnings ledger and the client's history.

## See also
- [[sm-ride-lifecycle]] · [[features-rating-system]]
- [[features-history-dashboard]]
