/**
 * Consolidated auth integration suite for RCAB-E2.S6.
 * Covers all happy paths, negative cases, and CSRF/cookie invariants
 * against a real Postgres container. Firebase Admin + Google OAuth2Client
 * are mocked at the SDK boundary.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';
import type { auth } from 'firebase-admin';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeFirebaseToken(overrides: Partial<auth.DecodedIdToken> = {}): auth.DecodedIdToken {
  return {
    uid: randomUUID(),
    phone_number: '+12025551000',
    aud: 'rcab-dev',
    iss: 'https://securetoken.google.com/rcab-dev',
    iat: Math.floor(Date.now() / 1000) - 30,
    exp: Math.floor(Date.now() / 1000) + 3570,
    sub: randomUUID(),
    auth_time: Math.floor(Date.now() / 1000) - 30,
    firebase: { identities: {}, sign_in_provider: 'phone' },
    ...overrides,
  } as auth.DecodedIdToken;
}

async function createTestUser(
  pool: Pool,
  phone: string,
): Promise<{ id: string; role: string; phone_e164: string }> {
  const client = await pool.connect();
  const userId = randomUUID();
  const firebaseUid = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      "INSERT INTO app_user (id, firebase_uid, phone_e164, role, status) VALUES ($1, $2, $3, 'client', 'active')",
      [userId, firebaseUid, phone],
    );
    await client.query('INSERT INTO client (user_id) VALUES ($1)', [userId]);
    await client.query('COMMIT');
    return { id: userId, role: 'client', phone_e164: phone };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function extractCookieToken(headers: Record<string, string | string[]>): string {
  const setCookie = headers['set-cookie'] as string[] | string;
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
  const match = cookieStr.match(/refresh_token=([^;]+)/);
  if (!match?.[1]) throw new Error('refresh_token cookie not found in Set-Cookie header');
  return match[1];
}

function makeGooglePayload(sub: string = randomUUID()) {
  return { sub, email: `${sub}@test.example.com`, email_verified: true };
}

// ─── shared app setup ────────────────────────────────────────────────────────

let moduleRef: TestingModule;
let app: INestApplication;
let pool: Pool;
let mockFirebase: { verifyIdToken: ReturnType<typeof vi.fn> };
let mockGoogle: { verifyIdToken: ReturnType<typeof vi.fn> };

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
  mockFirebase = { verifyIdToken: vi.fn() };
  mockGoogle = { verifyIdToken: vi.fn() };

  const mockRedis = {
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
  };

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool)
    .overrideProvider(REDIS).useValue(mockRedis)
    .overrideProvider(FirebaseAdminService).useValue(mockFirebase)
    .overrideProvider(GoogleVerifierService).useValue(mockGoogle)
    .overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  vi.unstubAllGlobals();
});

// ─── happy paths ─────────────────────────────────────────────────────────────

describe.skipIf(skip)('happy paths', () => {
  it('OTP exchange creates user row, issues JWT, and sets refresh cookie', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551001' }),
    );

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });

    expect(res.status).toBe(201);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.token_type).toBe('bearer');
    expect(res.body.expires_in).toBe(900);
    expect(res.body.refresh_token).toBeUndefined();
    expect(res.body.user.phone_e164).toBe('+12025551001');

    const rt = extractCookieToken(res.headers as Record<string, string | string[]>);
    expect(rt).toMatch(/^[0-9a-f-]{36}$/);

    const userRows = await pool.query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM app_user WHERE firebase_uid = $1', [uid],
    );
    expect(userRows.rows).toHaveLength(1);
    expect(userRows.rows[0].phone_e164).toBe('+12025551001');

    const tokenRows = await pool.query(
      'SELECT user_id FROM auth_refresh_token WHERE token = $1', [rt],
    );
    expect(tokenRows.rows).toHaveLength(1);
  });

  it('returning user exchange returns existing row without creating a duplicate', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551002' }),
    );

    await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });

    await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });

    const rows = await pool.query(
      'SELECT id FROM app_user WHERE firebase_uid = $1', [uid],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('refresh rotates token: old token revoked, new JWT issued', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551003' }),
    );

    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });
    const rt1 = extractCookieToken(exchange.headers as Record<string, string | string[]>);

    const refresh = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt1 });
    expect(refresh.status).toBe(201);
    const rt2 = extractCookieToken(refresh.headers as Record<string, string | string[]>);
    expect(rt2).not.toBe(rt1);

    // rt1 must now be revoked
    const replay = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt1 });
    expect(replay.status).toBe(401);
    expect(replay.body.error?.code).toBe('invalid_refresh_token');
  });

  it('logout revokes refresh token; subsequent refresh returns 401', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551004' }),
    );

    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });
    const { access_token: jwt } = exchange.body;
    const rt = extractCookieToken(exchange.headers as Record<string, string | string[]>);

    const logout = await supertest(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ refresh_token: rt });
    expect(logout.status).toBe(204);

    const postLogout = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt });
    expect(postLogout.status).toBe(401);
  });

  it('Google link sets google_sub and email on user row', async () => {
    const uid = randomUUID();
    const googleSub = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551005' }),
    );

    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });
    const { access_token: jwt, user } = exchange.body;

    mockGoogle.verifyIdToken.mockResolvedValue(makeGooglePayload(googleSub));

    const link = await supertest(app.getHttpServer())
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ google_id_token: 'g-token' });
    expect(link.status).toBe(200);

    const row = await pool.query<{ google_sub: string }>(
      'SELECT google_sub FROM app_user WHERE id = $1', [user.id],
    );
    expect(row.rows[0].google_sub).toBe(googleSub);
  });

  it('Google login issues JWT for a user with linked google_sub', async () => {
    const uid = randomUUID();
    const googleSub = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551006' }),
    );

    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });
    const { access_token: jwt, user } = exchange.body;

    mockGoogle.verifyIdToken.mockResolvedValue(makeGooglePayload(googleSub));

    await supertest(app.getHttpServer())
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ google_id_token: 'g-token' });

    const login = await supertest(app.getHttpServer())
      .post('/v1/auth/google/login')
      .send({ google_id_token: 'g-token' });
    expect(login.status).toBe(201);
    expect(login.body.access_token).toBeTruthy();
    expect(login.body.user.id).toBe(user.id);
  });
});

// ─── negative: Firebase ID token ─────────────────────────────────────────────

describe.skipIf(skip)('negative — Firebase ID token', () => {
  it('tampered/invalid token → 401 invalid_firebase_token', async () => {
    mockFirebase.verifyIdToken.mockRejectedValue(new Error('token invalid'));

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'tampered' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_firebase_token');
  });

  it('token with iat older than 1 hour → 401 invalid_firebase_token', async () => {
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({
        phone_number: '+12025551011',
        iat: Math.floor(Date.now() / 1000) - 3700,
      }),
    );

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'old-token' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_firebase_token');
  });

  it('token with missing phone_number → 401 invalid_firebase_token', async () => {
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ phone_number: undefined }),
    );

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'no-phone' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_firebase_token');
  });

  it('missing id_token body field → 400', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─── negative: refresh token ──────────────────────────────────────────────────

describe.skipIf(skip)('negative — refresh token', () => {
  it('replayed refresh token (used twice) → second call 401', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551013' }),
    );

    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });
    const rt = extractCookieToken(exchange.headers as Record<string, string | string[]>);

    // first refresh — consumes rt
    await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt });

    // replay — must fail
    const replay = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt });
    expect(replay.status).toBe(401);
    expect(replay.body.error?.code).toBe('invalid_refresh_token');
  });

  it('revoked refresh token (post-logout) → 401', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551014' }),
    );

    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });
    const { access_token: jwt } = exchange.body;
    const rt = extractCookieToken(exchange.headers as Record<string, string | string[]>);

    await supertest(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ refresh_token: rt });

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_refresh_token');
  });

  it('completely unknown refresh token → 401', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: 'totally-fake-token' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_refresh_token');
  });

  it('no token in body or cookie → 401', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_refresh_token');
  });
});

// ─── negative: Google auth ────────────────────────────────────────────────────

describe.skipIf(skip)('negative — Google auth', () => {
  it('Google login for unregistered google_sub → 401 not_found', async () => {
    mockGoogle.verifyIdToken.mockResolvedValue(makeGooglePayload(randomUUID()));

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/google/login')
      .send({ google_id_token: 'g-token' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('Google link conflict (same google_sub linked to another user) → 409', async () => {
    const googleSub = randomUUID();

    // User A links the Google account
    const uidA = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid: uidA, sub: uidA, phone_number: '+12025551021' }),
    );
    const exchA = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-a' });
    mockGoogle.verifyIdToken.mockResolvedValue(makeGooglePayload(googleSub));
    await supertest(app.getHttpServer())
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${exchA.body.access_token}`)
      .send({ google_id_token: 'g-token' });

    // User B tries to link the same Google account
    const uidB = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid: uidB, sub: uidB, phone_number: '+12025551022' }),
    );
    const exchB = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-b' });
    mockGoogle.verifyIdToken.mockResolvedValue(makeGooglePayload(googleSub));

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${exchB.body.access_token}`)
      .send({ google_id_token: 'g-token' });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('google_already_linked');
  });
});

// ─── negative: JWT auth guard ─────────────────────────────────────────────────

describe.skipIf(skip)('negative — JWT auth guard', () => {
  it('protected endpoint without JWT → 401 unauthorized', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/google/link')
      .send({ google_id_token: 'g-token' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthorized');
  });

  it('protected endpoint with expired JWT → 401 unauthorized', async () => {
    const user = await createTestUser(pool, '+12025551015');
    const jwtService = moduleRef.get(JwtService);
    // Sign with exp in the past (expiresIn: -1 = expired 1 second ago)
    const expiredToken = jwtService.sign(
      { sub: user.id, role: user.role, auth_method: 'phone' },
      { expiresIn: -1 },
    );

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthorized');
  });

  it('protected endpoint with malformed Bearer token → 401', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', 'Bearer not.a.jwt')
      .send({});

    expect(res.status).toBe(401);
  });
});

// ─── cookie + CSRF ────────────────────────────────────────────────────────────

describe.skipIf(skip)('cookie + CSRF', () => {
  it('exchange sets HttpOnly cookie; body contains no refresh_token', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551030' }),
    );

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });

    expect(res.status).toBe(201);
    expect(res.body.refresh_token).toBeUndefined();

    const setCookie = res.headers['set-cookie'] as string[];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
    expect(cookieStr).toMatch(/refresh_token=/);
    expect(cookieStr).toMatch(/HttpOnly/i);
    expect(cookieStr).toMatch(/SameSite=Lax/i);
    expect(cookieStr).toMatch(/Path=\/v1\/auth/);
  });

  it('cookie-only refresh (no body) succeeds and rotates cookie', async () => {
    const agent = supertest.agent(app.getHttpServer());
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551031' }),
    );

    await agent.post('/v1/auth/firebase-exchange').send({ id_token: 'fb-token' });

    const refresh = await agent.post('/v1/auth/refresh').send({});
    expect(refresh.status).toBe(201);
    expect(refresh.body.access_token).toBeTruthy();
    expect(refresh.body.refresh_token).toBeUndefined();
  });

  it('logout clears cookie (Max-Age=0)', async () => {
    const uid = randomUUID();
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid, sub: uid, phone_number: '+12025551032' }),
    );

    const exchange = await supertest(app.getHttpServer())
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token' });
    const { access_token: jwt } = exchange.body;

    const logout = await supertest(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${jwt}`)
      .send({});
    expect(logout.status).toBe(204);

    const setCookie = logout.headers['set-cookie'] as string[] | string;
    const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
    expect(cookieStr).toMatch(/Max-Age=0/);
  });

  it('cross-origin Origin header on /v1/auth/refresh → 403 csrf_rejected', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', 'https://evil.com')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('csrf_rejected');
  });

  it('absent Origin header on /v1/auth/refresh → CSRF guard passes (returns 401, not 403)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({});

    expect(res.status).toBe(401); // guard passed; 401 because no token
    expect(res.status).not.toBe(403);
  });
});

// ─── rate limiting ────────────────────────────────────────────────────────────

describe.skipIf(skip)('rate limiting', () => {
  let throttleApp: INestApplication;
  let throttlePool: Pool;

  beforeAll(async () => {
    throttlePool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    const uid = randomUUID();
    const mockFb = {
      verifyIdToken: vi.fn().mockResolvedValue(
        makeFirebaseToken({ uid, sub: uid, phone_number: '+12025559999' }),
      ),
    };
    const mockRedis = {
      ping: vi.fn().mockResolvedValue('PONG'),
      quit: vi.fn().mockResolvedValue('OK'),
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL).useValue(throttlePool)
      .overrideProvider(REDIS).useValue(mockRedis)
      .overrideProvider(FirebaseAdminService).useValue(mockFb)
      .overrideProvider(GoogleVerifierService).useValue({ verifyIdToken: vi.fn() })
      .compile();

    throttleApp = ref.createNestApplication();
    await throttleApp.init();
  });

  afterAll(async () => {
    await throttleApp?.close();
    await throttlePool?.end();
  });

  it('returns 429 after 10 requests to firebase-exchange within a minute', async () => {
    const server = throttleApp.getHttpServer();
    for (let i = 0; i < 10; i++) {
      const res = await supertest(server)
        .post('/v1/auth/firebase-exchange')
        .send({ id_token: `token-${i}` });
      expect(res.status).toBe(201);
    }
    const throttled = await supertest(server)
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'token-10' });
    expect(throttled.status).toBe(429);
  });
});
