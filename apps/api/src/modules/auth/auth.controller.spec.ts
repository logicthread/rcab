/**
 * HTTP contract tests for both session flavours (F02 / F12):
 *   - web:    /v1/auth/{firebase-exchange,refresh,logout}  — HttpOnly cookie, CSRF, no refresh_token in JSON
 *   - native: /v1/auth/native/{firebase-exchange,refresh,logout} — JSON body, no cookies, no CSRF
 *
 * Boots only AuthController (AuthService mocked) with the real guards, the
 * global ValidationPipe and the AppExceptionFilter, so status codes, bodies and
 * headers are what a real client sees. The native response is checked against
 * test/fixtures/native-auth-contract.json, which the Flutter client codes against.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthController } from './auth.controller';
import { AuthService, type TokenResponse } from './auth.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CsrfGuard } from '../../common/guards/csrf.guard';
import { AppExceptionFilter } from '../../common/filters/app-exception.filter';
import { signAccessToken } from '../../common/guards/access-token';

const contract = JSON.parse(
  readFileSync(join(__dirname, '../../../test/fixtures/native-auth-contract.json'), 'utf8'),
) as {
  endpoints: Record<
    'firebase_exchange' | 'refresh' | 'logout',
    { method: string; path: string; request: { body: Record<string, unknown> }; response: { status: number; body: unknown } }
  >;
};

const SECRET = 'auth-controller-spec-secret-0123456789ab';
const jwt = new JwtService({ secret: SECRET });

function tokens(refresh = 'rt-new'): TokenResponse {
  return {
    access_token: 'at-new',
    token_type: 'bearer',
    expires_in: 900,
    refresh_token: refresh,
    user: { id: 'user-1', role: 'driver', phone_e164: '+919876543210' },
  };
}

/** Recursively maps a JSON value to its shape (keys + primitive types). */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
}

function setCookies(res: supertest.Response): string {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  return Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
}

describe('AuthController', () => {
  let app: INestApplication;
  const auth = {
    exchangeFirebaseToken: vi.fn(),
    refresh: vi.fn(),
    revoke: vi.fn(),
    revokePresented: vi.fn(),
    linkGoogle: vi.fn(),
    loginWithGoogle: vi.fn(),
  };
  const bearer = `Bearer ${signAccessToken(jwt, { sub: 'user-1', role: 'driver', auth_method: 'phone' })}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 1000 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: JwtService, useValue: jwt },
        AuthGuard,
        CsrfGuard,
        { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
        { provide: APP_FILTER, useClass: AppExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('native contract (F02)', () => {
    const { firebase_exchange, refresh, logout } = contract.endpoints;

    it('fixture refresh tokens look like real ones (32 random bytes, base64url)', () => {
      const issued = firebase_exchange.response.body as { refresh_token: string };
      const rotated = refresh.response.body as { refresh_token: string };
      expect(issued.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rotated.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    });

    it('firebase-exchange: 200, full token body incl. refresh_token, no cookie — matches fixture', async () => {
      auth.exchangeFirebaseToken.mockResolvedValue(tokens('rt-1'));

      const res = await supertest(app.getHttpServer())
        .post(firebase_exchange.path)
        .send(firebase_exchange.request.body);

      expect(res.status).toBe(firebase_exchange.response.status);
      expect(shapeOf(res.body)).toEqual(shapeOf(firebase_exchange.response.body));
      expect(res.body.refresh_token).toBe('rt-1');
      expect(setCookies(res)).toBe('');
      expect(auth.exchangeFirebaseToken).toHaveBeenCalledWith(firebase_exchange.request.body.id_token);
    });

    it('firebase-exchange: missing id_token → 400', async () => {
      const res = await supertest(app.getHttpServer()).post(firebase_exchange.path).send({ firebase_id_token: 'x' });
      expect(res.status).toBe(400);
      expect(auth.exchangeFirebaseToken).not.toHaveBeenCalled();
    });

    it('refresh: 200, rotated refresh_token in body, no cookie — matches fixture', async () => {
      auth.refresh.mockResolvedValue(tokens('rt-2'));

      const res = await supertest(app.getHttpServer()).post(refresh.path).send(refresh.request.body);

      expect(res.status).toBe(refresh.response.status);
      expect(shapeOf(res.body)).toEqual(shapeOf(refresh.response.body));
      expect(res.body.refresh_token).toBe('rt-2');
      expect(setCookies(res)).toBe('');
      expect(auth.refresh).toHaveBeenCalledWith(refresh.request.body.refresh_token);
    });

    it('refresh: never falls back to the refresh cookie', async () => {
      const res = await supertest(app.getHttpServer())
        .post(refresh.path)
        .set('Cookie', 'refresh_token=cookie-token')
        .send({});

      expect(res.status).toBe(400);
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('refresh: is not subject to the browser CSRF check', async () => {
      auth.refresh.mockResolvedValue(tokens());
      const res = await supertest(app.getHttpServer())
        .post(refresh.path)
        .set('Origin', 'https://elsewhere.example')
        .send(refresh.request.body);
      expect(res.status).toBe(200);
    });

    it('refresh: service 401 surfaces as invalid_refresh_token', async () => {
      auth.refresh.mockRejectedValue(
        new UnauthorizedException({ code: 'invalid_refresh_token', message: 'Refresh token is invalid, expired, or already used' }),
      );
      const res = await supertest(app.getHttpServer()).post(refresh.path).send(refresh.request.body);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_refresh_token');
    });

    it('logout: 204 and revokes the body token by possession — no Bearer needed', async () => {
      auth.revokePresented.mockResolvedValue(undefined);

      const res = await supertest(app.getHttpServer()).post(logout.path).send(logout.request.body);

      expect(res.status).toBe(logout.response.status);
      expect(res.text).toBe('');
      expect(auth.revokePresented).toHaveBeenCalledWith(logout.request.body.refresh_token);
      expect(auth.revoke).not.toHaveBeenCalled();
    });

    it('logout: an expired / garbage Bearer header does not block sign-out', async () => {
      auth.revokePresented.mockResolvedValue(undefined);
      const expired = jwt.sign({
        sub: 'user-1',
        role: 'driver',
        auth_method: 'phone',
        typ: 'access',
        exp: Math.floor(Date.now() / 1000) - 60,
      });

      for (const header of [`Bearer ${expired}`, 'Bearer not-a-jwt']) {
        const res = await supertest(app.getHttpServer())
          .post(logout.path)
          .set('Authorization', header)
          .send(logout.request.body);
        expect(res.status).toBe(204);
      }
      expect(auth.revokePresented).toHaveBeenCalledTimes(2);
    });

    it('logout: also 204 when the token is unknown or already revoked (no oracle)', async () => {
      auth.revokePresented.mockResolvedValue(undefined);
      const res = await supertest(app.getHttpServer()).post(logout.path).send({ refresh_token: 'never-issued' });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('logout: requires refresh_token in the body', async () => {
      const res = await supertest(app.getHttpServer()).post(logout.path).send({});
      expect(res.status).toBe(400);
      expect(auth.revokePresented).not.toHaveBeenCalled();
    });
  });

  describe('web contract (unchanged: HttpOnly cookie, no refresh_token in JSON)', () => {
    it('firebase-exchange sets the refresh cookie and omits refresh_token from the body', async () => {
      auth.exchangeFirebaseToken.mockResolvedValue(tokens('rt-web'));

      const res = await supertest(app.getHttpServer()).post('/v1/auth/firebase-exchange').send({ id_token: 'fb' });

      expect(res.status).toBe(201);
      expect(res.body.refresh_token).toBeUndefined();
      expect(res.body).toMatchObject({ access_token: 'at-new', token_type: 'bearer', expires_in: 900 });
      const cookie = setCookies(res);
      expect(cookie).toMatch(/refresh_token=rt-web/);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Path=\/v1\/auth/);
    });

    it('refresh reads the cookie, rotates it, and keeps refresh_token out of JSON', async () => {
      auth.refresh.mockResolvedValue(tokens('rt-rotated'));

      const res = await supertest(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Cookie', 'refresh_token=rt-old')
        .send({});

      expect(res.status).toBe(201);
      expect(auth.refresh).toHaveBeenCalledWith('rt-old');
      expect(res.body.refresh_token).toBeUndefined();
      expect(setCookies(res)).toMatch(/refresh_token=rt-rotated/);
    });

    it('refresh enforces CSRF Origin check', async () => {
      const res = await supertest(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Origin', 'https://evil.example')
        .set('Cookie', 'refresh_token=rt-old')
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('csrf_rejected');
      expect(auth.refresh).not.toHaveBeenCalled();
    });

    it('logout revokes the cookie token and clears the cookie', async () => {
      const res = await supertest(app.getHttpServer())
        .post('/v1/auth/logout')
        .set('Authorization', bearer)
        .set('Cookie', 'refresh_token=rt-old')
        .send({});

      expect(res.status).toBe(204);
      expect(auth.revoke).toHaveBeenCalledWith('rt-old', 'user-1');
      expect(setCookies(res)).toMatch(/refresh_token=;.*Max-Age=0|Expires=Thu, 01 Jan 1970/);
    });
  });
});
