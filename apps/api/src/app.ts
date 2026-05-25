import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { logger } from './logger';
import { requestStore } from './context';
import { httpRequestDuration, metricsHandler } from './metrics';

export interface AppDeps {
  pool: Pool;
  redis: Redis;
  osrmUrl: string;
}

export type AppState = { postgres: boolean; redis: boolean };

export function createState(): AppState {
  return { postgres: false, redis: false };
}

function normalizeRoute(url: string | undefined): string {
  if (!url) return 'unknown';
  const path = url.split('?')[0];
  if (path === '/v1/health/live') return '/v1/health/live';
  if (path === '/v1/health/ready' || path === '/v1/health' || path === '/') return '/v1/health/ready';
  if (path === '/metrics') return '/metrics';
  return '/not_found';
}

function isHealthRoute(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith('/v1/health');
}

async function probePostgres(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function probeRedis(redis: Redis): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

async function probeOsrm(osrmUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${osrmUrl}/nearest/v1/driving/91.7,26.1`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function handleReady(deps: AppDeps, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const [postgres, redis, osrm] = await Promise.all([
    probePostgres(deps.pool),
    probeRedis(deps.redis),
    probeOsrm(deps.osrmUrl),
  ]);
  const ok = postgres && redis && osrm;
  const body = { ok, postgres, redis, osrm };
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleLive(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

export function handle(deps: AppDeps, req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/metrics') {
    metricsHandler(req, res);
    return;
  }
  if (req.url === '/v1/health/live') {
    handleLive(req, res);
    return;
  }
  if (req.url === '/' || req.url === '/v1/health' || req.url === '/v1/health/ready') {
    handleReady(deps, req, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

export function createApp(deps: AppDeps): Server {
  return createServer((req, res) => {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    const startTime = process.hrtime.bigint();

    res.setHeader('x-request-id', requestId);

    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startTime) / 1_000_000;
      const route = normalizeRoute(req.url);
      const method = req.method ?? 'UNKNOWN';
      const statusCode = res.statusCode;

      httpRequestDuration
        .labels(method, route, String(statusCode))
        .observe(durationMs / 1000);

      const logLevel = isHealthRoute(req.url) ? 'debug' : 'info';
      logger[logLevel](
        {
          request_id: requestId,
          method,
          route,
          status: statusCode,
          duration_ms: Math.round(durationMs * 100) / 100,
        },
        'request',
      );
    });

    requestStore.run({ requestId, startTime }, () => {
      handle(deps, req, res);
    });
  });
}
