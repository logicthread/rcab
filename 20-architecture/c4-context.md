---
title: C4 — System context
tags: [layer/architecture, kind/diagram]
status: accepted
phase: 0
depends_on: [[system-overview]]
related: [[c4-containers]]
audience: both
---

# C4 — System context

*The system as a black box surrounded by its users and external services.*

```mermaid
flowchart TB
  client((Client<br/>commuter))
  driver((Driver))
  rcab[/rcab platform/]
  fb[Firebase Auth]
  goa[Google OAuth]
  fcm[FCM push]
  osm[OSM tiles + Nominatim]
  gmaps[Google Maps mobile app]

  client -->|books rides, tracks, rates| rcab
  driver -->|goes online, accepts rides, navigates, rates| rcab
  rcab --> fb
  rcab --> goa
  rcab --> fcm
  rcab --> osm
  driver -->|turn-by-turn navigation| gmaps
```

## Actors & systems

| Actor / System | Role |
|---|---|
| Client (commuter) | Books normal / shared / scheduled rides. |
| Driver | Accepts and completes rides. |
| Firebase Auth | Phone OTP verification + Google ID-token issuance. |
| Google OAuth | (Indirectly via Firebase) account-link identity. |
| FCM | Push delivery to driver devices. |
| OpenStreetMap ecosystem | Tiles, geocoding (Nominatim), routing (OSRM, internal). |
| Google Maps (app) | Driver-side turn-by-turn — invoked via deep link. |

## See also
- [[c4-containers]] · [[system-overview]]
