---
title: HOME — rcab architecture vault
tags: [moc, index]
status: living
audience: human
---

# rcab — Architecture Knowledge Vault

**rcab** is a human-logistics app (cab / bike / auto) for tier‑2 and tier‑3 Indian cities. The defining product feature is **shared rides on common routes**, alongside normal and scheduled booking. The client app is web-first; the driver app is Flutter.

This vault is the **source of truth for architecture**. Code is generated *from* the vault, not the other way around. If you are a future contributor (human or LLM), read [[LLM-INSTRUCTIONS]] first.

---

## How to use this vault

- **Humans:** browse by folder, or jump to any of the maps below.
- **LLMs:** open [[LLM-INSTRUCTIONS]] then [[reading-paths]]. Load only the notes the reading path tells you to.

## Maps of Content

### Product
- [[vision]] — what we're building and for whom
- [[personas-client]] · [[personas-driver]]
- Features: [[features-shared-rides]] · [[features-normal-booking]] · [[features-scheduled-booking]] · [[features-rating-system]] · [[features-top-k-dispatch]] · [[features-history-dashboard]]
- Journeys (client): [[journey-client-otp-signup]] · [[journey-client-google-link]] · [[journey-client-book-shared]] · [[journey-client-book-normal]] · [[journey-client-book-scheduled]]
- Journeys (driver): [[journey-driver-go-online]] · [[journey-driver-accept-ride]] · [[journey-driver-complete-ride]]
- Phasing: [[phase-0]] · [[phase-1]]

### Architecture
- [[system-overview]] — one-pager
- [[c4-context]] · [[c4-containers]]
- [[deployment-topology]] · [[tech-stack]]
- [[service-boundaries]] · [[scaling-strategy]]

### Domain
- [[data-model]] — overview & ER thinking
- Entities: [[entity-user]] · [[entity-client]] · [[entity-driver]] · [[entity-vehicle]] · [[entity-ride]] · [[entity-ride-request]] · [[entity-shared-ride]] · [[entity-route]] · [[entity-location]] · [[entity-rating]] · [[entity-notification]]
- State machines: [[sm-ride-lifecycle]] · [[sm-driver-availability]] · [[sm-booking-flow]] · [[sm-shared-ride-pool]]

### Backend (NestJS)
- [[nestjs-structure]] · [[module-map]]
- [[api-conventions]] · [[rest-endpoints]] · [[websocket-events]] · [[error-codes]]
- Persistence: [[database-choice]] · [[schema-postgres]] · [[redis-usage]] · [[migrations]]
- Modules: [[module-auth]] · [[module-rides]] · [[module-dispatch]] · [[module-matching]] · [[module-realtime]]

### Clients
- Web (Next.js): [[web-nextjs-structure]] · [[web-pages-routes]] · [[web-state-management]] · [[web-osm-integration]] · [[web-pwa-strategy]] · [[web-auth-firebase]]
- Driver (Flutter): [[driver-flutter-structure]] · [[driver-screens]] · [[driver-state-management]] · [[driver-background-location]] · [[driver-google-maps-handoff]] · [[driver-push-notifications]]

### Integrations
- [[integration-firebase-phone-auth]] · [[integration-google-account-link]]
- [[integration-openstreetmap]] · [[integration-nominatim]] · [[integration-osrm]]
- [[integration-google-maps-deeplink]] · [[integration-fcm]]

### Algorithms
- [[algo-top-k-dispatch]] · [[algo-shared-ride-matching]] · [[algo-route-similarity]] · [[algo-rating-aggregation]] · [[algo-eta-calculation]]

### Infrastructure
- [[vps-topology]] · [[docker-compose]] · [[nginx-reverse-proxy]] · [[ssl-letsencrypt]]
- [[ci-cd]] · [[observability]] · [[backups]] · [[secrets-management]]

### Quality
- [[testing-strategy]] · [[security-checklist]] · [[performance-budget]]

### Decisions
- [[ADR-0001-backend-nestjs]]
- [[ADR-0002-web-nextjs]]
- [[ADR-0003-otp-firebase]]
- [[ADR-0004-osm-for-booking-google-for-nav]]
- [[ADR-0005-postgres-primary-redis-cache]]
- [[ADR-0006-flutter-driver-app]]
- [[ADR-0007-monorepo-layout]]
- [[ADR-0008-socketio-realtime]]
- [[ADR-0009-single-vps-phase-0]]
- [[ADR-0010-shared-ride-route-similarity]]

### Delivery (the *how-to-ship* layer)
- [[delivery-roadmap]] — 9-demo path from `docker compose up` to pilot
- [[stories-index]] — full backlog with epic hierarchy
- [[story-template]] · [[story-id-scheme]] · [[commit-story-linkage]]
- [[demo-cadence]] · [[hitl-touchpoints]] · [[impact-analysis]]
- Epics: [[epic-e1-foundation]] · [[epic-e2-auth]] · [[epic-e3-driver-presence]] · [[epic-e4-normal-booking]] · [[epic-e5-shared-booking]] · [[epic-e6-scheduled-booking]] · [[epic-e7-rating-dashboards]] · [[epic-e8-production-hardening]] · [[epic-e9-pilot-rollout]]
- [[claude-code-launch-prompt]] — paste this into Claude Code to bootstrap implementation
- Docker workflow: [[docker-dev-environment]] · [[docker-test-environment]] · [[docker-compose]]
- Capacity check: [[local-system-probe]]

---

## Status snapshot

| Area | State |
|---|---|
| Vault scaffolded | yes (Phase‑0 scope) |
| Delivery layer | yes — roadmap, stories, HITL, impact analysis, launch prompt |
| Code | none yet — vault is the seed |
| Target | 5,000 clients, 100 drivers, single VPS |
| Next | paste [[claude-code-launch-prompt]] into Claude Code → start with [[epic-e1-foundation]] |

---

## Conventions
See [[conventions]] for frontmatter fields, tags, link style, and how to add a new note.
