---
title: ADR-0004 — OSM for client booking, Google Maps for driver navigation
tags: [layer/decision, kind/adr]
status: accepted
phase: 0
related: [[integration-openstreetmap]], [[integration-osrm]], [[integration-nominatim]], [[integration-google-maps-deeplink]], [[web-osm-integration]], [[driver-google-maps-handoff]]
audience: both
---

# ADR-0004 — OSM for client booking; Google Maps for driver turn-by-turn

*Map UX for clients is built on OpenStreetMap and self-hosted OSRM. Drivers hand off to Google Maps via deeplink for turn-by-turn.*

- **Status:** accepted
- **Date:** 2026-05-19
- **Phase:** 0

## Context

We need maps in two distinct contexts with different requirements:

1. **Client booking** — pick/drop selection, search, route preview. Read-heavy, low precision required, must scale cheaply.
2. **Driver navigation** — turn-by-turn while driving, traffic data, voice prompts. Requires real-time traffic.

Google's Maps Platform is excellent but expensive at scale and licenses are restrictive.

## Decision

- **Clients:** OpenStreetMap tiles (Leaflet), Nominatim for geocoding, **self-hosted OSRM** for routing and ETA.
- **Drivers:** deeplink to the user's installed Google Maps app via `google.navigation:` URI. No SDK embedded.

## Consequences

- Positive
  - Predictable cost (effectively zero variable cost).
  - Self-hostable; no API key in client code; no usage limits we can't see.
  - Drivers get the navigation experience they actually prefer (traffic, voice).
  - Clean legal posture — deeplink to a user-installed app vs. embedding/licensing Maps Platform.
- Negative
  - We don't get Google's traffic data into our own ETA calculations. Mitigated by static time-of-day multipliers (see [[algo-eta-calculation]]).
  - OSM tile/nominatim free tiers come with usage policies we must respect (see [[integration-openstreetmap]]).
- Neutral
  - We carry the operational cost of running OSRM.

## Alternatives considered

- **Google Maps for both** — best UX, worst cost and lock-in.
- **Mapbox for clients** — strong product, but cost grows linearly; OSM gives us a self-hosted fallback.
- **Embed turn-by-turn in driver app** — months of work, marginal benefit.

## See also
- [[integration-openstreetmap]] · [[integration-osrm]] · [[integration-nominatim]]
- [[integration-google-maps-deeplink]] · [[web-osm-integration]] · [[driver-google-maps-handoff]]
