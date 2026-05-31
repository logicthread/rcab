---
title: Web client — state management
tags: [layer/client-web]
status: accepted
phase: 0
depends_on: [[web-nextjs-structure]]
related: [[web-osm-integration]]
audience: both
---

# Web client — state management

*Server state via React Query; UI state via Zustand; realtime via a Socket.IO context.*

## Layers

| Layer | Tool | Use for |
|---|---|---|
| Server cache | TanStack Query (React Query) | API responses, mutations, optimistic updates |
| Realtime cache | Socket.IO + setQueryData | WS events patch React Query caches in place |
| Local UI | Zustand (one tiny store per feature) | booking draft, modal open/close, map viewport |
| URL | Next.js router | navigation, deep linking |

## Realtime → server cache bridge

Pattern: every WS event we receive carries enough info to update one or more queries. We don't render directly from the WS — the gateway hook updates query caches and the components stay query-driven.

```ts
// pseudo
socket.on('ride_state_changed', ({ ride_id, state }) => {
  queryClient.setQueryData(['ride', ride_id], (old) => ({ ...old, state }));
});
```

This keeps a single source of truth and survives reconnect (queries refetch on focus).

## Booking draft

The draft is a Zustand store hydrated from `localStorage`. If the user closes the tab mid-booking, they can resume.

## Solo live-tracking (RCAB-E4.S7)

The booking store (`lib/booking/store.ts`) gained a `tracking` stage plus `{ rideId, rideStatus, driver }`. Rather than the React-Query bridge above, the booking surface consumes `ride_state_changed` (→ `applyRideState`) and `driver_location` (→ `applyDriverLocation`) **directly into the Zustand store** — the booking flow is Zustand-first, not query-backed. The active solo `rideId` is persisted to `localStorage` (`rcab_active_ride`); on a full reload the page rehydrates via `GET /v1/rides/:id` and re-`ride:subscribe`s the socket. Terminal states (`completed`/`no_driver`/`cancelled`/`no_show`) clear the key.

**RCAB-E4.S8 — cancel:** the tracking panel shows a **Cancel ride** button before the trip starts (hidden once `in_progress` or terminal); `cancelActiveRide` calls `POST /v1/rides/:id/cancel` and applies the returned status. `no_show` is a recognised terminal status; cancellation is **free in Phase-0** (no fee surfaced).

## See also
- [[web-nextjs-structure]] · [[web-osm-integration]] · [[websocket-events]]
