import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Health } from '@rcab/shared';

export type AppState = { postgres: boolean; redis: boolean };

export function createState(): AppState {
  return { postgres: false, redis: false };
}

export function handle(state: AppState, req: IncomingMessage, res: ServerResponse): void {
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
  return createServer((req, res) => handle(state, req, res));
}
