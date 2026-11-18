---
title: RCAB-E8.S18 — Account menu, profile and ride history (web + API)
tags: [layer/delivery, kind/story]
status: in_review
phase: 0
epic: [[epic-e8-production-hardening]]
story_id: RCAB-E8.S18
demo: 7
estimate: m
hitl: no
depends_on: [[story-rcab-e8-s16-web-design-system-themes]], [[features-history-dashboard]], [[rest-endpoints]]
blocks: [[story-rcab-e8-s20-driver-app-theme-menu]]
affected_notes: [[rest-endpoints]], [[module-map]], [[features-history-dashboard]], [[web-pages-routes]], [[entity-user]]
owner: claude
audience: both
---

# RCAB-E8.S18 — Account menu, profile and ride history (web + API)

## Goal

Give the rider a side menu (Profile, Ride history, Give feedback, Contact help, Theme, Sign out), a profile they can edit, and a list of their rides. The API had no `GET /v1/me` or ride list.

## User-facing acceptance criteria

- Given `/book`, When the menu button is pressed, Then a left drawer lists the five destinations, the theme switch and Sign out (sign out moved here from the header).
- Given `/profile`, When it loads, Then the rider sees their name (editable), email, phone and member-since.
- Given `/history`, When it loads, Then rides show date, fare and a readable status, newest first, with empty and error states.

## Technical acceptance criteria

- `GET /v1/me` (id, role, displayName, email, phone, memberSince; drivers add rating, trip count, current vehicle) and `PATCH /v1/me { displayName }` (1-80 chars, trimmed), in the new `account` module ([[module-map]]).
- `GET /v1/rides?limit=` (default 20, max 50): the caller's rides, newest first. A client gets bookings (`passenger_id`), a driver gets assigned trips (`driver_id`). Items: `rideId, status, type, fare, origin, dropoff, scheduledFor, createdAt`.
- Web: `components/menu-drawer.tsx` (Vaul, left), pages `/profile` and `/history`, `lib/account/api.ts`.

## Test plan

- Unit (API): controller specs for `me`, history (client, driver, limit clamp), DTO validation. Unit (web): drawer, theme switch, history and profile pages.
- Live: `GET /v1/me`, `/v1/rides` against the dev stack (verified empty list and profile for a seeded rider).

## Out of scope

- History detail view, pagination cursor, addresses on history rows (rides store coordinates only), saved places.

## Notes / questions

- Ride history is the first slice of [[features-history-dashboard]] (E7.S3 remains for detail and earnings).

## See also
- [[epic-e8-production-hardening]] · [[rest-endpoints]] · [[features-history-dashboard]] · [[web-pages-routes]]
- [[story-rcab-e8-s19-feedback-and-support-chat]] · [[story-rcab-e8-s20-driver-app-theme-menu]]
