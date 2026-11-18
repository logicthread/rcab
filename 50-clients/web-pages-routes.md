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
| `/history` | Past rides (list: date, fare, status; empty + error states) | [[features-history-dashboard]] · RCAB-E8.S19 (dispute and detail still to come) |
| `/profile` | Name (editable), email, phone, member since | RCAB-E8.S19 |
| `/feedback` | Feedback form (category + message) → `POST /v1/feedback` | RCAB-E8.S20 |
| `/history/:id` | Single past ride detail | |
| `/settings` | Profile, saved places, link Google | [[journey-client-google-link]] |
| `/help` | Support chat (replaces the static FAQ): thread with "rcab support", polled every 5 s | RCAB-E8.S20 |

The `/book` header opens a left **side menu** (Vaul drawer, RCAB-E8.S19) with Profile, Ride history, Give feedback, Contact help, the System / Light / Dark theme switch and Sign out. `/book` also shows a vehicle picker and, with `FEATURES.sharedRides` off, no ride-type toggle ([[story-rcab-e8-s18-booking-vehicle-picker-share-flag]]).

## Route conventions

- Authenticated routes live under `(app)/` segment with a layout that asserts auth + renders the bottom nav.
- Public routes live under `(public)/` and lazy-load Firebase auth only when reaching `/sign-in`.

## See also
- [[web-nextjs-structure]] · [[web-state-management]] · [[web-auth-firebase]]
