---
title: Web client — PWA strategy
tags: [layer/client-web]
status: accepted
phase: 0
depends_on: [[web-nextjs-structure]]
related: [[personas-client]]
audience: both
---

# Web client — PWA strategy

*Install prompts on Android Chrome; offline shell; cache-first for static; network-first for API.*

## Service worker

- Built with Workbox.
- **Static assets:** stale-while-revalidate, 30-day expiration.
- **Tiles:** cache-first with LRU cap (~200 tiles).
- **API calls:** network-first; no offline fallback for booking (booking offline is dangerous — we don't want to "queue" a ride).
- **App shell:** precached so the first paint after install is offline-capable.

## Install prompt

- Capture `beforeinstallprompt`, show a non-intrusive banner after the user completes at least one ride.
- Track install rate as a Phase-0 KPI.

## Limits

- Push notifications via Web Push are **not** in Phase-0 scope (iOS Safari only added support recently; we prefer to wait for parity). Drivers get FCM in the native app; clients rely on the open page + WS.

## See also
- [[web-nextjs-structure]] · [[personas-client]]
