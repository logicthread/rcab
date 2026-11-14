import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException, ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { AuthService, hashRefreshToken, REFRESH_REUSE_GRACE_SECONDS } from './auth.service';
import { FirebaseAdminService } from '../../infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../infra/google/google-verifier.service';
import { defaultPolicy } from '../../config/policy/policy';
import type { auth } from 'firebase-admin';

/** Both methods on: the phone exchange stays testable while it is off by default. */
const BOTH_METHODS = defaultPolicy({ auth: { enabledMethods: ['google', 'phone'] } });

const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeDecodedToken(overrides: Partial<auth.DecodedIdToken> = {}): auth.DecodedIdToken {
  return {
    uid: 'firebase-uid-123',
    phone_number: '+12025551234',
    aud: 'rcab-dev',
    iss: 'https://securetoken.google.com/rcab-dev',
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3540,
    sub: 'firebase-uid-123',
    auth_time: Math.floor(Date.now() / 1000) - 60,
    firebase: { identities: {}, sign_in_provider: 'phone' },
    ...overrides,
  } as auth.DecodedIdToken;
}

describe('AuthService', () => {
  let service: AuthService;
  let mockFirebase: FirebaseAdminService;
  let mockGoogle: GoogleVerifierService;
  let mockJwt: JwtService;
  let mockPoolQuery: ReturnType<typeof vi.fn>;
  let mockClientQuery: ReturnType<typeof vi.fn>;
  let mockClientRelease: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] });
    mockClientQuery = vi.fn().mockResolvedValue({ rows: [] });
    mockClientRelease = vi.fn();

    mockFirebase = {
      verifyIdToken: vi.fn(),
    } as unknown as FirebaseAdminService;

    mockGoogle = {
      verifyIdToken: vi.fn(),
      primaryClientId: 'web-client-id.apps.googleusercontent.com',
    } as unknown as GoogleVerifierService;

    mockJwt = {
      sign: vi.fn().mockReturnValue('signed-jwt'),
    } as unknown as JwtService;

    const poolMock = {
      query: mockPoolQuery,
      connect: vi.fn().mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
      }),
    };

    mockPool = poolMock;
    service = new AuthService(mockFirebase, mockGoogle, mockJwt, poolMock as unknown as import('pg').Pool, BOTH_METHODS);
  });

  let mockPool: unknown;
  function serviceWith(enabledMethods: ('google' | 'phone')[]): AuthService {
    return new AuthService(
      mockFirebase,
      mockGoogle,
      mockJwt,
      mockPool as import('pg').Pool,
      defaultPolicy({ auth: { enabledMethods } }),
    );
  }

  function insertCall(calls: unknown[][]): unknown[] | undefined {
    return calls.find((c) => String(c[0]).includes('INSERT INTO auth_refresh_token'));
  }

  describe('hashRefreshToken', () => {
    it('is the hex SHA-256 digest of the token', () => {
      expect(hashRefreshToken('abc')).toBe(sha256('abc'));
      expect(hashRefreshToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('getAuthConfig', () => {
    it('lists the enabled methods and the primary Google client id', () => {
      expect(serviceWith(['google']).getAuthConfig()).toEqual({
        methods: ['google'],
        google: { clientId: 'web-client-id.apps.googleusercontent.com' },
      });
      expect(service.getAuthConfig().methods).toEqual(['google', 'phone']);
    });

    it('reports a null client id when Google is not configured', () => {
      (mockGoogle as unknown as { primaryClientId: string | null }).primaryClientId = null;
      expect(serviceWith(['google']).getAuthConfig().google.clientId).toBeNull();
    });
  });

  describe('exchangeFirebaseToken', () => {
    it('is refused with 403 auth_method_disabled while phone is not enabled (default policy)', async () => {
      const googleOnly = new AuthService(
        mockFirebase,
        mockGoogle,
        mockJwt,
        mockPool as import('pg').Pool,
        defaultPolicy(),
      );
      const err = await googleOnly.exchangeFirebaseToken('valid-token').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'auth_method_disabled' });
      expect(mockFirebase.verifyIdToken).not.toHaveBeenCalled();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('returns access_token, refresh_token, and user on valid token', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT: user not found
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      const result = await service.exchangeFirebaseToken('valid-token');

      expect(result.user.email).toBeNull();
      expect(result.access_token).toBe('signed-jwt');
      expect(result.token_type).toBe('bearer');
      expect(result.expires_in).toBe(900);
      expect(result.refresh_token).toMatch(REFRESH_TOKEN_RE);
      expect(result.user.role).toBe('client');
      expect(result.user.phone_e164).toBe('+12025551234');
    });

    it('stores only the SHA-256 digest of the refresh token, in a new family (F12)', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ id: 'u-1', role: 'client', phone_e164: '+12025551234', status: 'active' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.exchangeFirebaseToken('valid-token');

      const insert = insertCall(mockPoolQuery.mock.calls);
      expect(insert).toBeDefined();
      const params = insert![1] as unknown[];
      expect(params[0]).toBe(sha256(result.refresh_token));
      expect(params).not.toContain(result.refresh_token);
      expect(params[1]).toMatch(UUID_RE); // family_id
      expect(params[2]).toBe('u-1');
      expect(params[3]).toBe('phone');
    });

    it('issues a different refresh token per login', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      const user = { id: 'u-1', role: 'client', phone_e164: '+12025551234', status: 'active' };
      mockPoolQuery.mockImplementation((sql: string) =>
        Promise.resolve({ rows: sql.startsWith('SELECT') ? [user] : [] }),
      );

      const a = await service.exchangeFirebaseToken('t');
      const b = await service.exchangeFirebaseToken('t');
      expect(a.refresh_token).not.toBe(b.refresh_token);
    });

    it.each(['suspended', 'deleted'])('rejects a %s account with 403 account_disabled (F12)', async (status) => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'u-1', role: 'client', phone_e164: '+12025551234', status }],
      });

      await expect(service.exchangeFirebaseToken('valid-token')).rejects.toBeInstanceOf(ForbiddenException);
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'u-1', role: 'client', phone_e164: '+12025551234', status }],
      });
      await expect(service.exchangeFirebaseToken('valid-token')).rejects.toMatchObject({
        response: { code: 'account_disabled' },
      });
      expect(insertCall(mockPoolQuery.mock.calls)).toBeUndefined();
    });

    it('rejects an invalid Firebase token with 401 invalid_firebase_token', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockRejectedValue(new Error('token expired'));

      await expect(service.exchangeFirebaseToken('bad-token')).rejects.toThrow(
        UnauthorizedException,
      );

      try {
        await service.exchangeFirebaseToken('bad-token');
      } catch (err) {
        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as UnauthorizedException).getResponse()).toMatchObject({
          code: 'invalid_firebase_token',
        });
      }
    });

    it('rejects a token with missing phone_number', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(
        makeDecodedToken({ phone_number: undefined }),
      );

      await expect(service.exchangeFirebaseToken('no-phone-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token with non-E.164 phone number', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(
        makeDecodedToken({ phone_number: '12025551234' }),
      );

      await expect(service.exchangeFirebaseToken('bad-phone-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token with iat older than 1 hour', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(
        makeDecodedToken({ iat: Math.floor(Date.now() / 1000) - 3700 }),
      );

      await expect(service.exchangeFirebaseToken('old-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('returns existing user without creating a new row', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      const existingUser = { id: 'existing-id', role: 'client', phone_e164: '+12025551234', status: 'active' };
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [existingUser] }) // SELECT: user found
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      const result = await service.exchangeFirebaseToken('valid-token');

      expect(result.user.id).toBe('existing-id');
      expect(mockClientQuery).not.toHaveBeenCalled();
    });

    it('creates a new user and client row for first-time login', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT: user not found
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      await service.exchangeFirebaseToken('valid-token');

      expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO app_user'),
        expect.arrayContaining(['firebase-uid-123', '+12025551234']),
      );
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO client'),
        expect.any(Array),
      );
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('signs an access token with type, issuer and audience (F11)', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      const existingUser = { id: 'uid-abc', role: 'client', phone_e164: '+12025551234', status: 'active' };
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [existingUser] })
        .mockResolvedValueOnce({ rows: [] });

      await service.exchangeFirebaseToken('valid-token');

      expect(mockJwt.sign).toHaveBeenCalledWith(
        { sub: 'uid-abc', role: 'client', auth_method: 'phone', typ: 'access' },
        { issuer: 'rcab', audience: 'rcab-api', expiresIn: 900 },
      );
    });
  });

  describe('refresh', () => {
    const consumedRow = {
      user_id: 'user-abc',
      family_id: '11111111-2222-4333-8444-555555555555',
      auth_method: 'phone',
      role: 'client',
      phone_e164: '+12025551234',
      status: 'active',
    };

    /** Routes transaction statements: the consume UPDATE returns `consumed`. */
    function stubTransaction(consumed: unknown[]): void {
      mockClientQuery.mockImplementation((sql: string) => {
        if (sql.includes('FROM app_user au')) return Promise.resolve({ rows: consumed });
        return Promise.resolve({ rows: [] });
      });
    }

    function sqlCalls(): string[] {
      return mockClientQuery.mock.calls.map((c) => String(c[0]));
    }

    it('consumes the token with ONE conditional UPDATE inside the transaction (F12)', async () => {
      stubTransaction([consumedRow]);

      await service.refresh('old-token');

      const calls = sqlCalls();
      expect(calls[0]).toBe('BEGIN');
      // No validity SELECT before the consume: check-and-revoke is a single statement.
      expect(calls[1]).toMatch(/^\s*UPDATE auth_refresh_token art\s+SET revoked_at = now\(\)/);
      expect(calls[1]).toContain('art.token_hash = $1');
      expect(calls[1]).toContain('art.revoked_at IS NULL');
      expect(calls[1]).toContain('art.expires_at > now()');
      expect(calls[1]).toContain('RETURNING');
      expect(mockClientQuery.mock.calls[1][1]).toEqual([sha256('old-token')]);
      expect(calls.at(-1)).toBe('COMMIT');
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('returns new tokens; the replacement is hashed, in the same family, in the same transaction', async () => {
      stubTransaction([consumedRow]);

      const result = await service.refresh('old-token');

      expect(result.access_token).toBe('signed-jwt');
      expect(result.refresh_token).toMatch(REFRESH_TOKEN_RE);
      expect(result.refresh_token).not.toBe('old-token');
      expect(result.user).toEqual({ id: 'user-abc', role: 'client', phone_e164: '+12025551234' });

      const insert = insertCall(mockClientQuery.mock.calls);
      expect(insert).toBeDefined();
      expect(insert![1]).toEqual([
        sha256(result.refresh_token),
        consumedRow.family_id,
        'user-abc',
        'phone',
        expect.any(Date),
      ]);
      const order = sqlCalls();
      expect(order.findIndex((s) => s.includes('INSERT INTO auth_refresh_token'))).toBeLessThan(order.indexOf('COMMIT'));
    });

    it('preserves the original auth method across rotation', async () => {
      stubTransaction([{ ...consumedRow, auth_method: 'google' }]);

      await service.refresh('old-token');

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ auth_method: 'google', typ: 'access' }),
        expect.anything(),
      );
    });

    it('unknown / expired / already-used token → 401 and revokes the family of a replayed token', async () => {
      stubTransaction([]);

      await expect(service.refresh('used-token')).rejects.toMatchObject({
        response: { code: 'invalid_refresh_token' },
      });

      const familyRevoke = mockClientQuery.mock.calls.find(
        (c) => String(c[0]).includes('family_id = (SELECT family_id'),
      );
      expect(familyRevoke).toBeDefined();
      expect(String(familyRevoke![0])).toContain('revoked_at IS NOT NULL');
      expect(familyRevoke![1]).toEqual([sha256('used-token'), REFRESH_REUSE_GRACE_SECONDS]);
      // The family revocation must be committed, not rolled back with the 401.
      expect(sqlCalls()).toContain('COMMIT');
      expect(sqlCalls()).not.toContain('ROLLBACK');
      expect(insertCall(mockClientQuery.mock.calls)).toBeUndefined();
    });

    it('family revocation only fires for reuse OLDER than the 10 s grace window (concurrent refresh safe)', async () => {
      stubTransaction([]);

      await expect(service.refresh('raced-token')).rejects.toBeInstanceOf(UnauthorizedException);

      expect(REFRESH_REUSE_GRACE_SECONDS).toBe(10);
      const familyRevoke = mockClientQuery.mock.calls.find(
        (c) => String(c[0]).includes('family_id = (SELECT family_id'),
      );
      // The replay predicate is gated on the age of the revocation, so a loser
      // of a concurrent refresh (revoked milliseconds ago) never kills the
      // winner's successor.
      expect(String(familyRevoke![0])).toMatch(/revoked_at <= now\(\) - make_interval\(secs => \$2\)/);
      // And no sibling token is minted for the loser.
      expect(insertCall(mockClientQuery.mock.calls)).toBeUndefined();
      expect(mockJwt.sign).not.toHaveBeenCalled();
    });

    it.each(['suspended', 'deleted'])('%s account → 401 account_disabled and all its tokens revoked', async (status) => {
      stubTransaction([{ ...consumedRow, status }]);

      await expect(service.refresh('old-token')).rejects.toMatchObject({
        response: { code: 'account_disabled' },
      });
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_id = $1 AND revoked_at IS NULL'),
        ['user-abc'],
      );
      expect(sqlCalls()).toContain('COMMIT');
      expect(insertCall(mockClientQuery.mock.calls)).toBeUndefined();
      expect(mockJwt.sign).not.toHaveBeenCalled();
    });

    it('rolls back and releases the connection on a database error', async () => {
      mockClientQuery.mockImplementation((sql: string) =>
        sql.includes('INSERT') ? Promise.reject(new Error('db down')) : Promise.resolve({ rows: [consumedRow] }),
      );

      await expect(service.refresh('old-token')).rejects.toThrow('db down');
      expect(sqlCalls()).toContain('ROLLBACK');
      expect(sqlCalls()).not.toContain('COMMIT');
      expect(mockClientRelease).toHaveBeenCalled();
    });
  });

  describe('revokePresented (native logout, possession-based)', () => {
    it('revokes the live token by digest only — no user id needed', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

      await service.revokePresented('some-token');

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toContain('UPDATE auth_refresh_token SET revoked_at = now()');
      expect(sql).toContain('WHERE token_hash = $1 AND revoked_at IS NULL');
      expect(sql).not.toContain('user_id');
      expect(params).toEqual([sha256('some-token')]);
    });

    it('resolves silently when the token is unknown or already revoked', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });
      await expect(service.revokePresented('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('revoke', () => {
    it('sets revoked_at on the matching token, looked up by digest', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

      await service.revoke('some-token', 'user-abc');

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE auth_refresh_token SET revoked_at'),
        [sha256('some-token'), 'user-abc'],
      );
    });

    it('is a no-op when token does not exist or already revoked', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 0 });

      await expect(service.revoke('nonexistent-token', 'user-abc')).resolves.toBeUndefined();
    });
  });

  describe('linkGoogle', () => {
    const googlePayload = { sub: 'google-sub-123', email: 'user@example.com', email_verified: true as const };

    it('sets google_sub and email on the user row', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT: google_sub not found
        .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

      await service.linkGoogle('user-abc', 'google-id-token');

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE app_user SET google_sub'),
        ['google-sub-123', 'user@example.com', 'user-abc'],
      );
    });

    it('is a no-op when google_sub is already linked to same user', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ user_id: 'user-abc' }] }) // SELECT: same user
        .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE

      await expect(service.linkGoogle('user-abc', 'google-id-token')).resolves.toBeUndefined();
    });

    it('throws 409 when google_sub is linked to a different user', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ user_id: 'other-user' }] });

      await expect(service.linkGoogle('user-abc', 'google-id-token')).rejects.toThrow(
        ConflictException,
      );

      try {
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ user_id: 'other-user' }] });
        await service.linkGoogle('user-abc', 'google-id-token');
      } catch (err) {
        expect((err as ConflictException).getResponse()).toMatchObject({ code: 'google_already_linked' });
      }
    });

    it('propagates token verification errors from GoogleVerifierService', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockRejectedValue(
        new UnauthorizedException({ code: 'google_token_invalid' }),
      );

      await expect(service.linkGoogle('user-abc', 'bad-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('signInWithGoogle', () => {
    const googlePayload = { sub: 'google-sub-123', email: 'user@example.com', email_verified: true as const };
    const existing = { id: 'user-abc', role: 'client', phone_e164: null, email: 'user@example.com', status: 'active' };

    function sqlCalls(calls: unknown[][], fragment: string): unknown[][] {
      return calls.filter((c) => String(c[0]).includes(fragment));
    }

    it('logs in the account whose google_sub matches — no registration', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [existing] }) // SELECT by google_sub
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      const result = await service.signInWithGoogle('google-id-token');

      expect(mockGoogle.verifyIdToken).toHaveBeenCalledWith('google-id-token');
      expect(result.access_token).toBe('signed-jwt');
      expect(result.refresh_token).toMatch(REFRESH_TOKEN_RE);
      expect(result.user).toEqual({ id: 'user-abc', role: 'client', phone_e164: null, email: 'user@example.com' });
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-abc', auth_method: 'google' }),
        expect.anything(),
      );
      expect((insertCall(mockPoolQuery.mock.calls)![1] as unknown[])[3]).toBe('google');
      expect(mockPoolQuery.mock.calls[0][1]).toEqual(['google-sub-123']);
      expect(mockClientQuery).not.toHaveBeenCalled();
      expect(sqlCalls(mockPoolQuery.mock.calls, 'UPDATE app_user')).toHaveLength(0);
    });

    it('keeps a phone account linked earlier as is (driver role preserved)', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ ...existing, role: 'driver', phone_e164: '+12025551234' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.signInWithGoogle('google-id-token');

      expect(result.user).toMatchObject({ role: 'driver', phone_e164: '+12025551234' });
    });

    it('updates the stored email when Google now verifies a different one', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue({ ...googlePayload, email: 'new@example.com' });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [existing] })
        .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE email
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      const result = await service.signInWithGoogle('google-id-token');

      expect(result.user.email).toBe('new@example.com');
      expect(sqlCalls(mockPoolQuery.mock.calls, 'UPDATE app_user SET email')[0][1]).toEqual([
        'user-abc',
        'new@example.com',
      ]);
    });

    it('registers a new client account (sub + verified email, no phone) in one transaction', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT by google_sub: none
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token
      mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO app_user')) {
          return { rows: [{ id: params![0], role: 'client', phone_e164: null, email: params![2], status: 'active' }] };
        }
        return { rows: [] };
      });

      const result = await service.signInWithGoogle('google-id-token');

      const statements = mockClientQuery.mock.calls.map((c) => String(c[0]));
      expect(statements[0]).toBe('BEGIN');
      expect(statements[1]).toContain('INSERT INTO app_user');
      expect(statements[1]).toContain('ON CONFLICT (google_sub) DO NOTHING');
      expect(statements[1]).toContain("'client'");
      expect(statements[2]).toContain('INSERT INTO client');
      expect(statements[3]).toBe('COMMIT');
      const insertParams = mockClientQuery.mock.calls[1][1] as unknown[];
      expect(insertParams.slice(1)).toEqual(['google-sub-123', 'user@example.com']);
      expect(insertParams[0]).toMatch(UUID_RE);
      expect(mockClientRelease).toHaveBeenCalled();
      expect(result.user).toEqual({ id: insertParams[0], role: 'client', phone_e164: null, email: 'user@example.com' });
    });

    it('never links by email: only google_sub is looked up', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery.mockResolvedValue({ rows: [] });
      mockClientQuery.mockImplementation(async (sql: string, params?: unknown[]) =>
        sql.includes('INSERT INTO app_user')
          ? { rows: [{ id: params![0], role: 'client', phone_e164: null, email: params![2], status: 'active' }] }
          : { rows: [] },
      );

      await service.signInWithGoogle('google-id-token');

      const all = [...mockPoolQuery.mock.calls, ...mockClientQuery.mock.calls].map((c) => String(c[0]));
      expect(all.some((q) => /WHERE[^]*email/i.test(q))).toBe(false);
    });

    it('a concurrent first sign-in that lost the insert race logs in as the winner', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT: not yet
        .mockResolvedValueOnce({ rows: [existing] }) // re-SELECT: the winner
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token
      mockClientQuery.mockResolvedValue({ rows: [] }); // ON CONFLICT DO NOTHING → no row

      const result = await service.signInWithGoogle('google-id-token');

      expect(result.user.id).toBe('user-abc');
      expect(sqlCalls(mockClientQuery.mock.calls, 'INSERT INTO client')).toHaveLength(0);
      expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    });

    it('a unique violation (409) during registration rolls back and retries as login', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [existing] })
        .mockResolvedValueOnce({ rows: [] });
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO app_user')) throw Object.assign(new Error('dup'), { code: '23505' });
        return { rows: [] };
      });

      const result = await service.signInWithGoogle('google-id-token');

      expect(result.user.id).toBe('user-abc');
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('rethrows any other database error after rolling back', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      mockClientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO app_user')) throw new Error('connection lost');
        return { rows: [] };
      });

      await expect(service.signInWithGoogle('google-id-token')).rejects.toThrow('connection lost');
      expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClientRelease).toHaveBeenCalled();
    });

    it('409 when the race winner cannot be read back', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery.mockResolvedValue({ rows: [] });
      mockClientQuery.mockResolvedValue({ rows: [] });

      await expect(service.signInWithGoogle('google-id-token')).rejects.toThrow(ConflictException);
    });

    it.each(['suspended', 'deleted'])('rejects a %s account with 403 account_disabled (F12)', async (status) => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue({ ...googlePayload, email: 'changed@example.com' });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...existing, status }] });

      await expect(service.signInWithGoogle('google-id-token')).rejects.toMatchObject({
        response: { code: 'account_disabled' },
      });
      expect(insertCall(mockPoolQuery.mock.calls)).toBeUndefined();
      expect(sqlCalls(mockPoolQuery.mock.calls, 'UPDATE app_user')).toHaveLength(0);
    });

    it('is refused with 403 auth_method_disabled while google is not enabled', async () => {
      const err = await serviceWith(['phone'])
        .signInWithGoogle('google-id-token')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: 'auth_method_disabled' });
      expect(mockGoogle.verifyIdToken).not.toHaveBeenCalled();
    });

    it('propagates verifier errors (invalid token, unverified email, not configured)', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockRejectedValue(
        new ForbiddenException({ code: 'google_email_unverified' }),
      );
      await expect(service.signInWithGoogle('t')).rejects.toMatchObject({
        response: { code: 'google_email_unverified' },
      });
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('legacy loginWithGoogle is the same login-or-register flow', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery.mockResolvedValueOnce({ rows: [existing] }).mockResolvedValueOnce({ rows: [] });

      const result = await service.loginWithGoogle('google-id-token');

      expect(result.user.id).toBe('user-abc');
    });
  });
});
