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

- Migrations are **hand-authored SQL** in `apps/api/migrations/NNNN_short_name.sql` (currently `0001` to `0017`). They are not generated: Drizzle Kit is used only for Drizzle Studio (`apps/api/drizzle.config.ts`).
- A small custom runner, `apps/api/src/migrate.ts`, applies the files in lexical order, records each in the `_rcab_migrations` table, and holds a session-level Postgres advisory lock for the whole run so two migrators cannot interleave. The migration body and its history row are two statements, not one transaction, so keep every migration idempotent (below).
- In production a one-shot `migrator` service (`node dist/migrate.js`, in `docker-compose.prod.yml`) runs before `api` starts; `scripts/deploy/deploy.sh` runs it explicitly and aborts the release if it fails.
- Drizzle table definitions live in `apps/api/src/db/schema.ts` and are used for type-safe queries. They must be edited together with the SQL migration; nothing checks that they agree except the integration tests.

## Rules

- One migration = one logical change. Don't bundle.
- **No DROP COLUMN / DROP TABLE** in Phase-0 without a follow-up ADR — Postgres is small enough that we keep history cheaply.
- Backfills run in a separate migration after the schema change is deployed.
- Every migration must be **idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, conditional `ALTER`).

## Zero-downtime

- Add column: nullable first, deploy code, then backfill, then `NOT NULL` in a follow-up.
- Rename: never. Add new column, dual-write, deprecate old.

## Local dev

Migrations are **not** applied when the dev stack starts or a container restarts:

```bash
docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts   # or /db-migrate
```

Integration tests apply the same files to a throwaway Testcontainers Postgres through `runMigrations()` in `@rcab/test-fixtures`.

## See also
- [[schema-postgres]] · [[ci-cd]] · [[backups]]
