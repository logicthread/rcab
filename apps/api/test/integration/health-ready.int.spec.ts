import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { createApp, type AppDeps } from '../../src/app';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('health/ready integration', () => {
  let pool: Pool;
  let redis: Redis;
  let server: Server;
  let mockOsrm: HttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 0 });

    mockOsrm = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":"Ok"}');
    }).listen(0);
    const osrmAddr = mockOsrm.address() as AddressInfo;

    const deps: AppDeps = {
      pool,
      redis,
      osrmUrl: `http://127.0.0.1:${osrmAddr.port}`,
    };
    server = createApp(deps).listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server?.close();
    mockOsrm?.close();
    await redis?.quit().catch(() => {});
    await pool?.end();
  });

  it('returns 200 with all deps true when everything is up', async () => {
    const res = await fetch(`${baseUrl}/v1/health/ready`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: true, postgres: true, redis: true, osrm: true });
  });

  it('returns 503 with redis=false after Redis is disconnected', async () => {
    await redis.disconnect();

    const res = await fetch(`${baseUrl}/v1/health/ready`);
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.redis).toBe(false);
    expect(body.postgres).toBe(true);
  });
});
