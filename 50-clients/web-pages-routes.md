---
title: Web client — pages & routes
tags: [layer/client-web]
status: accepted
phase: 0
depends_on: [[web-nextjs-structure]]
related: [[journey-client-otp-signup]], [[journey-client-book-shared]], [[features-history-dashboard]]
audience: both
---

# Web client — pages & routes

*All client-facing URLs. Authenticated unless marked public.*

| Path | Surface | Notes |
|---|---|---|
| `/` (public) | Marketing landing | SSR; PWA install prompt for return visits |
| `/sign-in` (public) | Phone + OTP, Google | [[journey-client-otp-signup]] |
| `/book` | Booking screen + live tracking | default landing post-auth. Leaflet map pick/drop with Nominatim search + reverse-geocode and a live OSRM quote (distance / ETA / fare + drawn route line) — RCAB-E4.S1. Ride-type toggle (`Share` default); `Book share` submit + WS `pool:update` badge / solo-fallback banner (RCAB-E5.S6). **RCAB-E4.S7:** the `Book` (private/solo `normal`) submit is wired (`POST /v1/rides` + idempotency key), and once a solo ride is created the screen flips **in-place** to a live-tracking view — driver marker on the same map (`driver_location`) + a status banner (`ride_state_changed`), rehydrated on reload from `GET /v1/rides/:id`. |
| `/ride/:id` | *(not a web route)* | Solo rider tracking is rendered **in-place on `/book`** (RCAB-E4.S7), not a separate page. `/ride/:id` is the **driver app** screen ([[driver-screens]]); the web client follows via the `ride:<id>` WS room. |
| `/history` | Past rides + dispute | [[features-history-dashboard]] |
| `/history/:id` | Single past ride detail | |
| `/settings` | Profile, saved places, link Google | [[journey-client-google-link]] |
| `/help` | Static FAQ | |

## Route conventions

- Authenticated routes live under `(app)/` segment with a layout that asserts auth + renders the bottom nav.
- Public routes live under `(public)/` and lazy-load Firebase auth only when reaching `/sign-in`.

## See also
- [[web-nextjs-structure]] · [[web-state-management]] · [[web-auth-firebase]]
