import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type AppDeps } from './app';
import type { AddressInfo } from 'node:net';

const realFetch = globalThis.fetch;

function makeMockDeps(overrides: Partial<{
  pgOk: boolean;
  redisOk: boolean;
  osrmOk: boolean;
}> = {}): AppDeps {
  const { pgOk = true, redisOk = true, osrmOk = true } = overrides;
  return {
    pool: {
      query: pgOk
        ? vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] })
        : vi.fn().mockRejectedValue(new Error('pg down')),
    } as unknown as AppDeps['pool'],
    redis: {
      ping: redisOk
        ? vi.fn().mockResolvedValue('PONG')
        : vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as AppDeps['redis'],
    osrmUrl: osrmOk ? 'http://osrm-mock:5000' : 'http://unreachable:9999',
  };
}

async function fetchFrom(
  server: ReturnType<typeof createApp>,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const addr = server.address() as AddressInfo;
  const res = await realFetch(`http://127.0.0.1:${addr.port}${path}`, { headers });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body, headers: res.headers };
}

describe('api app', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 from /v1/health/live regardless of dep state', async () => {
    const server = createApp(makeMockDeps({ pgOk: false, redisOk: false })).listen(0);
    try {
      const { status, body } = await fetchFrom(server, '/v1/health/live');
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it('returns 200 from /v1/health/ready when all deps are up', async () => {
    const server = createApp(makeMockDeps()).listen(0);
    try {
      const { status, body } = await fetchFrom(server, '/v1/health/ready');
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true, postgres: true, redis: true, osrm: true });
    } finally {
      server.close();
    }
  });

  it('returns 503 from /v1/health/ready when postgres is down', async () => {
    const server = createApp(makeMockDeps({ pgOk: false })).listen(0);
    try {
      const { status, body } = await fetchFrom(server, '/v1/health/ready');
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.postgres).toBe(false);
      expect(body.redis).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns 503 from /v1/health/ready when redis is down', async () => {
    const server = createApp(makeMockDeps({ redisOk: false })).listen(0);
    try {
      const { status, body } = await fetchFrom(server, '/v1/health/ready');
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.redis).toBe(false);
      expect(body.postgres).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns 503 from /v1/health/ready when osrm is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));
    const server = createApp(makeMockDeps({ osrmOk: false })).listen(0);
    try {
      const { status, body } = await fetchFrom(server, '/v1/health/ready');
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.osrm).toBe(false);
    } finally {
      server.close();
    }
  });

  it('returns 200 from / as alias for /v1/health/ready', async () => {
    const server = createApp(makeMockDeps()).listen(0);
    try {
      const { status, body } = await fetchFrom(server, '/');
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const server = createApp(makeMockDeps()).listen(0);
    try {
      const { status, body } = await fetchFrom(server, '/no-such-thing');
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'not_found' });
    } finally {
      server.close();
    }
  });

  it('exposes /metrics with prometheus content-type', async () => {
    const server = createApp(makeMockDeps()).listen(0);
    try {
      const addr = server.address() as AddressInfo;
      const res = await realFetch(`http://127.0.0.1:${addr.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('http_request_duration_seconds');
    } finally {
      server.close();
    }
  });

  it('sets x-request-id response header', async () => {
    const server = createApp(makeMockDeps()).listen(0);
    try {
      const { headers } = await fetchFrom(server, '/v1/health/live');
      expect(headers.get('x-request-id')).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it('echoes x-request-id from client header', async () => {
    const server = createApp(makeMockDeps()).listen(0);
    try {
      const { headers } = await fetchFrom(server, '/v1/health/live', {
        'x-request-id': 'test-trace-123',
      });
      expect(headers.get('x-request-id')).toBe('test-trace-123');
    } finally {
      server.close();
    }
  });
});
