import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import type { auth } from 'firebase-admin';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function makeFirebaseToken(overrides: Partial<auth.DecodedIdToken> = {}): auth.DecodedIdToken {
  return {
    uid: 'cookie-test-uid',
    phone_number: '+12025550055',
    aud: 'rcab-dev',
    iss: 'https://securetoken.google.com/rcab-dev',
    iat: Math.floor(Date.now() / 1000) - 30,
    exp: Math.floor(Date.now() / 1000) + 3570,
    sub: 'cookie-test-uid',
    auth_time: Math.floor(Date.now() / 1000) - 30,
    firebase: { identities: {}, sign_in_provider: 'phone' },
    ...overrides,
  } as auth.DecodedIdToken;
}

describe.skipIf(skip)('cookie + CSRF integration', () => {
  let app: INestApplication;
  let pool: Pool;
  let mockFirebase: { verifyIdToken: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    mockFirebase = { verifyIdToken: vi.fn() };

    const mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
      quit: vi.fn().mockResolvedValue('OK'),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(REDIS).useValue(mockRedis)
      .overrideProvider(FirebaseAdminService).useValue(mockFirebase)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    vi.unstubAllGlobals();
  });

  it('exchange sets HttpOnly refresh_token cookie and body has no refresh_token', async () => {
    mockFirebase.verifyIdToken.mockResolvedValue(makeFirebaseToken());

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token' });

    expect(res.status).toBe(201);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeUndefined();

    const setCookie = res.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
    expect(cookieStr).toMatch(/refresh_token=/);
    expect(cookieStr).toMatch(/HttpOnly/i);
    expect(cookieStr).toMatch(/SameSite=Lax/i);
    expect(cookieStr).toMatch(/Path=\/v1\/auth/);
  });

  it('full lifecycle: exchange → cookie-only refresh → logout → 401', async () => {
    const server = app.getHttpServer();
    const agent = supertest.agent(server);

    // Step 1: exchange — cookie stored in agent's jar
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid: 'cookie-lifecycle-uid', phone_number: '+12025550044', sub: 'cookie-lifecycle-uid' }),
    );
    const exchange = await agent
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token' });
    expect(exchange.status).toBe(201);
    const { access_token: jwt } = exchange.body;

    // Step 2: refresh with cookie only (no body)
    const refresh = await agent
      .post('/v1/auth/refresh')
      .set('Content-Type', 'application/json')
      .send({});
    expect(refresh.status).toBe(201);
    expect(refresh.body.access_token).toBeTruthy();
    expect(refresh.body.refresh_token).toBeUndefined();

    // Step 3: logout — clears cookie
    const logout = await agent
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${jwt}`)
      .send({});
    expect(logout.status).toBe(204);

    const logoutCookie = logout.headers['set-cookie'] as string[] | string;
    const logoutCookieStr = Array.isArray(logoutCookie) ? logoutCookie.join('; ') : (logoutCookie ?? '');
    expect(logoutCookieStr).toMatch(/Max-Age=0/);

    // Step 4: subsequent refresh with (now-invalid) cookie → 401
    const postLogout = await agent
      .post('/v1/auth/refresh')
      .send({});
    expect(postLogout.status).toBe(401);
  });

  it('refresh with explicit body token (non-browser client path) still works', async () => {
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid: 'body-token-uid', phone_number: '+12025550033', sub: 'body-token-uid' }),
    );
    // Exchange without agent — refresh_token not in cookie
    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token' });
    expect(exchange.status).toBe(201);

    // The body doesn't contain refresh_token anymore — read from cookie header
    const setCookie = exchange.headers['set-cookie'] as string[];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const rtMatch = cookieHeader?.match(/refresh_token=([^;]+)/);
    const refreshToken = rtMatch?.[1];
    expect(refreshToken).toBeTruthy();

    const refresh = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refreshToken}`)
      .send({ refresh_token: refreshToken });
    expect(refresh.status).toBe(201);
    expect(refresh.body.access_token).toBeTruthy();
  });

  it('CSRF guard rejects cross-origin request to /v1/auth/refresh', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', 'https://evil.com')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('csrf_rejected');
  });

  it('CSRF guard allows request with no Origin header', async () => {
    // No Origin header → treated as same-origin or non-browser client
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({});

    // 401 because no token, but NOT 403 — CSRF guard passed
    expect(res.status).toBe(401);
  });
});
