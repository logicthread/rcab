import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';

const { mockVerifyIdToken } = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

import { GoogleVerifierService } from './google-verifier.service';

function makeTicket(overrides: Record<string, unknown> = {}) {
  const payload = {
    sub: 'google-sub-123',
    email: 'user@example.com',
    email_verified: true,
    iss: 'accounts.google.com',
    aud: 'test-client-id',
    ...overrides,
  };
  return { getPayload: () => payload };
}

describe('GoogleVerifierService', () => {
  let service: GoogleVerifierService;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    mockVerifyIdToken.mockReset();
    service = new GoogleVerifierService();
  });

  it('returns sub, email, email_verified for a valid token', async () => {
    mockVerifyIdToken.mockResolvedValue(makeTicket());

    const result = await service.verifyIdToken('valid-token');

    expect(result.sub).toBe('google-sub-123');
    expect(result.email).toBe('user@example.com');
    expect(result.email_verified).toBe(true);
  });

  it('accepts https://accounts.google.com as iss', async () => {
    mockVerifyIdToken.mockResolvedValue(makeTicket({ iss: 'https://accounts.google.com' }));

    await expect(service.verifyIdToken('valid-token')).resolves.toBeDefined();
  });

  it('throws 401 for invalid iss', async () => {
    mockVerifyIdToken.mockResolvedValue(makeTicket({ iss: 'https://evil.com' }));

    await expect(service.verifyIdToken('bad-iss-token')).rejects.toMatchObject({
      response: { code: 'invalid_google_token' },
    });
  });

  it('throws 401 when email_verified is false', async () => {
    mockVerifyIdToken.mockResolvedValue(makeTicket({ email_verified: false }));

    await expect(service.verifyIdToken('unverified-email-token')).rejects.toMatchObject({
      response: { code: 'email_not_verified' },
    });
  });

  it('throws 401 when OAuth2Client.verifyIdToken throws (invalid signature / wrong aud)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Token used too late'));

    await expect(service.verifyIdToken('expired-token')).rejects.toThrow(UnauthorizedException);
    mockVerifyIdToken.mockRejectedValue(new Error('Token used too late'));
    await expect(service.verifyIdToken('expired-token')).rejects.toMatchObject({
      response: { code: 'invalid_google_token' },
    });
  });

  it('throws 401 when payload is null', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => undefined });

    await expect(service.verifyIdToken('null-payload-token')).rejects.toMatchObject({
      response: { code: 'invalid_google_token' },
    });
  });
});
