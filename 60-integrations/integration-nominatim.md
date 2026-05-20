---
title: Integration — Nominatim
tags: [layer/integration, kind/integration]
status: accepted
phase: 0
depends_on: [[integration-openstreetmap]]
related: [[web-osm-integration]]
audience: both
---

# Nominatim

*OSM geocoding — address ⇄ coordinates.*

## Endpoints we use

| Endpoint | Use |
|---|---|
| `/search` | autocomplete pick/drop |
| `/reverse` | label a dragged pin |

## Hosting

- **Phase-0:** public Nominatim (`nominatim.openstreetmap.org`) with strict adherence to their 1 req/sec policy. We rate-limit at the API layer (Nominatim is fronted by our API, never called from the browser directly, so we control the rate).
- **Phase-1:** self-host Nominatim with a pilot-city extract. ~6 GB RAM headroom; deferred.

## Why front it through our API?

- Add caching (Redis `nominatim-cache:<hash>` with 24 h TTL).
- Hide our user-agent / contact email behind one server identity.
- Enforce rate limits in one place.
- Switch providers (or self-host) without touching the client.

## See also
- [[integration-openstreetmap]] · [[integration-osrm]] · [[web-osm-integration]]
