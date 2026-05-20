---
title: C4 — Containers
tags: [layer/architecture, kind/diagram]
status: accepted
phase: 0
depends_on: [[c4-context]]
related: [[deployment-topology]], [[module-map]]
audience: both
---

# C4 — Containers

*Inside the rcab platform — one level deeper.*

```mermaid
flowchart TB
  subgraph Edge
    nginx[Nginx<br/>TLS, reverse proxy, static assets]
  end
  subgraph Backend["Backend (single Node process)"]
    api[NestJS HTTP + WebSocket<br/>modules: auth, rides, dispatch,<br/>matching, shared-rides, drivers,<br/>clients, rating, geo, notifications]
  end
  subgraph Data
    pg[(Postgres<br/>transactional state)]
    rd[(Redis<br/>geo / queue / pubsub / cache)]
  end
  subgraph Maps
    osrm[OSRM<br/>self-hosted routing]
  end
  web[Next.js Web app]
  flutter[Flutter Driver app]

  web --> nginx
  flutter --> nginx
  nginx --> api
  api --> pg
  api --> rd
  api --> osrm
```

## Container responsibilities

| Container | Responsibility | Tech |
|---|---|---|
| **Nginx** | TLS termination, static file serving for the Next.js build, reverse proxy to API. | nginx + certbot |
| **NestJS API** | HTTP REST + Socket.IO. Houses all business logic in modules. Single process for Phase-0. | Node 20, NestJS 10 |
| **Postgres** | Transactional state — users, drivers, vehicles, rides, ride requests, ratings. | Postgres 16 |
| **Redis** | Driver geo index (`GEOADD`), dispatch offer locks, BullMQ scheduled jobs, pub/sub for Socket.IO across future replicas. | Redis 7 |
| **OSRM** | Route + ETA computation for booking quotes and shared-ride detour checks. | OSRM backend (pre-built India PBF) |
| **Next.js web** | Client booking PWA, OSM map, Firebase Phone Auth, Google sign-in. | Next.js 14, TS |
| **Flutter app** | Driver app — go online, accept, location streaming, Google Maps handoff, FCM push. | Flutter 3.x |

## Notes on the deliberate single-process design

- NestJS modules ([[module-map]]) are firewalled with strict dependency direction; future split is mechanical.
- Socket.IO uses Redis adapter from day one even though we have one node — so scaling out doesn't break the contract. See [[module-realtime]].

## See also
- [[c4-context]] · [[deployment-topology]] · [[module-map]]
- [[nestjs-structure]] · [[service-boundaries]]
