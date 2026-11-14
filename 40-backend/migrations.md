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

*Corrected against the code on 2026-11-09 (RCAB-E8.S14). Earlier text described Drizzle Kit generation and a `pnpm migrate` command; neither exists.*

- Migrations are **hand-authored SQL** in `apps/api/migrations/NNNN_short_name.sql` (`0001_init.sql` … `0017_pool_member_agreed_fare.sql`), applied in **lexical order** by the custom runner `apps/api/src/migrate.ts`. `drizzle-kit` is used only for Drizzle Studio (`apps/api/drizzle.config.ts`); do not commit `drizzle-kit generate` output.
- The runner takes a session-level Postgres advisory lock (so concurrent migrators serialise), creates `_rcab_migrations(name UNIQUE, ran_at)`, skips recorded names, sends each pending file as one multi-statement query (one implicit transaction) and then records the name in a **separate statement**. A crash between the two can re-run the file, so every migration must be re-runnable (known gap in `docs/operations/recovery-runbook.md` section 8).
- Drizzle schema definitions live in `apps/api/src/db/schema.ts`. They are what the code reads through and are **edited by hand to mirror the SQL** (checks, defaults, indexes). Constraint names that code must recognise are mapped in `apps/api/src/db/constraints.ts`.
- **Dev:** migrations are *not* applied automatically. `docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml exec api npx tsx src/migrate.ts` (or the `/db-migrate` skill).
- **Integration tests:** `@rcab/test-fixtures` `runMigrations` applies the same files to a fresh Testcontainers Postgres, so a broken migration fails `pnpm test:int`.
- **Production:** a one-shot `migrator` service (`node dist/migrate.js`, same image as the api) runs before api/web start; `scripts/deploy/deploy.sh` runs it as a release step and aborts (stack untouched) if it fails. Rollback never reverses a migration.

## Rules

- One migration = one logical change. Don't bundle.
- **No DROP COLUMN / DROP TABLE** in Phase-0 without a follow-up ADR — Postgres is small enough that we keep history cheaply. (Destructive statements are a HITL stop.)
- Backfills run in a separate migration after the schema change is deployed.
- Every migration must be **idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, conditional `ALTER`, `DROP TRIGGER IF EXISTS` + `CREATE`).
- Rows a migration cannot repair mechanically go to the `migration_conflict` table for a human (0014, 0016), never a silent guess. Resolution procedure: `docs/operations/recovery-runbook.md` section 6.
- Guarantees belong in the database (constraints, triggers) rather than only in application checks (Stage C pattern).

## Zero-downtime

- Add column: nullable first, deploy code, then backfill, then `NOT NULL` in a follow-up.
- Rename: never. Add new column, dual-write, deprecate old.
- Production rollback re-runs older images against the newer schema: every migration must be readable by the previous release.

## Local dev

See [[docker-dev-environment]]; the commands and the full workflow are in `docs/onboarding/workflows/database-migrations.md`.

## See also
- [[schema-postgres]] · [[ci-cd]] · [[backups]]
