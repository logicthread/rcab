import { Pool } from 'pg';
import Redis from 'ioredis';
import { createApp, createState, type AppState } from './app';
import { logger } from './logger';

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://rcab:rcab@postgres:5432/rcab';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';

const state: AppState = createState();
const pool = new Pool({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });

async function pingPostgres(): Promise<void> {
  await pool.query('SELECT 1');
  state.postgres = true;
  logger.info('postgres connected');
}

async function pingRedis(): Promise<void> {
  await redis.connect();
  await redis.ping();
  state.redis = true;
  logger.info('redis connected');
}

async function retry(fn: () => Promise<void>, name: string, attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt: i, attempts, err: msg }, `${name} connection attempt failed`);
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const server = createApp(state);
server.listen(PORT, () => {
  logger.info({ port: PORT }, 'http server listening');
});

Promise.all([retry(pingPostgres, 'postgres'), retry(pingRedis, 'redis')]).catch((err) => {
  logger.fatal({ err }, 'dependency wiring failed');
  process.exitCode = 1;
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    Promise.all([pool.end(), redis.quit()])
      .catch((err) => logger.error({ err }, 'error during shutdown'))
      .finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
