---
title: RCAB-E5.S6 — Web booking UI — 'Share' default + pool-update events
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e5-shared-booking]]
demo: 4
estimate: m
hitl: yes
depends_on: [[story-rcab-e5-s3-pool-lifecycle]], [[story-rcab-e5-s5-shared-ride-pricing]], [[journey-client-book-shared]], [[web-pages-routes]], [[websocket-events]], [[module-realtime]]
affected_notes: [[journey-client-book-shared]], [[web-pages-routes]], [[websocket-events]]
owner: claude
audience: both
---

# RCAB-E5.S6 — Web booking UI — 'Share' default + pool-update events

## Goal

The web booking page is the primary surface through which clients choose shared vs. solo. Per [[features-shared-rides]], "Share" is the default. This story updates the Next.js booking flow to show both modes, display a live pool-update badge (how many co-riders have joined), and handle the new `perSeatPrice` from the API quote. The HITL stop is the demo walk-through of the full shared booking UX.

## User-facing acceptance criteria

- `Given` the booking page loads, `When` the client hasn't changed anything, `Then` "Share" is the selected ride type (not "Private").
- `Given` a client is in the Share queue waiting for the pool to fill, `When` another rider joins the same pool, `Then` the page shows "1 other rider joining — your fare is ready" within 2 s.
- `Given` the client selects "Private", `When` the quote refreshes, `Then` the price shown is the solo fare (no `perSeatPrice` breakdown).
- `Given` the pool closes and dispatch is triggered, `When` a driver accepts, `Then` the booking page transitions to the en-route state (same as normal booking).
- `Given` the pool times out with only 1 rider, `When` solo dispatch triggers, `Then` the client sees "No co-rider found — continuing as private" and the pricing updates to solo.

## Technical acceptance criteria

- Next.js `apps/web/src/app/book/page.tsx`: add `RideTypeToggle` component with "Share" (default) / "Private" options.
- `useBookingStore` (Zustand): add `rideType: 'shared' | 'private'`; pass `type` to quote + request API calls.
- WS event `pool:update` payload: `{ sharedRideId, seatCount, poolStatus }` — subscribe on mount, unsubscribe on unmount.
  - On `pool:update` with `seatCount > 1`: show `PoolBadge` with co-rider count.
  - On `pool:update` with `poolStatus = 'closed_timeout'` and `seatCount = 1`: show solo-fallback banner.
- `quoteResponse.perSeatPrice` rendered alongside total price when `rideType = 'shared'`.
- Server-side: `RealtimeGateway` emits `pool:update` to the requesting client's socket room on every `slotRequest` call.

## Test plan

- **Unit (Vitest / React Testing Library):** `RideTypeToggle` renders with "Share" selected by default; toggling to "Private" fires the store update.
- **Integration (Playwright):** open booking page → submit shared request → assert `pool:update` badge appears after injecting a WS event → assert solo-fallback banner on `closed_timeout` with 1 seat.
- **E2E demo walk (HITL):** full flow from booking page to driver accept — dev must sign off visually.

## HITL stops

1. After implementation: dev walks the demo flow on `localhost` — share booking → pool badge → driver accept. Sign off in PR description before merging.

## Out of scope

- Map view of co-rider pickup points on the client side — Phase-1.
- Push notifications (FCM) for pool updates — those are Phase-0 stretch; defer to E7.
- Client cancellation of a pooled request — covered by E4.S8 cancellation paths.

## Notes / questions

- The `pool:update` WS event should target only the sockets of clients in that pool (room: `pool:<pool_id>`). The `RealtimeGateway` must join the client's socket to this room when the pool is opened/slotted.
- Next.js `'use client'` boundary: the booking page is already a client component for the map; no server component boundary issues.

## See also

- [[epic-e5-shared-booking]] · [[journey-client-book-shared]] · [[features-shared-rides]]
- [[web-pages-routes]] · [[websocket-events]] · [[module-realtime]]
- [[story-rcab-e5-s3-pool-lifecycle]] · [[story-rcab-e5-s5-shared-ride-pricing]]
