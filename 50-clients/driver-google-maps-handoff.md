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

## What the destination means (measured 2026-11-18, RCAB-E8.S22)

The app sends the ride's exact coordinate. Google Maps puts its destination pin exactly there but ends the **route** on the nearest road it can drive to, so a point off the road shows a gap between the pin and where navigation finishes. Walking the flow on the emulator: the preset pickup (26.175, 91.751) is 20 m from a road, the drop-off (26.167, 91.7898) is 169 m (inside a park) and Google ended its route at the park's edge. There is **no fixed OSM-to-Google offset** to add; the gap is simply the distance from the point to the road. The fix is upstream: the web client snaps pickup and drop-off to the road at booking (`GET /v1/rides/snap`), so the coordinate handed to Google is already on a road and needs no further adjustment here.

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
