import type { Config } from 'drizzle-kit';

/**
 * Drizzle Kit config — used by Drizzle Studio (`/drizzle-studio`) and by
 * `drizzle-kit check`/`introspect`.
 *
 * Migrations in this project are HAND-AUTHORED SQL under ./migrations and applied by
 * src/migrate.ts. Do not commit `drizzle-kit generate` output without reading it first;
 * the runner records applied files in the `_rcab_migrations` table.
 *
 * Default credentials target the dev compose Postgres as published on the host
 * (55432 → container 5432). Override with DATABASE_URL when pointing elsewhere.
 */
export default {
  schema: './src/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://rcab:rcab@localhost:55432/rcab',
  },
} satisfies Config;
