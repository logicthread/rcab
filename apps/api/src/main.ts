import { Pool } from 'pg';
import Redis from 'ioredis';
import { createApp, createState, type AppState } from './app';

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rcab:rcab@postgres:5432/rcab';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

const state: AppState = createState();
const pool = new Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });

async function pingPostgres(): Promise<void> {
  await pool.query('SELECT 1');
  state.postgres = true;
  console.log('[api] postgres connected');
}

async function pingRedis(): Promise<void> {
  await redis.connect();
  await redis.ping();
  state.redis = true;
  console.log('[api] redis connected');
}

async function retry(fn: () => Promise<void>, name: string, attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[api] ${name} attempt ${i}/${attempts} failed: ${msg}`);
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const server = createApp(state);
server.listen(PORT, () => {
  console.log(`[api] http server listening on :${PORT}`);
});

Promise.all([retry(pingPostgres, 'postgres'), retry(pingRedis, 'redis')]).catch((err) => {
  console.error('[api] dependency wiring failed', err);
  process.exitCode = 1;
});

function shutdown(signal: string): void {
  console.log(`[api] received ${signal}, shutting down`);
  server.close(() => {
    Promise.all([pool.end(), redis.quit()])
      .catch((err) => console.error('[api] error during shutdown', err))
      .finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
