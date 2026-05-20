---
title: Persona — Driver
tags: [layer/product, kind/persona]
status: accepted
phase: both
depends_on: [[vision]]
related: [[personas-client]], [[journey-driver-go-online]]
audience: both
---

# Driver persona

*An owner-operator of a cab, auto, or two-wheeler who treats driving as their primary income.*

## Snapshot

- Owns or leases the vehicle. Knows the city well — wants assistance, not micromanagement.
- Uses an Android phone, mounts it on the dash.
- Strong familiarity with Google Maps — preferring it for navigation. We honor that.
- Some drivers operate multiple shared routes (e.g., college rush 8–10am, station hop 5–8pm).

## Top jobs-to-be-done

1. Toggle "online" when starting a shift; receive ride requests.
2. See pickup location and estimated payout before accepting.
3. Hand off to Google Maps for turn-by-turn navigation.
4. Pick up passengers one by one on a shared ride.
5. Mark drop-offs, collect cash, end the ride.
6. Track today's / this week's earnings and ratings.

## Constraints we must respect

- The app **must keep working when backgrounded** (location streaming).
- The app **must not drain the battery** — duty-cycle GPS smartly.
- Notifications for new rides must be reliable even when the phone is locked (FCM with high-priority data messages).
- Driver attention is sacred: never offer a ride that's > 4 km away or > 6 min ETA from current position.

## Anti-personas

- A casual driver doing 1–2 rides a week — not the dispatch model we are tuning for.

## See also
- [[journey-driver-go-online]] · [[journey-driver-accept-ride]] · [[journey-driver-complete-ride]]
- [[driver-flutter-structure]] · [[driver-background-location]] · [[driver-google-maps-handoff]]
