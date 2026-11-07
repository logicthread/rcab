---
name: db-migrate
description: Inspect and apply the hand-authored SQL migrations for the API (Drizzle ORM schema, custom runner). Shows pending SQL before applying. Args: [status|new|migrate] [--dry-run].
---

# db-migrate

Migration workflow for `apps/api`. **Migrations here are hand-authored SQL**, not
`drizzle-kit generate` output: numbered files in `apps/api/migrations/` applied in order by
`apps/api/src/migrate.ts`, which records each applied filename in the `_rcab_migrations`
table. `src/db/schema.ts` is the Drizzle schema the code reads through — it must be edited
to match whatever the SQL does.

**They are not applied on container start** (`pnpm dev` only runs the app). A fresh DB or a
new migration always needs an explicit `migrate`.

## Inputs

- `$1` (optional): `status` (default), `new`, or `migrate`.
- `--dry-run` (with `migrate`): print the pending SQL, apply nothing.

Define once:
```bash
DC="docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml"
```

## `status` (default)

1. **Files on disk vs. rows in the DB:**
   ```bash
   ls -1 apps/api/migrations/
   $DC exec -T postgres psql -U rcab -d rcab -c "SELECT id, name, ran_at FROM _rcab_migrations ORDER BY id;"
   ```
   Anything on disk that is missing from the table is **pending**.

2. **Report** as a two-column list: applied (with timestamp) vs. pending.

## `new`

1. Pick the next number: highest existing prefix + 1, four digits, snake-case slug
   (e.g. `0012_driver_payout.sql`).
2. Write the SQL by hand. Keep it **additive and idempotent where possible**
   (`ADD COLUMN IF NOT EXISTS`, new CHECK constraints that accept existing rows). Existing
   files are the style reference.
3. Mirror the change in `apps/api/src/db/schema.ts` (types, checks, indexes) — code reads
   the Drizzle schema, not the SQL.
4. **HITL stop:** a destructive statement (DROP COLUMN/TABLE, type narrowing, NOT NULL on a
   populated column) must be flagged to the user before it is applied anywhere.

## `migrate`

1. Stack up?
   ```bash
   $DC ps postgres --format '{{.Status}}'
   ```
2. `--dry-run`: `cat` each pending file and stop.
3. Apply:
   ```bash
   $DC exec -T api npx tsx src/migrate.ts
   ```
   Expect `[migrator] applied 00xx_*.sql …` then `[migrator] done`.
4. Verify the schema changed as intended, e.g.:
   ```bash
   $DC exec -T postgres psql -U rcab -d rcab -c "\d rides"
   ```
5. Re-run `status` — nothing should remain pending.

## Notes

- Integration tests build their schema from the same files through
  `@rcab/test-fixtures` (`migrations.ts`), so a migration that is wrong fails `pnpm test:int`.
- `apps/api/drizzle.config.ts` exists for **Drizzle Studio and `drizzle-kit check`**
  (see `/drizzle-studio`). Do not commit `drizzle-kit generate` output as-is — it doesn't
  match the hand-authored file conventions the runner and the fixtures expect.
- `pnpm dev:down -v` wipes the volume; the next `dev:up` needs `migrate` again.
