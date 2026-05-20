---
title: Database choice
tags: [layer/backend, layer/decision]
status: accepted
phase: 0
depends_on: [[tech-stack]]
related: [[ADR-0005-postgres-primary-redis-cache]], [[schema-postgres]], [[redis-usage]]
audience: both
---

# Database choice

*Postgres as system of record; Redis as ephemeral / fast-path.*

See [[ADR-0005-postgres-primary-redis-cache]] for the full rationale. The summary:

- **Postgres** is the system of record for all transactional state. PostGIS for points; geographies in EPSG:4326.
- **Redis** holds: driver geo index (`GEOADD`), dispatch offer locks, BullMQ scheduled jobs, Socket.IO adapter pub/sub, hot caches (60 s TTL on heavy reads).
- **MongoDB is deferred to Phase-1** for high-volume append-only data (location traces, raw ratings).

## See also
- [[schema-postgres]] · [[redis-usage]] · [[migrations]]
- [[ADR-0005-postgres-primary-redis-cache]]
