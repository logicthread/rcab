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

## See also
- [[web-nextjs-structure]] · [[web-osm-integration]] · [[websocket-events]]
