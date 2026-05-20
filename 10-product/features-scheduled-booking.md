---
title: Feature — Scheduled booking
tags: [layer/product, kind/feature]
status: accepted
phase: 0
depends_on: [[vision]]
related: [[features-normal-booking]], [[journey-client-book-scheduled]], [[entity-ride-request]]
audience: both
---

# Scheduled booking

*A booking placed now for a future window (15 min – 24 hours out).*

## Flow

1. Client picks origin + destination + a target pickup time (rounded to 5-min slots).
2. Request stored as `RideRequest` with `type=scheduled`, `scheduled_for=<timestamp>`.
3. A job runner (BullMQ on Redis — see [[redis-usage]]) wakes the request 10 min before `scheduled_for` and runs [[algo-top-k-dispatch]] against drivers near the origin.
4. If no driver accepts within 4 minutes, the system notifies the client and escalates (widens radius, then notifies failure).
5. Once accepted, ride proceeds like a normal booking.

## Constraints

- Scheduled requests can be canceled freely until the dispatch wakes up. After dispatch starts, normal cancellation rules apply.
- Scheduled requests *cannot* be shared in Phase-0 — too many edge cases. (Phase-1 may revisit.)

## See also
- [[features-normal-booking]] · [[sm-booking-flow]]
- [[entity-ride-request]] · [[redis-usage]]
- [[journey-client-book-scheduled]]
