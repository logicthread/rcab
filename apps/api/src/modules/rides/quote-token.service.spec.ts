import { describe, it, expect } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { QuoteTokenService, type QuoteClaims } from './quote-token.service';

const SECRET = 'test-secret';
const claims: QuoteClaims = {
  originLat: 26.1445,
  originLng: 91.7362,
  destLat: 26.1758,
  destLng: 91.7898,
  soloFareCents: 18500,
  distanceM: 10197,
  durationS: 796,
};

function svc(): QuoteTokenService {
  return new QuoteTokenService(new JwtService({ secret: SECRET }));
}

describe('QuoteTokenService', () => {
  it('round-trips claims through sign → verify', () => {
    const s = svc();
    expect(s.verify(s.sign(claims))).toMatchObject(claims);
  });

  it('rejects a token signed with the auth issuer (rcab), not rcab-quote', () => {
    const s = svc();
    const authToken = new JwtService({ secret: SECRET }).sign(claims, { issuer: 'rcab' });
    expect(() => s.verify(authToken)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    const s = svc();
    const foreign = new JwtService({ secret: 'other-secret' }).sign(claims, {
      issuer: 'rcab-quote',
    });
    expect(() => s.verify(foreign)).toThrow();
  });

  it('rejects an expired token with TokenExpiredError', () => {
    const s = svc();
    const expired = new JwtService({ secret: SECRET }).sign(claims, {
      issuer: 'rcab-quote',
      expiresIn: '-10s',
    });
    try {
      s.verify(expired);
      throw new Error('expected verify to throw');
    } catch (err) {
      expect((err as Error).name).toBe('TokenExpiredError');
    }
  });
});
