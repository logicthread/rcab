import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function runMigrations(client: Client, migrationsDir: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _rcab_migrations (
      id     serial PRIMARY KEY,
      name   text NOT NULL UNIQUE,
      ran_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await client.query(
      'SELECT 1 FROM _rcab_migrations WHERE name = $1',
      [file],
    );
    if (rows.length > 0) continue;

    const sql = await readFile(join(migrationsDir, file), 'utf-8');
    await client.query(sql);
    await client.query(
      'INSERT INTO _rcab_migrations (name) VALUES ($1)',
      [file],
    );
    console.log(`[migrator] applied ${file}`);
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    console.log('[migrator] running migrations...');
    await runMigrations(client, MIGRATIONS_DIR);
    console.log('[migrator] done');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrator] failed:', err);
  process.exit(1);
});
