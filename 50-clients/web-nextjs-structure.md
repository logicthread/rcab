---
title: Web client — Next.js structure
tags: [layer/client-web]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[web-pages-routes]], [[web-state-management]], [[web-auth-firebase]], [[web-pwa-strategy]], [[web-osm-integration]]
audience: both
---

# Web client — Next.js structure

*Next.js 14 (App Router), TypeScript, PWA, OSM map.*

## Folder layout (inside `apps/web/`)

```
apps/web/
  src/
    app/                  # App Router — file-based routes
      (public)/
        layout.tsx
        page.tsx          # marketing landing
        sign-in/page.tsx
      (app)/
        layout.tsx        # authenticated shell
        book/page.tsx     # booking screen — primary surface
        ride/[id]/page.tsx
        history/page.tsx
        settings/page.tsx
      api/                # only for callback proxies if needed
    components/
      map/                # Leaflet wrappers
      booking/            # pick/drop, ride type tabs, quote panel
      ride/               # live tracking, driver card
      auth/               # phone otp, google button
      ui/                 # buttons, inputs, modal — own design system
    lib/
      api/                # typed fetch client, react-query hooks
      auth/               # Firebase init, token mgmt, refresh
      geo/                # geocoding helpers, polyline decode
      realtime/           # Socket.IO client wrapper
      pwa/                # SW registration, install prompt
    stores/               # Zustand stores (lightweight)
    types/                # shared types (some from shared/ package)
  public/
    manifest.webmanifest
    sw.ts                 # service worker (built via workbox)
  next.config.mjs
  tailwind.config.ts
```

## Conventions

- **App Router** with Server Components where they save bytes; Client Components for anything interactive.
- **No SSR for the authenticated app shell** — it's a PWA, served as a static export from `(app)/`. The `(public)/` segments may be SSR'd if marketing pages benefit.
- **React Query** for server state. **Zustand** for local UI state (booking flow, draft pick/drop). No Redux.
- **Tailwind** for styling. A small token layer in `tailwind.config.ts` enforces our color/spacing system.
- **Forms** via React Hook Form + Zod resolvers. Zod schemas can be reused as the OpenAPI source when we generate it.

## Why Next.js if we're going PWA?

- Image optimization, font loading, and code splitting come for free.
- The `(public)/` segments remain server-rendered (good for SEO on the landing).
- The team can later add a true SSR view (e.g., shareable ride link) without ripping out a framework.
- React Native code-sharing path is preserved for Phase-1.

## Build output

- `next build && next export` for `(app)/` → static assets served by nginx.
- Workbox-built service worker registered on first load.

## See also
- [[web-pages-routes]] · [[web-state-management]]
- [[web-auth-firebase]] · [[web-pwa-strategy]] · [[web-osm-integration]]
- [[ADR-0002-web-nextjs]]
