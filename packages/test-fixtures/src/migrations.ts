import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'apps', 'api', 'migrations');

export async function runMigrations(connectionUri: string): Promise<void> {
  const client = new Client({ connectionString: connectionUri });
  await client.connect();
  try {
    // Extensions are installed via init.sql in Docker, but Testcontainers
    // uses the base image directly — create extensions here for test parity.
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query('CREATE EXTENSION IF NOT EXISTS postgis');

    await client.query(`
      CREATE TABLE IF NOT EXISTS _rcab_migrations (
        id     serial PRIMARY KEY,
        name   text NOT NULL UNIQUE,
        ran_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT 1 FROM _rcab_migrations WHERE name = $1',
        [file],
      );
      if (rows.length > 0) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
      await client.query(sql);
      await client.query(
        'INSERT INTO _rcab_migrations (name) VALUES ($1)',
        [file],
      );
    }
  } finally {
    await client.end();
  }
}
