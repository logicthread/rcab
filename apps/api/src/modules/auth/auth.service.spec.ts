import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException, ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { AuthService, hashRefreshToken } from './auth.service';
import { FirebaseAdminService } from '../../infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../infra/google/google-verifier.service';
import type { auth } from 'firebase-admin';

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
    } as unknown as GoogleVerifierService;

    mockJwt = {
      sign: vi.fn().mockReturnValue('signed-jwt'),
    } as unknown as JwtService;

    const mockPool = {
      query: mockPoolQuery,
      connect: vi.fn().mockResolvedValue({
        query: mockClientQuery,
        release: mockClientRelease,
      }),
    };

    service = new AuthService(mockFirebase, mockGoogle, mockJwt, mockPool as unknown as import('pg').Pool);
  });

  function insertCall(calls: unknown[][]): unknown[] | undefined {
    return calls.find((c) => String(c[0]).includes('INSERT INTO auth_refresh_token'));
  }

  describe('hashRefreshToken', () => {
    it('is the hex SHA-256 digest of the token', () => {
      expect(hashRefreshToken('abc')).toBe(sha256('abc'));
      expect(hashRefreshToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('exchangeFirebaseToken', () => {
    it('returns access_token, refresh_token, and user on valid token', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // SELECT: user not found
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      const result = await service.exchangeFirebaseToken('valid-token');

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
      expect(familyRevoke![1]).toEqual([sha256('used-token')]);
      // The family revocation must be committed, not rolled back with the 401.
      expect(sqlCalls()).toContain('COMMIT');
      expect(sqlCalls()).not.toContain('ROLLBACK');
      expect(insertCall(mockClientQuery.mock.calls)).toBeUndefined();
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
    const googlePayload = { sub: 'google-sub-123', email: 'user@example.com', email_verified: true };

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
        new UnauthorizedException({ code: 'invalid_google_token' }),
      );

      await expect(service.linkGoogle('user-abc', 'bad-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('loginWithGoogle', () => {
    const googlePayload = { sub: 'google-sub-123', email: 'user@example.com', email_verified: true };

    it('returns tokens when google_sub matches a user', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      const user = { id: 'user-abc', role: 'client', phone_e164: '+12025551234', status: 'active' };
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [user] }) // SELECT by google_sub
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      const result = await service.loginWithGoogle('google-id-token');

      expect(result.access_token).toBe('signed-jwt');
      expect(result.refresh_token).toMatch(REFRESH_TOKEN_RE);
      expect(result.user).toEqual({ id: 'user-abc', role: 'client', phone_e164: '+12025551234' });
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-abc', auth_method: 'google' }),
        expect.anything(),
      );
      expect((insertCall(mockPoolQuery.mock.calls)![1] as unknown[])[3]).toBe('google');
    });

    it.each(['suspended', 'deleted'])('rejects a %s account with 403 account_disabled (F12)', async (status) => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: 'user-abc', role: 'client', phone_e164: '+12025551234', status }],
      });

      await expect(service.loginWithGoogle('google-id-token')).rejects.toMatchObject({
        response: { code: 'account_disabled' },
      });
      expect(insertCall(mockPoolQuery.mock.calls)).toBeUndefined();
    });

    it('throws 401 not_found when no account has that google_sub', async () => {
      vi.mocked(mockGoogle.verifyIdToken).mockResolvedValue(googlePayload);
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.loginWithGoogle('google-id-token')).rejects.toMatchObject({
        response: { code: 'not_found' },
      });
    });
  });
});
