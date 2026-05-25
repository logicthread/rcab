import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    console.log('[migrator] verifying postgres connectivity...');
    await pool.query('SELECT 1');
    console.log('[migrator] postgres OK — no pending migrations (stub)');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrator] failed:', err);
  process.exit(1);
});
