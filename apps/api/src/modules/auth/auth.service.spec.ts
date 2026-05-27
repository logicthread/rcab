import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { FirebaseAdminService } from '../../infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../infra/google/google-verifier.service';
import type { auth } from 'firebase-admin';

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
      expect(result.refresh_token).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.user.role).toBe('client');
      expect(result.user.phone_e164).toBe('+12025551234');
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
      const existingUser = { id: 'existing-id', role: 'client', phone_e164: '+12025551234' };
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

    it('signs JWT with correct payload', async () => {
      vi.mocked(mockFirebase.verifyIdToken).mockResolvedValue(makeDecodedToken());
      const existingUser = { id: 'uid-abc', role: 'client', phone_e164: '+12025551234' };
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [existingUser] })
        .mockResolvedValueOnce({ rows: [] });

      await service.exchangeFirebaseToken('valid-token');

      expect(mockJwt.sign).toHaveBeenCalledWith({
        sub: 'uid-abc',
        role: 'client',
        auth_method: 'phone',
      });
    });
  });

  describe('refresh', () => {
    const validRow = {
      user_id: 'user-abc',
      role: 'client',
      phone_e164: '+12025551234',
      expires_at: new Date(Date.now() + 86400_000),
      revoked_at: null,
    };

    it('returns new tokens and revokes old token atomically', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [validRow] });
      mockClientQuery.mockResolvedValue({ rows: [] });

      const result = await service.refresh('old-token');

      expect(result.access_token).toBe('signed-jwt');
      expect(result.refresh_token).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.user.id).toBe('user-abc');

      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE auth_refresh_token SET revoked_at'),
        ['old-token'],
      );
      expect(mockClientQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO auth_refresh_token'),
        expect.any(Array),
      );
    });

    it('throws 401 when refresh token is not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await expect(service.refresh('unknown-token')).rejects.toThrow(UnauthorizedException);
    });

    it('throws 401 when refresh token is revoked', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...validRow, revoked_at: new Date() }],
      });

      await expect(service.refresh('revoked-token')).rejects.toMatchObject({
        response: { code: 'invalid_refresh_token' },
      });
    });

    it('throws 401 when refresh token is expired', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...validRow, expires_at: new Date(Date.now() - 1000) }],
      });

      await expect(service.refresh('expired-token')).rejects.toMatchObject({
        response: { code: 'invalid_refresh_token' },
      });
    });
  });

  describe('revoke', () => {
    it('sets revoked_at on the matching token', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });

      await service.revoke('some-token', 'user-abc');

      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE auth_refresh_token SET revoked_at'),
        ['some-token', 'user-abc'],
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
      const user = { id: 'user-abc', role: 'client', phone_e164: '+12025551234' };
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [user] }) // SELECT by google_sub
        .mockResolvedValueOnce({ rows: [] }); // INSERT refresh token

      const result = await service.loginWithGoogle('google-id-token');

      expect(result.access_token).toBe('signed-jwt');
      expect(result.refresh_token).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.user.id).toBe('user-abc');
      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'user-abc', auth_method: 'google' }),
      );
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
