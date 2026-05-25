import { Client } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('postgres round-trip', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    await client.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS _test_ping (
        id    serial PRIMARY KEY,
        value text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await client.query('DROP TABLE IF EXISTS _test_ping');
    await client.end();
  });

  it('INSERT then SELECT returns the row', async () => {
    await client.query(`INSERT INTO _test_ping (value) VALUES ($1)`, ['hello-rcab']);
    const { rows } = await client.query(`SELECT value FROM _test_ping WHERE value = $1`, ['hello-rcab']);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('hello-rcab');
  });

  it('_rcab_migrations table was created by runMigrations()', async () => {
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_rcab_migrations'
    `);
    expect(rows).toHaveLength(1);
  });
});
