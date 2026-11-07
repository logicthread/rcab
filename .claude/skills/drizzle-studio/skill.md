---
name: drizzle-studio
description: Launch Drizzle Studio for interactive schema browsing and ad-hoc queries against the dev database. No args.
---

# drizzle-studio

Visual schema/data browser for the dev Postgres. Config lives at `apps/api/drizzle.config.ts`
(schema `src/db/schema.ts`, out `./migrations`).

The dev Postgres is published on **host port 55432** (container 5432) — host 5432 is usually
taken by a locally-installed Postgres, so don't assume it.

## Inputs

None. `DATABASE_URL` overrides the default
`postgres://rcab:rcab@localhost:55432/rcab`.

## Steps

1. **Check the dev database is running.**
   ```bash
   docker compose --env-file .env.dev -f infra/docker/docker-compose.dev.yml ps postgres --format '{{.Status}} {{.Ports}}'
   ```
   Expect `Up … (healthy)` and `0.0.0.0:55432->5432/tcp`. If the port mapping is missing, the
   compose file was changed — fall back to `psql` through `exec` (see `/db-migrate`).

2. **Launch Studio** (foreground; it keeps running until Ctrl+C):
   ```bash
   cd apps/api && npx drizzle-kit studio
   ```
   Add `--port 4983` to pin the port.

3. **Report the URL:** `https://local.drizzle.studio` (the hosted UI talks to the local
   drizzle-kit server on `127.0.0.1:4983`; hitting `:4983` directly returns 404 — that's
   normal, not a failure).

4. **Expected tables** (public schema): `app_user`, `client`, `driver`, `vehicle`,
   `auth_refresh_token`, `rides`, `shared_rides`, `ride_stops`, `ratings`, `_rcab_migrations`
   (+ PostGIS views `geography_columns`, `geometry_columns`, `spatial_ref_sys`).

## When to use

- Inspecting entity relationships during schema work
- Verifying a migration's result visually
- Ad-hoc queries during debugging

## Anti-patterns

- Don't leave Studio running during load tests — it adds overhead.
- Don't point it at prod. For prod inspection use a read-only `psql` session.
- Don't use Studio to "fix" schema drift — write a migration (`/db-migrate new`).
