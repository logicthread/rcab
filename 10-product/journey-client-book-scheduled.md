---
title: Journey — Client books a scheduled ride
tags: [layer/product, kind/journey]
status: accepted
phase: 0
depends_on: [[features-scheduled-booking]]
related: [[redis-usage]], [[algo-top-k-dispatch]]
audience: both
---

# Client books a scheduled ride

## Flow

1. Client picks pick/drop and a future pickup slot (15 min – 24 h ahead, 5-min granularity).
2. Quote + confirm (`type=scheduled, scheduled_for=T`).
3. Backend persists the request and **enqueues a delayed job** in BullMQ (Redis) for `T - 10 min`.
4. At wake time, the job kicks off [[algo-top-k-dispatch]]. Behavior thereafter matches [[journey-client-book-normal]].
5. The client receives a push notification when the request goes live ("Looking for your scheduled driver…") and another when matched.

## Cancellation

- Before wake: instant cancel, no penalty.
- After wake but before driver acceptance: same as normal booking.
- After driver acceptance: standard cancellation rules.

## Edge cases

- Server restart while a delayed job is queued — BullMQ on Redis recovers; the job is still due.
- A scheduled request whose `scheduled_for` is < 15 min from now is rejected at quote-time.

## See also
- [[features-scheduled-booking]] · [[redis-usage]]
- [[algo-top-k-dispatch]] · [[sm-booking-flow]]
