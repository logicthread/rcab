import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('health/ready integration', () => {
  let pool: Pool;
  let redis: Redis;
  let app: INestApplication;
  let mockOsrm: HttpServer;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 0 });

    mockOsrm = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":"Ok"}');
    }).listen(0);
    const osrmAddr = mockOsrm.address() as AddressInfo;
    process.env.OSRM_URL = `http://127.0.0.1:${osrmAddr.port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(REDIS).useValue(redis)
      .overrideProvider(FirebaseAdminService).useValue({ verifyIdToken: vi.fn() })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    mockOsrm?.close();
    await redis?.quit().catch(() => {});
    await pool?.end();
    delete process.env.OSRM_URL;
    vi.unstubAllGlobals();
  });

  it('returns 200 with all deps true when everything is up', async () => {
    const res = await supertest(app.getHttpServer()).get('/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, postgres: true, redis: true, osrm: true });
  });

  it('returns 503 with redis=false after Redis is disconnected', async () => {
    await redis.disconnect();

    const res = await supertest(app.getHttpServer()).get('/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.redis).toBe(false);
    expect(res.body.postgres).toBe(true);
  });
});
