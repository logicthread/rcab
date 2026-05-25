import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Health } from '@rcab/shared';
import { logger } from './logger';
import { requestStore } from './context';
import { httpRequestDuration, metricsHandler } from './metrics';

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

export function handle(state: AppState, req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/metrics') {
    metricsHandler(req, res);
    return;
  }
  if (req.url === '/v1/health/live') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/' || req.url === '/v1/health' || req.url === '/v1/health/ready') {
    const ready = state.postgres && state.redis;
    const body: Health & AppState = {
      ok: ready,
      postgres: state.postgres,
      redis: state.redis,
    };
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

export function createApp(state: AppState): Server {
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

      logger.info(
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
      handle(state, req, res);
    });
  });
}
