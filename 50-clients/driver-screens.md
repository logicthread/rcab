---
title: Driver app — screens
tags: [layer/client-driver]
status: accepted
phase: 0
depends_on: [[driver-flutter-structure]]
related: [[journey-driver-go-online]], [[journey-driver-accept-ride]], [[journey-driver-complete-ride]]
audience: both
---

# Driver app — screens

| Route | Screen | Notes |
|---|---|---|
| `/sign-in` | Phone OTP + (optional) Google link | First-launch only |
| `/home` | Big online/offline toggle, today's earnings, last ride | Default after sign-in |
| `/offer/:id` | Ride offer with map, fare, accept/decline | Modal-style; auto-opens on `ride_offer` event |
| `/ride/:id` | Active solo ride — state buttons, "Navigate" → Google Maps | |
| `/shared-ride/:id` | Active shared ride — ordered stop list (PICKUP/DROP per passenger), sequential confirm button, auto-routes to `/rating/:id` on last drop | RCAB-E5.S7 |
| `/rating/:id` | Post-ride rating prompt (stub in E5.S7; full UI lands in RCAB-E7.S1) | |
| `/earnings` | Today / week / month aggregates, ride list | |
| `/profile` | Vehicle selector, license info | |

## Critical UX rules

- The **online toggle** is always reachable in two taps from anywhere.
- The **offer screen** must render under 200 ms from event receipt.
- Audible + haptic alert on offer (12 s TTL is short).
- "Navigate" button is the most prominent thing on the ride screen.

## See also
- [[driver-flutter-structure]] · [[journey-driver-go-online]] · [[journey-driver-accept-ride]]
