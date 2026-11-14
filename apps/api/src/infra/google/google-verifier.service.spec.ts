import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

const { mockVerifyIdToken } = vi.hoisted(() => ({
  mockVerifyIdToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

import { GoogleVerifierService, resolveGoogleClientIds } from './google-verifier.service';

const WEB_ID = 'web-client.apps.googleusercontent.com';
const OTHER_ID = 'other-client.apps.googleusercontent.com';

function makeTicket(overrides: Record<string, unknown> = {}) {
  const payload = {
    sub: 'google-sub-123',
    email: 'user@example.com',
    email_verified: true,
    iss: 'accounts.google.com',
    aud: WEB_ID,
    exp: Math.floor(Date.now() / 1000) + 3000,
    ...overrides,
  };
  return { getPayload: () => payload };
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  const err = (await p.catch((e: unknown) => e)) as UnauthorizedException;
  return { status: err.getStatus(), code: (err.getResponse() as { code: string }).code };
}

describe('resolveGoogleClientIds', () => {
  it('reads the GOOGLE_CLIENT_IDS comma list, trimmed and de-duplicated', () => {
    expect(resolveGoogleClientIds({ GOOGLE_CLIENT_IDS: ` ${WEB_ID}, ${OTHER_ID},,${WEB_ID} ` })).toEqual([
      WEB_ID,
      OTHER_ID,
    ]);
  });

  it('falls back to the GOOGLE_CLIENT_ID alias only when GOOGLE_CLIENT_IDS is unset or blank', () => {
    expect(resolveGoogleClientIds({ GOOGLE_CLIENT_ID: WEB_ID })).toEqual([WEB_ID]);
    expect(resolveGoogleClientIds({ GOOGLE_CLIENT_IDS: '  ', GOOGLE_CLIENT_ID: WEB_ID })).toEqual([WEB_ID]);
    expect(resolveGoogleClientIds({ GOOGLE_CLIENT_IDS: OTHER_ID, GOOGLE_CLIENT_ID: WEB_ID })).toEqual([OTHER_ID]);
  });

  it('treats unset and env-example placeholders as not configured', () => {
    expect(resolveGoogleClientIds({})).toEqual([]);
    expect(resolveGoogleClientIds({ GOOGLE_CLIENT_ID: '<your-google-client-id>' })).toEqual([]);
    expect(
      resolveGoogleClientIds({ GOOGLE_CLIENT_IDS: '<your-web-oauth-client-id>.apps.googleusercontent.com' }),
    ).toEqual([]);
  });
});

describe('GoogleVerifierService', () => {
  const saved = { ids: process.env.GOOGLE_CLIENT_IDS, id: process.env.GOOGLE_CLIENT_ID };
  let service: GoogleVerifierService;

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_IDS = `${WEB_ID},${OTHER_ID}`;
    delete process.env.GOOGLE_CLIENT_ID;
    mockVerifyIdToken.mockReset();
    service = new GoogleVerifierService();
  });

  afterEach(() => {
    if (saved.ids === undefined) delete process.env.GOOGLE_CLIENT_IDS;
    else process.env.GOOGLE_CLIENT_IDS = saved.ids;
    if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = saved.id;
  });

  it('exposes the audiences; the first one is the advertised client id', () => {
    expect(service.isConfigured).toBe(true);
    expect(service.clientIds).toEqual([WEB_ID, OTHER_ID]);
    expect(service.primaryClientId).toBe(WEB_ID);
  });

  it('returns sub and the verified email for a valid token, checking every audience', async () => {
    mockVerifyIdToken.mockResolvedValue(makeTicket());

    const result = await service.verifyIdToken('valid-token');

    expect(result).toEqual({ sub: 'google-sub-123', email: 'user@example.com', email_verified: true });
    expect(mockVerifyIdToken).toHaveBeenCalledWith({ idToken: 'valid-token', audience: [WEB_ID, OTHER_ID] });
  });

  it('accepts a token for a secondary audience and the https issuer form', async () => {
    mockVerifyIdToken.mockResolvedValue(makeTicket({ aud: OTHER_ID, iss: 'https://accounts.google.com' }));
    await expect(service.verifyIdToken('valid-token')).resolves.toMatchObject({ sub: 'google-sub-123' });
  });

  it.each([
    ['a foreign issuer', { iss: 'https://evil.example' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
    ['a missing exp', { exp: undefined }],
    ['an audience outside GOOGLE_CLIENT_IDS', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['a missing subject', { sub: '' }],
  ])('401 google_token_invalid for %s', async (_label, overrides) => {
    mockVerifyIdToken.mockResolvedValue(makeTicket(overrides));
    expect(await codeOf(service.verifyIdToken('t'))).toEqual({ status: 401, code: 'google_token_invalid' });
  });

  it('401 google_token_invalid when the library rejects (bad signature / wrong aud / expired)', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Token used too late'));
    const p = service.verifyIdToken('expired-token');
    await expect(p).rejects.toThrow(UnauthorizedException);
    expect(await codeOf(p)).toEqual({ status: 401, code: 'google_token_invalid' });
  });

  it('401 google_token_invalid when the payload is empty', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => undefined });
    expect(await codeOf(service.verifyIdToken('t'))).toEqual({ status: 401, code: 'google_token_invalid' });
  });

  it.each([
    ['email_verified false', { email_verified: false }],
    ['email_verified missing', { email_verified: undefined }],
    ['email_verified as a string', { email_verified: 'true' }],
    ['no email', { email: undefined }],
  ])('403 google_email_unverified for %s', async (_label, overrides) => {
    mockVerifyIdToken.mockResolvedValue(makeTicket(overrides));
    const p = service.verifyIdToken('t');
    await expect(p).rejects.toThrow(ForbiddenException);
    expect(await codeOf(p)).toEqual({ status: 403, code: 'google_email_unverified' });
  });

  it('accepts a Workspace (hosted-domain) account like any other verified Google account', async () => {
    mockVerifyIdToken.mockResolvedValue(makeTicket({ email: 'ops@company.example', hd: 'company.example' }));
    await expect(service.verifyIdToken('t')).resolves.toMatchObject({ email: 'ops@company.example' });
  });

  it('with no client id configured: constructs fine, then 503 google_not_configured without calling Google', async () => {
    delete process.env.GOOGLE_CLIENT_IDS;
    const unconfigured = new GoogleVerifierService();

    expect(unconfigured.isConfigured).toBe(false);
    expect(unconfigured.primaryClientId).toBeNull();
    const p = unconfigured.verifyIdToken('t');
    await expect(p).rejects.toThrow(ServiceUnavailableException);
    expect(await codeOf(p)).toEqual({ status: 503, code: 'google_not_configured' });
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
});
