/**
 * Google-only sign-in / registration (RCAB-E8.S15) against a real Postgres.
 *
 * The app boots with the shipped default policy (auth.enabledMethods =
 * ['google']) and the REAL GoogleVerifierService; only google-auth-library's
 * OAuth2Client (the network call to Google) is mocked, with a token registry:
 * an id_token string maps to the payload Google would return for it.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';

const { googleTokens } = vi.hoisted(() => ({
  googleTokens: new Map<string, Record<string, unknown>>(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    // Mirrors the library: unknown token → throws; audience must be accepted.
    verifyIdToken: vi.fn(async ({ idToken, audience }: { idToken: string; audience: string[] }) => {
      const payload = googleTokens.get(idToken);
      if (!payload) throw new Error('Wrong number of segments in token');
      if (!audience.includes(payload.aud as string)) throw new Error('Wrong recipient, payload audience != requiredAudience');
      return { getPayload: () => payload };
    }),
  })),
}));

import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { POLICY, defaultPolicy } from '../../src/config/policy/policy';

const skip = process.env.RCAB_INT_SKIPPED === '1';

const WEB_CLIENT_ID = 'rcab-web-test.apps.googleusercontent.com';
const OTHER_CLIENT_ID = 'rcab-other-test.apps.googleusercontent.com';
const MIGRATIONS_DIR = join(__dirname, '../../migrations');

/** Registers a Google ID token the mocked library will accept; returns the id_token string. */
function googleToken(overrides: Record<string, unknown> = {}): string {
  const sub = (overrides.sub as string | undefined) ?? `g-${randomUUID()}`;
  const token = `gtok-${randomUUID()}`;
  googleTokens.set(token, {
    sub,
    email: `${sub}@gmail.example`,
    email_verified: true,
    iss: 'https://accounts.google.com',
    aud: WEB_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3000,
    ...overrides,
  });
  return token;
}

function setCookies(res: supertest.Response): string {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  return Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
}

const mockRedis = () => ({
  ping: vi.fn().mockResolvedValue('PONG'),
  quit: vi.fn().mockResolvedValue('OK'),
});

async function bootApp(
  pool: Pool,
  firebase: { verifyIdToken: ReturnType<typeof vi.fn> },
  opts: { throttle: boolean },
): Promise<{ app: INestApplication; moduleRef: TestingModule }> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL).useValue(pool)
    .overrideProvider(REDIS).useValue(mockRedis())
    .overrideProvider(FirebaseAdminService).useValue(firebase)
    // The shipped default, independent of the test process env.
    .overrideProvider(POLICY).useValue(defaultPolicy());
  if (!opts.throttle) builder = builder.overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true });
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  return { app, moduleRef };
}

let pool: Pool;
let app: INestApplication;
let moduleRef: TestingModule;
const mockFirebase = { verifyIdToken: vi.fn() };
const savedEnv = { ids: process.env.GOOGLE_CLIENT_IDS, id: process.env.GOOGLE_CLIENT_ID };

beforeAll(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  process.env.GOOGLE_CLIENT_IDS = `${WEB_CLIENT_ID}, ${OTHER_CLIENT_ID}`;
  delete process.env.GOOGLE_CLIENT_ID;
  ({ app, moduleRef } = await bootApp(pool, mockFirebase, { throttle: false }));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  vi.unstubAllGlobals();
  if (savedEnv.ids === undefined) delete process.env.GOOGLE_CLIENT_IDS;
  else process.env.GOOGLE_CLIENT_IDS = savedEnv.ids;
  if (savedEnv.id !== undefined) process.env.GOOGLE_CLIENT_ID = savedEnv.id;
});

describe.skipIf(skip)('GET /v1/auth/config', () => {
  it('is public and lists only google, with the first configured client id', async () => {
    const res = await supertest(app.getHttpServer()).get('/v1/auth/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ methods: ['google'], google: { clientId: WEB_CLIENT_ID } });
  });
});

describe.skipIf(skip)('Google sign-in: register, then login', () => {
  it('first native sign-in registers a client (google_sub + verified email, no phone, no firebase uid)', async () => {
    const sub = `g-${randomUUID()}`;
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/native/google')
      .send({ id_token: googleToken({ sub }) });

    expect(res.status).toBe(200);
    expect(setCookies(res)).toBe('');
    expect(res.body).toMatchObject({ token_type: 'bearer', expires_in: 900 });
    expect(res.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      role: 'client',
      phone_e164: null,
      email: `${sub}@gmail.example`,
    });

    const claims = moduleRef.get(JwtService).decode(res.body.access_token) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: res.body.user.id, role: 'client', auth_method: 'google', typ: 'access' });

    const user = await pool.query(
      'SELECT google_sub, email, phone_e164, firebase_uid, role, status FROM app_user WHERE id = $1',
      [res.body.user.id],
    );
    expect(user.rows[0]).toEqual({
      google_sub: sub,
      email: `${sub}@gmail.example`,
      phone_e164: null,
      firebase_uid: null,
      role: 'client',
      status: 'active',
    });
    const client = await pool.query('SELECT 1 FROM client WHERE user_id = $1', [res.body.user.id]);
    expect(client.rows).toHaveLength(1);
    const rt = await pool.query(
      'SELECT auth_method FROM auth_refresh_token WHERE token_hash = $1',
      [createHash('sha256').update(res.body.refresh_token).digest('hex')],
    );
    expect(rt.rows[0].auth_method).toBe('google');
  });

  it('a later sign-in with the same sub (web) logs into the same account; no second row', async () => {
    const sub = `g-${randomUUID()}`;
    const first = await supertest(app.getHttpServer()).post('/v1/auth/native/google').send({ id_token: googleToken({ sub }) });
    expect(first.status).toBe(200);

    const second = await supertest(app.getHttpServer()).post('/v1/auth/google').send({ id_token: googleToken({ sub }) });

    expect(second.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.body.refresh_token).toBeUndefined();
    expect(setCookies(second)).toMatch(/refresh_token=[^;]+;.*HttpOnly/i);
    const rows = await pool.query('SELECT count(*)::int AS n FROM app_user WHERE google_sub = $1', [sub]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('a token for a secondary accepted audience works too', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/native/google')
      .send({ id_token: googleToken({ aud: OTHER_CLIENT_ID }) });
    expect(res.status).toBe(200);
  });

  it('keeps the email in step with Google on login', async () => {
    const sub = `g-${randomUUID()}`;
    const first = await supertest(app.getHttpServer()).post('/v1/auth/native/google').send({ id_token: googleToken({ sub }) });
    const again = await supertest(app.getHttpServer())
      .post('/v1/auth/native/google')
      .send({ id_token: googleToken({ sub, email: 'renamed@gmail.example' }) });
    expect(again.body.user).toMatchObject({ id: first.body.user.id, email: 'renamed@gmail.example' });
    const row = await pool.query('SELECT email FROM app_user WHERE id = $1', [first.body.user.id]);
    expect(row.rows[0].email).toBe('renamed@gmail.example');
  });

  it('the Google session refreshes (native) with a null phone and keeps auth_method google', async () => {
    const signIn = await supertest(app.getHttpServer()).post('/v1/auth/native/google').send({ id_token: googleToken() });
    const refreshed = await supertest(app.getHttpServer())
      .post('/v1/auth/native/refresh')
      .send({ refresh_token: signIn.body.refresh_token });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.user).toEqual(signIn.body.user);
    const claims = moduleRef.get(JwtService).decode(refreshed.body.access_token) as Record<string, unknown>;
    expect(claims.auth_method).toBe('google');
  });

  it('never links by email: a phone account with the same email is left alone', async () => {
    const email = `shared-${randomUUID()}@gmail.example`;
    const phoneUserId = randomUUID();
    await pool.query(
      "INSERT INTO app_user (id, firebase_uid, phone_e164, email, role) VALUES ($1, $2, $3, $4, 'client')",
      [phoneUserId, randomUUID(), `+1202${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, email],
    );

    const res = await supertest(app.getHttpServer()).post('/v1/auth/native/google').send({ id_token: googleToken({ email }) });

    expect(res.status).toBe(200);
    expect(res.body.user.id).not.toBe(phoneUserId);
    const phoneUser = await pool.query('SELECT google_sub FROM app_user WHERE id = $1', [phoneUserId]);
    expect(phoneUser.rows[0].google_sub).toBeNull();
  });

  it('concurrent first sign-ins for one sub converge on exactly one account', async () => {
    const sub = `g-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        supertest(app.getHttpServer()).post('/v1/auth/native/google').send({ id_token: googleToken({ sub }) }),
      ),
    );

    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(results.map((r) => r.body.user.id)).size).toBe(1);
    const users = await pool.query('SELECT id FROM app_user WHERE google_sub = $1', [sub]);
    expect(users.rows).toHaveLength(1);
    const clients = await pool.query('SELECT count(*)::int AS n FROM client WHERE user_id = $1', [users.rows[0].id]);
    expect(clients.rows[0].n).toBe(1);
    const sessions = await pool.query(
      'SELECT count(DISTINCT family_id)::int AS n FROM auth_refresh_token WHERE user_id = $1',
      [users.rows[0].id],
    );
    expect(sessions.rows[0].n).toBe(8);
  });
});

describe.skipIf(skip)('Google sign-in: refusals', () => {
  it.each(['suspended', 'deleted'])('a %s account → 403 account_disabled, no session', async (status) => {
    const sub = `g-${randomUUID()}`;
    const first = await supertest(app.getHttpServer()).post('/v1/auth/native/google').send({ id_token: googleToken({ sub }) });
    await pool.query('UPDATE app_user SET status = $2 WHERE id = $1', [first.body.user.id, status]);
    const before = await pool.query('SELECT count(*)::int AS n FROM auth_refresh_token WHERE user_id = $1', [
      first.body.user.id,
    ]);

    for (const path of ['/v1/auth/native/google', '/v1/auth/google']) {
      const res = await supertest(app.getHttpServer()).post(path).send({ id_token: googleToken({ sub }) });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('account_disabled');
      expect(setCookies(res)).toBe('');
    }
    const after = await pool.query('SELECT count(*)::int AS n FROM auth_refresh_token WHERE user_id = $1', [
      first.body.user.id,
    ]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('an unverified Google email → 403 google_email_unverified and nothing is registered', async () => {
    const sub = `g-${randomUUID()}`;
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/native/google')
      .send({ id_token: googleToken({ sub, email_verified: false }) });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('google_email_unverified');
    const rows = await pool.query('SELECT 1 FROM app_user WHERE google_sub = $1', [sub]);
    expect(rows.rows).toHaveLength(0);
  });

  it.each([
    ['an unknown / forged token', () => 'not-a-google-token'],
    ['a foreign audience', () => googleToken({ aud: 'someone-else.apps.googleusercontent.com' })],
    ['a foreign issuer', () => googleToken({ iss: 'https://evil.example' })],
    ['an expired token', () => googleToken({ exp: Math.floor(Date.now() / 1000) - 5 })],
  ])('%s → 401 google_token_invalid', async (_label, token) => {
    const res = await supertest(app.getHttpServer()).post('/v1/auth/native/google').send({ id_token: token() });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('google_token_invalid');
  });

  it('web /google is Origin-checked like /refresh', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/v1/auth/google')
      .set('Origin', 'https://evil.example')
      .send({ id_token: googleToken() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('csrf_rejected');
  });

  it('phone is disabled: firebase-exchange (web + native) → 403 auth_method_disabled, Firebase never called', async () => {
    for (const path of ['/v1/auth/firebase-exchange', '/v1/auth/native/firebase-exchange']) {
      const res = await supertest(app.getHttpServer()).post(path).send({ id_token: 'fb-token' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('auth_method_disabled');
      expect(setCookies(res)).toBe('');
    }
    expect(mockFirebase.verifyIdToken).not.toHaveBeenCalled();
  });
});

describe.skipIf(skip)('schema: migration 0018_app_user_google_identity', () => {
  it('an account needs a phone or a google_sub (app_user_identity_check)', async () => {
    await expect(
      pool.query("INSERT INTO app_user (id, role) VALUES ($1, 'client')", [randomUUID()]),
    ).rejects.toThrow(/app_user_identity_check/);
  });

  it('google_sub is unique', async () => {
    const sub = `g-${randomUUID()}`;
    await pool.query("INSERT INTO app_user (id, google_sub, role) VALUES ($1, $2, 'client')", [randomUUID(), sub]);
    await expect(
      pool.query("INSERT INTO app_user (id, google_sub, role) VALUES ($1, $2, 'client')", [randomUUID(), sub]),
    ).rejects.toThrow(/duplicate key/);
  });

  it('applies over existing phone rows and is re-runnable', async () => {
    const dbName = `mig0018_${randomUUID().replace(/-/g, '')}`;
    await pool.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.TEST_POSTGRES_URI!);
    url.pathname = `/${dbName}`;
    const scratch = new Pool({ connectionString: url.toString() });
    try {
      await scratch.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await scratch.query('CREATE EXTENSION IF NOT EXISTS postgis');
      const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files.filter((f) => f < '0018')) {
        await scratch.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      }
      const legacyId = randomUUID();
      await scratch.query(
        "INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, '+12025550000', 'driver')",
        [legacyId, randomUUID()],
      );

      const sql0018 = readFileSync(join(MIGRATIONS_DIR, '0018_app_user_google_identity.sql'), 'utf8');
      await scratch.query(sql0018);
      await scratch.query(sql0018); // re-runnable

      const legacy = await scratch.query('SELECT phone_e164, role FROM app_user WHERE id = $1', [legacyId]);
      expect(legacy.rows[0]).toEqual({ phone_e164: '+12025550000', role: 'driver' });
      await scratch.query("INSERT INTO app_user (id, google_sub, email, role) VALUES ($1, 'g-1', 'a@b.example', 'client')", [
        randomUUID(),
      ]);
      const uniques = await scratch.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = 'app_user'::regclass AND i.indisunique AND i.indnkeyatts = 1 AND a.attname = 'google_sub'`,
      );
      expect(uniques.rows[0].n).toBe(1); // 0001's constraint reused, no duplicate index
    } finally {
      await scratch.end();
      await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    }
  }, 60_000);
});

describe.skipIf(skip)('no Google client id configured, real throttling', () => {
  let bare: INestApplication;
  let barePool: Pool;

  beforeAll(async () => {
    barePool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    const ids = process.env.GOOGLE_CLIENT_IDS;
    delete process.env.GOOGLE_CLIENT_IDS;
    try {
      ({ app: bare } = await bootApp(barePool, { verifyIdToken: vi.fn() }, { throttle: true }));
    } finally {
      process.env.GOOGLE_CLIENT_IDS = ids;
    }
  }, 60_000);

  afterAll(async () => {
    await bare?.close();
    await barePool?.end();
  });

  it('boots, advertises a null client id, and answers 503 google_not_configured', async () => {
    const config = await supertest(bare.getHttpServer()).get('/v1/auth/config');
    expect(config.body).toEqual({ methods: ['google'], google: { clientId: null } });

    const res = await supertest(bare.getHttpServer()).post('/v1/auth/google').send({ id_token: googleToken() });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('google_not_configured');
  });

  it('native/google is throttled like the other auth exchanges (10/min)', async () => {
    const server = bare.getHttpServer();
    for (let i = 0; i < 10; i++) {
      const res = await supertest(server).post('/v1/auth/native/google').send({ id_token: `t-${i}` });
      expect(res.status).toBe(503);
    }
    const throttled = await supertest(server).post('/v1/auth/native/google').send({ id_token: 't-10' });
    expect(throttled.status).toBe(429);
  });
});
