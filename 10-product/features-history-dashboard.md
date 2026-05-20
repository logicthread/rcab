---
title: Feature — History & dashboard
tags: [layer/product, kind/feature]
status: accepted
phase: 0
depends_on: [[vision]]
related: [[entity-ride]], [[entity-rating]]
audience: both
---

# History & dashboard

*Past rides for clients; earnings + ratings + ride list for drivers.*

## Client dashboard (Phase-0)

- List of past rides (paginated, newest first).
- For each ride: date, route map preview, fare, driver name, rating given, link to dispute.
- "Repeat this ride" CTA → prefills booking with same pick/drop.

## Driver dashboard (Phase-0)

- Today: rides served, earnings, hours online, average rating today.
- This week: same metrics aggregated.
- Ride list with timestamps and seat counts (shared rides distinguished).
- Cash collected vs. platform commission split.

## Backing data

All from existing tables — no new aggregations needed. Heavy queries cached in Redis with a 60 s TTL.

## See also
- [[entity-ride]] · [[entity-rating]]
- [[rest-endpoints]]
