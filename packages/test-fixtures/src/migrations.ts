import { Client } from 'pg';

/**
 * Stub migration runner — wired here so test bootstrap already calls the right hook.
 * E1.S7 replaces the body with real SQL migration execution.
 */
export async function runMigrations(connectionUri: string): Promise<void> {
  const client = new Client({ connectionString: connectionUri });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _rcab_migrations (
        id   serial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        ran_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // No migration files registered yet — E1.S7 will populate this.
  } finally {
    await client.end();
  }
}
