import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { FirebaseAdminService } from '../../infra/firebase/firebase-admin.service';
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

    service = new AuthService(mockFirebase, mockJwt, mockPool as any);
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
});
