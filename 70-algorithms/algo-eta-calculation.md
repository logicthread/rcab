---
title: Algorithm — ETA calculation
tags: [layer/algorithm, kind/algo]
status: accepted
phase: 0
depends_on: [[integration-osrm]]
related: [[features-normal-booking]], [[features-shared-rides]]
audience: both
---

# ETA calculation

*Two ETAs matter to us: pickup ETA (for a driver candidate) and ride ETA (for the client).*

## Pickup ETA

- Use OSRM `/route` from the driver's current position to the request origin.
- Apply a **traffic-time multiplier** by hour-of-day (no real-time traffic in Phase-0):
  - 07:00–10:00 and 17:00–20:00 (peak): × 1.35
  - else: × 1.1

Multipliers are configurable per pilot city.

## Ride ETA

- OSRM `/route` from origin → destination.
- Apply the same time-of-day multiplier.

## Confidence / display

- Round to nearest 1 min.
- Show "≈" prefix to convey imprecision.

## When OSRM is down

- Pickup ETA falls back to haversine-distance × `2.5 min/km`. Crude but keeps the flow alive.
- Quotes are not issued in this fallback — we refuse to charge a client on a guess.

## See also
- [[integration-osrm]] · [[features-normal-booking]] · [[features-shared-rides]]
