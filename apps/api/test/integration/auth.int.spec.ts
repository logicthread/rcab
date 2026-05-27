import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import type { auth } from 'firebase-admin';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function makeDecodedToken(overrides: Partial<auth.DecodedIdToken> = {}): auth.DecodedIdToken {
  return {
    uid: 'test-uid-001',
    phone_number: '+12025550001',
    aud: 'rcab-dev',
    iss: 'https://securetoken.google.com/rcab-dev',
    iat: Math.floor(Date.now() / 1000) - 30,
    exp: Math.floor(Date.now() / 1000) + 3570,
    sub: 'test-uid-001',
    auth_time: Math.floor(Date.now() / 1000) - 30,
    firebase: { identities: {}, sign_in_provider: 'phone' },
    ...overrides,
  } as auth.DecodedIdToken;
}

describe.skipIf(skip)('auth integration', () => {
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
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    mockFirebase.verifyIdToken.mockReset();
  });

  it('creates user row and refresh token on first exchange', async () => {
    mockFirebase.verifyIdToken.mockResolvedValue(makeDecodedToken());

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token-1' });

    expect(res.status).toBe(201);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.token_type).toBe('bearer');
    expect(res.body.expires_in).toBe(900);
    expect(res.body.refresh_token).toBeUndefined(); // moved to HttpOnly cookie
    expect(res.body.user.phone_e164).toBe('+12025550001');
    expect(res.body.user.role).toBe('client');

    // cookie must be set
    const setCookie = res.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
    expect(cookieStr).toMatch(/refresh_token=/);
    expect(cookieStr).toMatch(/HttpOnly/i);

    // extract token from cookie and verify DB row
    const rtMatch = cookieStr.match(/refresh_token=([^;]+)/);
    const refreshToken = rtMatch?.[1];
    expect(refreshToken).toBeTruthy();

    const userRows = await pool.query(
      "SELECT id, role, phone_e164, firebase_uid FROM app_user WHERE firebase_uid = 'test-uid-001'",
    );
    expect(userRows.rows).toHaveLength(1);
    expect(userRows.rows[0].phone_e164).toBe('+12025550001');

    const tokenRows = await pool.query(
      'SELECT user_id FROM auth_refresh_token WHERE token = $1',
      [refreshToken],
    );
    expect(tokenRows.rows).toHaveLength(1);
    expect(tokenRows.rows[0].user_id).toBe(userRows.rows[0].id);
  });

  it('does not duplicate user row on second exchange with same firebase_uid', async () => {
    mockFirebase.verifyIdToken.mockResolvedValue(makeDecodedToken());

    await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token-2' });

    // second call — same uid
    const res2 = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token-2' });

    expect(res2.status).toBe(201);

    const userRows = await pool.query(
      "SELECT id FROM app_user WHERE firebase_uid = 'test-uid-001'",
    );
    expect(userRows.rows).toHaveLength(1);
  });

  it('returns 401 with code invalid_firebase_token for a bad token', async () => {
    mockFirebase.verifyIdToken.mockRejectedValue(new Error('token invalid'));

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'bad-token' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_firebase_token');
  });

  it('returns 400 when id_token is missing from body', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({});

    expect(res.status).toBe(400);
  });
});

describe.skipIf(skip)('auth throttle integration', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });

    const throttleUid = 'throttle-uid-001';
    const mockFirebase = {
      verifyIdToken: vi.fn().mockResolvedValue({
        uid: throttleUid,
        phone_number: '+12025559999',
        aud: 'rcab-dev',
        iss: `https://securetoken.google.com/rcab-dev`,
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3570,
        sub: throttleUid,
        auth_time: Math.floor(Date.now() / 1000) - 30,
        firebase: { identities: {}, sign_in_provider: 'phone' },
      }),
    };

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
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    vi.unstubAllGlobals();
  });

  it('returns 429 after 10 requests within a minute', async () => {
    const server = app.getHttpServer();
    for (let i = 0; i < 10; i++) {
      const res = await supertest(server)
        .post('/v1/auth/firebase-exchange')
        .send({ id_token: `throttle-token-${i}` });
      expect(res.status).toBe(201);
    }
    const throttledRes = await supertest(server)
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'throttle-token-10' });
    expect(throttledRes.status).toBe(429);
  });
});
