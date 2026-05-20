---
title: Tech stack
tags: [layer/architecture]
status: accepted
phase: 0
depends_on: [[system-overview]]
related: [[ADR-0001-backend-nestjs]], [[ADR-0002-web-nextjs]], [[ADR-0003-otp-firebase]], [[ADR-0004-osm-for-booking-google-for-nav]], [[ADR-0005-postgres-primary-redis-cache]], [[ADR-0006-flutter-driver-app]]
audience: both
---

# Tech stack

*The single table that tells you what is decided and where the decision is recorded.*

| Concern | Choice | ADR |
|---|---|---|
| Backend language / framework | TypeScript on **NestJS 10**, Node 20 | [[ADR-0001-backend-nestjs]] |
| Web client | **Next.js 14** (App Router) as a PWA | [[ADR-0002-web-nextjs]] |
| Driver app | **Flutter 3.x**, Android-first | [[ADR-0006-flutter-driver-app]] |
| Auth (OTP) | **Firebase Phone Auth** | [[ADR-0003-otp-firebase]] |
| Auth (federated) | **Google Sign-In** (linked to existing user) | [[ADR-0003-otp-firebase]] |
| Maps — client | **OSM** tiles, **Leaflet** (with MapLibre upgrade path) | [[ADR-0004-osm-for-booking-google-for-nav]] |
| Maps — geocoding | **Nominatim** (public for Phase-0, self-host later) | [[ADR-0004-osm-for-booking-google-for-nav]] |
| Maps — routing | **OSRM** self-hosted | [[ADR-0004-osm-for-booking-google-for-nav]] |
| Maps — driver nav | **Google Maps** deeplink | [[ADR-0004-osm-for-booking-google-for-nav]] |
| Primary DB | **Postgres 16** | [[ADR-0005-postgres-primary-redis-cache]] |
| Ephemeral / queue / geo | **Redis 7** + **BullMQ** | [[ADR-0005-postgres-primary-redis-cache]] |
| Realtime transport | **Socket.IO** with Redis adapter | [[ADR-0008-socketio-realtime]] |
| Push | **FCM** (HTTP v1) | — |
| Repo layout | **Monorepo** (pnpm workspaces) — `api`, `web`, `driver-app`, `shared` | [[ADR-0007-monorepo-layout]] |
| Container runtime | docker + docker-compose | [[ADR-0009-single-vps-phase-0]] |
| Reverse proxy + TLS | nginx + certbot | — |
| Hosting | Single VPS | [[ADR-0009-single-vps-phase-0]] |
| Testing | Jest (api), Playwright (web e2e), Flutter integration tests, k6 (load) | [[testing-strategy]] |
| CI | GitHub Actions | [[ci-cd]] |
| Observability | pino logs → Loki, Prometheus, Grafana, Uptime Kuma | [[observability]] |

## See also
- [[system-overview]] · [[c4-containers]] · [[module-map]]
