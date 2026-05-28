import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { AppModule } from './app.module';
import { DRIZZLE_DB } from './infra/db/drizzle.module';
import { FirebaseAdminService } from './infra/firebase/firebase-admin.service';
import { HealthService } from './modules/health/health.service';

let app: INestApplication;
let mockReadiness: ReturnType<typeof vi.fn>;

async function buildApp(): Promise<INestApplication> {
  mockReadiness = vi.fn().mockResolvedValue({ ok: true, postgres: true, redis: true, osrm: true });

  const mockHealth = {
    liveness: vi.fn().mockReturnValue({ ok: true }),
    readiness: mockReadiness,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DRIZZLE_DB).useValue({})
    .overrideProvider(HealthService).useValue(mockHealth)
    .overrideProvider(FirebaseAdminService).useValue({ verifyIdToken: vi.fn() })
    .compile();

  const nestApp = moduleRef.createNestApplication();
  await nestApp.init();
  return nestApp;
}

describe('api app', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockReadiness.mockResolvedValue({ ok: true, postgres: true, redis: true, osrm: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns 200 from /v1/health/live regardless of dep state', async () => {
    const res = await supertest(app.getHttpServer()).get('/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 200 from /v1/health/ready when all deps are up', async () => {
    const res = await supertest(app.getHttpServer()).get('/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, postgres: true, redis: true, osrm: true });
  });

  it('returns 503 from /v1/health/ready when postgres is down', async () => {
    mockReadiness.mockResolvedValue({ ok: false, postgres: false, redis: true, osrm: true });

    const res = await supertest(app.getHttpServer()).get('/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.postgres).toBe(false);
    expect(res.body.redis).toBe(true);
  });

  it('returns 503 from /v1/health/ready when redis is down', async () => {
    mockReadiness.mockResolvedValue({ ok: false, postgres: true, redis: false, osrm: true });

    const res = await supertest(app.getHttpServer()).get('/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.redis).toBe(false);
    expect(res.body.postgres).toBe(true);
  });

  it('returns 503 from /v1/health/ready when osrm is down', async () => {
    mockReadiness.mockResolvedValue({ ok: false, postgres: true, redis: true, osrm: false });

    const res = await supertest(app.getHttpServer()).get('/v1/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.osrm).toBe(false);
  });

  it('returns 200 from / as alias for /v1/health/ready', async () => {
    const res = await supertest(app.getHttpServer()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await supertest(app.getHttpServer()).get('/no-such-thing');
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('exposes /metrics with prometheus content-type', async () => {
    const res = await supertest(app.getHttpServer()).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('http_request_duration_seconds');
  });

  it('sets x-request-id response header', async () => {
    const res = await supertest(app.getHttpServer()).get('/v1/health/live');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes x-request-id from client header', async () => {
    const res = await supertest(app.getHttpServer())
      .get('/v1/health/live')
      .set('x-request-id', 'test-trace-123');
    expect(res.headers['x-request-id']).toBe('test-trace-123');
  });
});
