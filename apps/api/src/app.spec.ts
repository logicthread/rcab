import { describe, it, expect } from 'vitest';
import { createApp, createState } from './app';
import type { AddressInfo } from 'node:net';

async function fetchJson(server: ReturnType<typeof createApp>, path: string): Promise<{ status: number; body: unknown }> {
  const addr = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`);
  const body = await res.json();
  return { status: res.status, body };
}

describe('api app', () => {
  it('returns 503 from /v1/health when deps are not ready', async () => {
    const state = createState();
    const server = createApp(state).listen(0);
    try {
      const { status, body } = await fetchJson(server, '/v1/health');
      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, postgres: false, redis: false });
    } finally {
      server.close();
    }
  });

  it('returns 200 from /v1/health when both deps are ready', async () => {
    const state = createState();
    state.postgres = true;
    state.redis = true;
    const server = createApp(state).listen(0);
    try {
      const { status, body } = await fetchJson(server, '/v1/health');
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, postgres: true, redis: true });
    } finally {
      server.close();
    }
  });

  it('returns 200 from /v1/health/ready when deps are ready', async () => {
    const state = createState();
    state.postgres = true;
    state.redis = true;
    const server = createApp(state).listen(0);
    try {
      const { status, body } = await fetchJson(server, '/v1/health/ready');
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, postgres: true, redis: true });
    } finally {
      server.close();
    }
  });

  it('returns 503 from /v1/health/ready when deps are not ready', async () => {
    const state = createState();
    state.postgres = true;
    const server = createApp(state).listen(0);
    try {
      const { status, body } = await fetchJson(server, '/v1/health/ready');
      expect(status).toBe(503);
      expect(body).toEqual({ ok: false, postgres: true, redis: false });
    } finally {
      server.close();
    }
  });

  it('returns 200 from /v1/health/live regardless of dep state', async () => {
    const state = createState();
    const server = createApp(state).listen(0);
    try {
      const { status, body } = await fetchJson(server, '/v1/health/live');
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const state = createState();
    const server = createApp(state).listen(0);
    try {
      const { status, body } = await fetchJson(server, '/no-such-thing');
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'not_found' });
    } finally {
      server.close();
    }
  });
});
