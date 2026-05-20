---
title: Driver app — Google Maps handoff
tags: [layer/client-driver]
status: accepted
phase: 0
depends_on: [[driver-flutter-structure]]
related: [[integration-google-maps-deeplink]], [[ADR-0004-osm-for-booking-google-for-nav]]
audience: both
---

# Driver app — Google Maps handoff

*Driver hits "Navigate"; we open Google Maps in turn-by-turn mode with the right destination.*

## Why hand off

Drivers in our market already use Google Maps daily, trust its traffic data, and prefer its voice prompts. Building (or licensing) in-app turn-by-turn is months of work for zero retention benefit. See [[ADR-0004-osm-for-booking-google-for-nav]].

## Deeplink

```
google.navigation:q=<lat>,<lng>&mode=d
```

- `mode=d` for driving. (Bikes/autos: still `d` — the modes Google supports don't map to autos.)
- Open via `url_launcher` with `LaunchMode.externalApplication`.

## Fallback

If Google Maps isn't installed (rare in India):

```
geo:<lat>,<lng>?q=<lat>,<lng>(Pickup)
```

Falls through to whichever maps app is the user default.

## Inside rcab app

We do NOT render a separate routing line. The driver sees:

- Current pickup card with address.
- A small static OSM map preview (we already have OSM for client side; reusing the tile cache).
- The big "Navigate" button.

## See also
- [[integration-google-maps-deeplink]] · [[journey-driver-accept-ride]]
- [[ADR-0004-osm-for-booking-google-for-nav]]
