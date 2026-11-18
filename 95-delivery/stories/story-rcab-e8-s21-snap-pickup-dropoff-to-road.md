---
title: RCAB-E8.S21 — Snap pickup and drop-off to the nearest road
tags: [layer/delivery, kind/story]
status: in_review
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S21
demo: 7
estimate: m
hitl: yes
depends_on: [[integration-osrm]], [[driver-google-maps-handoff]], [[ADR-0004-osm-for-booking-google-for-nav]]
blocks:
affected_notes: [[rest-endpoints]], [[error-codes]], [[integration-osrm]], [[web-osm-integration]], [[driver-google-maps-handoff]], [[integration-google-maps-deeplink]], [[features-normal-booking]], [[policy-config]]
owner: claude
audience: both
---

# RCAB-E8.S21 — Snap pickup and drop-off to the nearest road

## Goal

The driver's "Navigate" button did not end at the rider's marker. Walking the flow end to end (rider on web, driver on the emulator, Google Maps) showed why: the app sends the exact coordinate, Google puts its pin there but ends the route at the nearest road, and the preset points sit off-road (OSRM: 20 m for the pickup, 169 m for the drop-off). There is no fixed OSM-to-Google offset to add. Fix: snap every point to the road at booking so the marker, the quote and the navigation target are the same on-road coordinate.

## User-facing acceptance criteria

- Given a pickup or drop-off chosen by search, map tap or preset, When it is set, Then it moves to the nearest drivable road and the rider sees "Pickup moved 20 m to the nearest road." when it moved 15 m or more.
- Given a spot with no road within the cap, When chosen, Then it is refused with "No road close enough to that spot. Pick a point nearer a road." and nothing is set.
- Given snapping is unavailable (offline, OSRM down), When a point is chosen, Then it is kept as picked and the quote reports any routing outage.

## Technical acceptance criteria

- `GET /v1/rides/snap?lat&lng` -> `{ lat, lng, distanceM }` via OSRM `/nearest`; 422 `no_road_nearby` beyond `rides.snapMaxMeters` (env `RIDE_SNAP_MAX_METERS`, default 500 m, proposed by Claude); 503 `routing_unavailable` when OSRM is down. `RouteSimilarityService.nearestRoad`.
- Web snaps before `setPoint` for search, map tap, presets and swap; a newer pick for the same field supersedes an older one; the map tap label comes from reverse geocoding the tapped spot.
- The ride, quote token and offer carry the snapped coordinates, so the driver app needs no change.

## Test plan

- Unit: controller (moved, no road, at the cap), web (quote uses snapped coordinates and shows notes, quiet for small shifts, refusal, fallback).
- Live: OSRM-snapped values checked through the dev API; navigation checked in Google Maps on the emulator for pickup and drop-off.

## HITL stops

- Product behaviour (a rider's pin can move up to the cap) and the cap value are owner decisions: the owner approved snapping; 500 m is the default to confirm.

## Out of scope

- Replacing the hand-typed preset coordinates with on-road points; snapping rides created before this story; an ADR (ADR-0004 is unchanged: OSM for booking, Google for navigation).

## Notes / questions

- Google's own snap can differ from OSRM's by a few metres; the on-road coordinate removes the large gap, not the last metres.

## See also
- [[epic-e8-production-hardening]] · [[integration-osrm]] · [[driver-google-maps-handoff]] · [[web-osm-integration]]
- [[story-rcab-e8-s22-dispatch-three-waves]] · [[ADR-0004-osm-for-booking-google-for-nav]]
