---
title: Phase-0 scope
tags: [layer/product, kind/moc]
status: accepted
phase: 0
depends_on: [[vision]]
related: [[phase-1]], [[deployment-topology]], [[ADR-0009-single-vps-phase-0]]
audience: both
---

# Phase-0 — MVP

*One pilot city; 5,000 clients; 100 drivers; single VPS; cash only.*

## Targets

| Dimension | Target |
|---|---|
| Clients | 5,000 onboarded |
| Drivers | 100 active |
| Region | 1 city |
| Hosting | Single VPS (≥ 4 vCPU, 16 GB RAM, 200 GB SSD) |
| Persistence | Postgres + Redis (containers on same host) |
| Auth | Firebase Phone Auth + Google linking |
| Maps (client) | OSM (Leaflet/MapLibre + Nominatim + OSRM) |
| Maps (driver) | Google Maps deeplink for turn-by-turn |
| Payments | Cash on completion |
| Client app | Web (Next.js PWA) |
| Driver app | Flutter Android (iOS deferred) |

## In scope

- Phone OTP signup, Google account linking.
- Booking: normal, shared, scheduled.
- Top-K dispatch (K=5) with Redis geo index.
- Driver online/offline toggle + background location streaming.
- Ride lifecycle from request → matched → in_progress → completed.
- Two-way rating after each ride.
- Client history dashboard; driver earnings + ratings dashboard.
- Basic operational observability (logs, request metrics, uptime).

## Out of scope

- iOS driver app.
- Native client app (PWA only).
- In-app payments / UPI / wallet.
- Surge pricing, dynamic fares.
- Multi-city, multi-language.
- Driver onboarding workflow with document verification (manual offline process for Phase-0).
- Customer support chat / ticketing.
- A/B testing infrastructure.

## Phase-0 KPIs

- p95 dispatch latency ≤ 3 s.
- p99 backend request latency ≤ 800 ms.
- Driver app crash-free sessions ≥ 99.5%.
- Web client TTI ≤ 4 s on a throttled 3G profile.
- Shared-ride match rate ≥ 40% of shareable requests.

## See also
- [[phase-1]] · [[deployment-topology]] · [[vps-topology]]
- [[performance-budget]] · [[testing-strategy]]
