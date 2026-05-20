---
title: Integration — Google Maps deeplink (driver nav)
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[driver-google-maps-handoff]], [[ADR-0004-osm-for-booking-google-for-nav]]
audience: both
---

# Google Maps deeplink

*Driver-only. We don't use the Google Maps SDK; we just open the consumer app.*

## URI scheme

```
google.navigation:q=<lat>,<lng>&mode=d
```

Open with `url_launcher` (`LaunchMode.externalApplication`). No API key, no quota.

## What this means legally

- We're not embedding Google Maps. We're opening the user's own installed Google Maps app with a destination.
- This falls under standard "deeplink" behavior, not the Maps Platform terms.

## What we lose by deeplinking

- We can't read the driver's ETA from Google Maps. We use our own OSRM-based ETA for the client side.
- Switching back to rcab requires the driver to tap our notification or the recents tray.

## Fallback for non-GMaps installs

```
geo:<lat>,<lng>?q=<lat>,<lng>(Pickup)
```

## See also
- [[driver-google-maps-handoff]] · [[ADR-0004-osm-for-booking-google-for-nav]]
