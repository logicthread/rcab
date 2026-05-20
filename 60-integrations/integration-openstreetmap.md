---
title: Integration — OpenStreetMap
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[web-osm-integration]], [[integration-nominatim]], [[integration-osrm]], [[ADR-0004-osm-for-booking-google-for-nav]]
audience: both
---

# OpenStreetMap

*The umbrella note for our OSM stack. Tiles + geocoding + routing.*

## Components we use

| Component | Hosting | Purpose |
|---|---|---|
| OSM tile servers | Public (Phase-0); CDN provider (Phase-1) | Map tiles for the booking screen |
| Nominatim | Public (Phase-0); self-hosted (Phase-1) | Address autocomplete + reverse-geo |
| OSRM | Self-hosted from day 1 | Routing + ETA |

See [[integration-nominatim]], [[integration-osrm]] for component-specific details.

## Attribution

All map views must display "© OpenStreetMap contributors" with a link to `https://www.openstreetmap.org/copyright`. Non-negotiable per ODbL.

## Acceptable use

OSM's public tile server has a "no heavy usage" policy. We:

- Cache tiles client-side.
- Debounce pan/zoom.
- Avoid prefetching tiles speculatively.
- Plan a switch to a paid/CDN tile provider when our usage warrants.

## Why OSM and not Google Maps for the client app

See [[ADR-0004-osm-for-booking-google-for-nav]]. Cost, vendor lock-in, and offline self-hostability are the headline reasons.

## See also
- [[web-osm-integration]] · [[integration-nominatim]] · [[integration-osrm]]
- [[ADR-0004-osm-for-booking-google-for-nav]]
