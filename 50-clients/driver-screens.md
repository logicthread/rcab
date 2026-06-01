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
| `/offer/:id` | Solo ride offer: pickup/dropoff, fare, 12 s countdown, Accept / Decline | RCAB-E4.S5. Auto-opens on a solo `ride_offer`; audible + haptic on arrival. Accept → `ride_offer_response{accept:true}`; win (`ride_offer_accepted`) → `/ride/:rideId`; revoke / decline / countdown-expiry → `/home`. Shared offers use `/shared-ride/:id` instead. |
| `/ride/:id` | Active solo ride — single status action button (Start trip → I've arrived → Start ride → End ride) + prominent "Navigate" → Google Maps; plus **Cancel ride** (reason picker) and **Report no-show** | RCAB-E4.S6/S8. Each forward tap `POST`s `/v1/rides/:id/state`; status hydrated via `GET /v1/rides/:id` on mount (reconnect-restore). "Navigate" targets the pickup until `in_progress`, then the dropoff. Auto-routes to `/rating/:id` on `completed`. **RCAB-E4.S8:** "Cancel ride" (pre-`completed`) prompts a reason → `POST /v1/rides/:id/cancel { reason }`; "Report no-show" shows once `arrived` and **enables only after a 5-min wait** (countdown off `arrived_at`) → `POST … { event: 'mark_no_show' }`. Terminal `cancelled` / `no_show` routes to `/home`. No fee in Phase-0. |
| `/shared-ride/:id` | Active shared ride — ordered stop list (PICKUP/DROP per passenger), sequential confirm button, auto-routes to `/rating/:id` on last drop | RCAB-E5.S7 |
| `/rating/:id` | Post-ride rating prompt — 1–5 star selector + optional comment, **Submit** / **Skip** | **RCAB-E4.S9** (was an E5.S7 stub). Submit → `POST /v1/rides/:id/ratings` then `/home`; Skip writes nothing and also routes `/home`; a repeat (409 `already_rated`) is treated as done. Shared-ride completions reach the same screen; submit is solo-only for now. Aggregation + the rating display land in E7. |
| `/earnings` | Today / week / month aggregates, ride list | |
| `/profile` | Vehicle selector, license info | |

## Critical UX rules

- The **online toggle** is always reachable in two taps from anywhere.
- The **offer screen** must render under 200 ms from event receipt.
- Audible + haptic alert on offer (12 s TTL is short).
- "Navigate" button is the most prominent thing on the ride screen.

## See also
- [[driver-flutter-structure]] · [[journey-driver-go-online]] · [[journey-driver-accept-ride]]
