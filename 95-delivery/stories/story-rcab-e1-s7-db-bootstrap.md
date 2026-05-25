---
title: RCAB-E1.S7 — Postgres + Redis + OSRM containers + migration runner
tags: [layer/delivery, kind/story]
status: done
phase: 0
epic: [[epic-e1-foundation]]
demo: 0
estimate: s
hitl: no
depends_on: [[story-template]], [[stories-index]]
affected_notes: [[schema-postgres]], [[redis-usage]], [[integration-osrm]], [[migrations]]
owner: claude
audience: both
---

# RCAB-E1.S7 — Postgres + Redis + OSRM containers + migration runner

## Goal

The three data-tier containers start cleanly, with the migration runner applying the empty initial schema before `api` boots. OSRM uses a small fixture PBF in dev / test, and the production PBF path in prod.

## User-facing acceptance criteria

- `Given` `docker compose up`, `When` it completes, `Then` Postgres has the expected extensions (`postgis`, `uuid-ossp`) loaded and the migration table shows the bootstrap migration as applied.
- `Given` the API is up, `When` it calls `redis.ping()`, `Then` it returns `PONG`.
- `Given` the API is up, `When` it calls `osrm /route/v1/driving/...` for a fixture city, `Then` it returns a valid route.

## Technical acceptance criteria

- `infra/docker/postgres/Dockerfile` extends `postgis/postgis:16-3.4` with our `init.sql` to install extensions.
- Drizzle migration runner is a one-shot `migrator` container; `api` `depends_on: { migrator: { condition: service_completed_successfully } }`.
- Initial migration `0001_init.sql` creates only `app_user`, `client`, `driver`, `vehicle` (skeleton for [[epic-e2-auth]] + [[epic-e3-driver-presence]]). Heavier tables (`ride`, `ride_request`, etc.) land in their owning epics.
- Redis configured with AOF on (`appendfsync everysec`).
- OSRM Dockerfile bakes a fixture PBF for dev/test; prod overlay mounts the real PBF via a named volume.

## Test plan

- Integration: connect to the three services through their Node drivers and validate round-trip.

## Out of scope

- Full Phase-0 schema — each epic adds its own tables.
- OSRM India PBF — that's an ops task pre-prod ([[backups]] adjacent).

## See also
- [[epic-e1-foundation]] · [[schema-postgres]] · [[redis-usage]] · [[integration-osrm]] · [[migrations]]
