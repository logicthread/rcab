import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import supertest from 'supertest';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';
import type { auth } from 'firebase-admin';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function makeFirebaseToken(overrides: Partial<auth.DecodedIdToken> = {}): auth.DecodedIdToken {
  return {
    uid: 'google-link-test-uid',
    phone_number: '+12025550099',
    aud: 'rcab-dev',
    iss: 'https://securetoken.google.com/rcab-dev',
    iat: Math.floor(Date.now() / 1000) - 30,
    exp: Math.floor(Date.now() / 1000) + 3570,
    sub: 'google-link-test-uid',
    auth_time: Math.floor(Date.now() / 1000) - 30,
    firebase: { identities: {}, sign_in_provider: 'phone' },
    ...overrides,
  } as auth.DecodedIdToken;
}

describe.skipIf(skip)('Google link + login integration', () => {
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL).useValue(pool)
      .overrideProvider(REDIS).useValue(mockRedis)
      .overrideProvider(FirebaseAdminService).useValue(mockFirebase)
      .overrideProvider(GoogleVerifierService).useValue(mockGoogle)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    vi.unstubAllGlobals();
  });

  it('full flow: OTP exchange → link Google → login via Google; google_sub persists on user row', async () => {
    const server = app.getHttpServer();

    // Step 1: exchange Firebase phone OTP → get JWT
    mockFirebase.verifyIdToken.mockResolvedValue(makeFirebaseToken());
    const exchange = await supertest(server)
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token' });
    expect(exchange.status).toBe(201);
    const { access_token: jwt, user } = exchange.body;

    // Step 2: link Google account
    mockGoogle.verifyIdToken.mockResolvedValue({
      sub: 'g-sub-integration-test',
      email: 'integration@example.com',
      email_verified: true,
    });
    const link = await supertest(server)
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ google_id_token: 'google-id-token' });
    expect(link.status).toBe(200);

    // Verify google_sub is persisted on the user row
    const row = await pool.query<{ google_sub: string; email: string }>(
      'SELECT google_sub, email FROM app_user WHERE id = $1',
      [user.id],
    );
    expect(row.rows[0].google_sub).toBe('g-sub-integration-test');
    expect(row.rows[0].email).toBe('integration@example.com');

    // Step 3: login via Google using same google_sub
    mockGoogle.verifyIdToken.mockResolvedValue({
      sub: 'g-sub-integration-test',
      email: 'integration@example.com',
      email_verified: true,
    });
    const login = await supertest(server)
      .post('/v1/auth/google/login')
      .send({ google_id_token: 'google-id-token' });
    expect(login.status).toBe(201);
    expect(login.body.access_token).toBeTruthy();
    expect(login.body.user.id).toBe(user.id);
  });

  it('link is idempotent — re-linking same Google account returns 200', async () => {
    const server = app.getHttpServer();

    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid: 'idempotent-uid', phone_number: '+12025550088', sub: 'idempotent-uid' }),
    );
    const exchange = await supertest(server)
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-token-idem' });
    expect(exchange.status).toBe(201);
    const { access_token: jwt } = exchange.body;

    mockGoogle.verifyIdToken.mockResolvedValue({
      sub: 'g-sub-idempotent',
      email: 'idem@example.com',
      email_verified: true,
    });

    const link1 = await supertest(server)
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ google_id_token: 'google-id-token' });
    expect(link1.status).toBe(200);

    // Second link — same user, same google_sub — must still be 200
    const link2 = await supertest(server)
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ google_id_token: 'google-id-token' });
    expect(link2.status).toBe(200);
  });

  it('returns 409 google_already_linked when google_sub belongs to another user', async () => {
    const server = app.getHttpServer();

    // User A
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid: 'conflict-uid-a', phone_number: '+12025550077', sub: 'conflict-uid-a' }),
    );
    const exchangeA = await supertest(server)
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-a' });
    const { access_token: jwtA } = exchangeA.body;

    mockGoogle.verifyIdToken.mockResolvedValue({
      sub: 'g-sub-conflict',
      email: 'conflict@example.com',
      email_verified: true,
    });
    await supertest(server)
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${jwtA}`)
      .send({ google_id_token: 'google-id-token' });

    // User B tries to link the same Google account
    mockFirebase.verifyIdToken.mockResolvedValue(
      makeFirebaseToken({ uid: 'conflict-uid-b', phone_number: '+12025550066', sub: 'conflict-uid-b' }),
    );
    const exchangeB = await supertest(server)
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'fb-b' });
    const { access_token: jwtB } = exchangeB.body;

    mockGoogle.verifyIdToken.mockResolvedValue({
      sub: 'g-sub-conflict',
      email: 'conflict@example.com',
      email_verified: true,
    });
    const conflict = await supertest(server)
      .post('/v1/auth/google/link')
      .set('Authorization', `Bearer ${jwtB}`)
      .send({ google_id_token: 'google-id-token' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error?.code).toBe('google_already_linked');
  });

  it('returns 404 not_found when google_sub has no linked account', async () => {
    mockGoogle.verifyIdToken.mockResolvedValue({
      sub: 'g-sub-unknown',
      email: 'nobody@example.com',
      email_verified: true,
    });

    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/google/login')
      .send({ google_id_token: 'google-id-token' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('not_found');
  });

  it('returns 401 from google/link when no Bearer token provided', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/google/link')
      .send({ google_id_token: 'some-token' });

    expect(res.status).toBe(401);
  });
});
