---
title: Database migrations
tags: [layer/backend]
status: accepted
phase: 0
depends_on: [[schema-postgres]]
related: [[ci-cd]]
audience: both
---

# Migrations

*Forward-only SQL files, applied in lexical order, idempotent on retry.*

## Tooling

- **Drizzle Kit** for generation; **Drizzle migrate** for application.
- Migration files live in `apps/api/migrations/NNNN_short_name.sql`.
- Migrations run via a dedicated `migrator` container (`node dist/migrate.js`) before the API container starts in docker-compose.
- Drizzle schema definitions live in `apps/api/src/db/schema.ts` (used for type-safe queries, not for migration generation in Phase-0).

## Rules

- One migration = one logical change. Don't bundle.
- **No DROP COLUMN / DROP TABLE** in Phase-0 without a follow-up ADR — Postgres is small enough that we keep history cheaply.
- Backfills run in a separate migration after the schema change is deployed.
- Every migration must be **idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, conditional `ALTER`).

## Zero-downtime

- Add column: nullable first, deploy code, then backfill, then `NOT NULL` in a follow-up.
- Rename: never. Add new column, dual-write, deprecate old.

## Local dev

`docker-compose -f docker-compose.dev.yml up postgres && pnpm migrate up`

## See also
- [[schema-postgres]] · [[ci-cd]] · [[backups]]
