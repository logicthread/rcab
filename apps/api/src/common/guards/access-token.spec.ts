import { describe, it, expect } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  signAccessToken,
  verifyAccessToken,
} from './access-token';

const SECRET = 'access-token-spec-secret-0123456789abcdef';
const jwt = new JwtService({ secret: SECRET });
const claims = { sub: 'user-1', role: 'client', auth_method: 'phone' };

describe('access tokens (F11)', () => {
  it('signs issuer, audience, token type and a 15-minute expiry', () => {
    const payload = jwt.decode(signAccessToken(jwt, claims)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      ...claims,
      typ: 'access',
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('round-trips a signed access token', () => {
    expect(verifyAccessToken(jwt, signAccessToken(jwt, claims))).toMatchObject({ ...claims, typ: 'access' });
  });

  it('rejects a token without the access token type', () => {
    const untyped = jwt.sign(claims, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    expect(() => verifyAccessToken(jwt, untyped)).toThrow(/not an access token/);
  });

  it('rejects a token with another token type', () => {
    const refreshLike = jwt.sign({ ...claims, typ: 'refresh' }, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    expect(() => verifyAccessToken(jwt, refreshLike)).toThrow(/not an access token/);
  });

  it('rejects a token without the rcab-api audience', () => {
    const noAud = jwt.sign({ ...claims, typ: 'access' }, { issuer: JWT_ISSUER });
    expect(() => verifyAccessToken(jwt, noAud)).toThrow(/audience/);
    const otherAud = jwt.sign({ ...claims, typ: 'access' }, { issuer: JWT_ISSUER, audience: 'other' });
    expect(() => verifyAccessToken(jwt, otherAud)).toThrow(/audience/);
  });

  it('rejects a quote token (different issuer) presented as an access token', () => {
    const quote = jwt.sign({ ...claims, typ: 'access' }, { issuer: 'rcab-quote', audience: JWT_AUDIENCE });
    expect(() => verifyAccessToken(jwt, quote)).toThrow(/issuer/);
  });

  it('rejects a token signed with another secret', () => {
    const forged = signAccessToken(new JwtService({ secret: 'dev-secret-change-in-prod' }), claims);
    expect(() => verifyAccessToken(jwt, forged)).toThrow(/signature/);
  });

  it('rejects an unsigned (alg=none) token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(
      JSON.stringify({ ...claims, typ: 'access', iss: JWT_ISSUER, aud: JWT_AUDIENCE, iat: now, exp: now + 60 }),
    ).toString('base64url');
    expect(() => verifyAccessToken(jwt, `${header}.${body}.`)).toThrow();
  });

  it('rejects an empty subject', () => {
    const noSub = signAccessToken(jwt, { ...claims, sub: '' });
    expect(() => verifyAccessToken(jwt, noSub)).toThrow(/missing sub/);
  });
});
