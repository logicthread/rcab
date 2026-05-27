import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
    uid: 'refresh-test-uid',
    phone_number: '+12025550042',
    aud: 'rcab-dev',
    iss: 'https://securetoken.google.com/rcab-dev',
    iat: Math.floor(Date.now() / 1000) - 30,
    exp: Math.floor(Date.now() / 1000) + 3570,
    sub: 'refresh-test-uid',
    auth_time: Math.floor(Date.now() / 1000) - 30,
    firebase: { identities: {}, sign_in_provider: 'phone' },
    ...overrides,
  } as auth.DecodedIdToken;
}

describe.skipIf(skip)('jwt refresh + revocation integration', () => {
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

  it('full lifecycle: exchange → refresh → refresh (rotation) → logout → refresh fails', async () => {
    const server = app.getHttpServer();
    mockFirebase.verifyIdToken.mockResolvedValue(makeDecodedToken());

    // Step 1: exchange Firebase token → get initial tokens
    const exchange = await supertest(server)
      .post('/v1/auth/firebase-exchange')
      .send({ id_token: 'firebase-token' });
    expect(exchange.status).toBe(201);
    const { access_token: jwt1, refresh_token: rt1 } = exchange.body;

    // Step 2: refresh with rt1 → get new JWT + rt2, rt1 is now revoked
    const refresh1 = await supertest(server)
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt1 });
    expect(refresh1.status).toBe(201);
    const { access_token: jwt2, refresh_token: rt2 } = refresh1.body;
    expect(jwt2).toBeTruthy();
    expect(rt2).not.toBe(rt1);

    // rt1 must now be revoked
    const replayRt1 = await supertest(server)
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt1 });
    expect(replayRt1.status).toBe(401);
    expect(replayRt1.body.error?.code).toBe('invalid_refresh_token');

    // Step 3: refresh with rt2 → get rt3 (token rotation still works)
    const refresh2 = await supertest(server)
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt2 });
    expect(refresh2.status).toBe(201);
    const { refresh_token: rt3 } = refresh2.body;

    // Step 4: logout using rt3 (authenticated with jwt2)
    const logout = await supertest(server)
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${jwt2}`)
      .send({ refresh_token: rt3 });
    expect(logout.status).toBe(204);

    // Step 5: refreshing rt3 after logout must fail
    const postLogout = await supertest(server)
      .post('/v1/auth/refresh')
      .send({ refresh_token: rt3 });
    expect(postLogout.status).toBe(401);
    expect(postLogout.body.error?.code).toBe('invalid_refresh_token');
  });

  it('returns 401 with invalid_refresh_token for an unknown token', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refresh_token: 'totally-fake-token' });

    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('invalid_refresh_token');
  });

  it('returns 401 from logout when no Bearer token provided', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/logout')
      .send({ refresh_token: 'any-token' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when refresh_token body field is missing', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({});

    expect(res.status).toBe(400);
  });
});
