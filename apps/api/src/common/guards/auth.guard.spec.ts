import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard, type JwtPayload } from './auth.guard';
import { JWT_AUDIENCE, JWT_ISSUER, signAccessToken } from './access-token';
import type { ExecutionContext } from '@nestjs/common';

function makeContext(authHeader?: string): ExecutionContext {
  const req = { headers: { ...(authHeader ? { authorization: authHeader } : {}) } };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const validPayload: JwtPayload = {
  sub: 'user-id-123',
  role: 'client',
  auth_method: 'phone',
  typ: 'access',
  iss: 'rcab',
  aud: 'rcab-api',
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 840,
};

describe('AuthGuard', () => {
  let guard: AuthGuard;
  let mockJwt: JwtService;

  beforeEach(() => {
    mockJwt = { verify: vi.fn() } as unknown as JwtService;
    guard = new AuthGuard(mockJwt);
  });

  it('passes and attaches user for a valid JWT', () => {
    vi.mocked(mockJwt.verify).mockReturnValue(validPayload as never);
    const ctx = makeContext('Bearer valid-token');

    expect(guard.canActivate(ctx)).toBe(true);
    const req = ctx.switchToHttp().getRequest<{ user?: JwtPayload }>();
    expect(req.user).toEqual(validPayload);
  });

  it('verifies issuer, audience and algorithm', () => {
    vi.mocked(mockJwt.verify).mockReturnValue(validPayload as never);
    guard.canActivate(makeContext('Bearer valid-token'));
    expect(mockJwt.verify).toHaveBeenCalledWith('valid-token', {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
  });

  it('throws 401 when Authorization header is missing', () => {
    expect(() => guard.canActivate(makeContext())).toThrow(UnauthorizedException);
  });

  it('throws 401 when Authorization header does not start with Bearer', () => {
    expect(() => guard.canActivate(makeContext('Token abc'))).toThrow(UnauthorizedException);
  });

  it('throws 401 when JwtService.verify throws (expired token)', () => {
    vi.mocked(mockJwt.verify).mockImplementation(() => { throw new Error('TokenExpiredError'); });
    expect(() => guard.canActivate(makeContext('Bearer expired-token'))).toThrow(UnauthorizedException);
  });

  it('throws 401 when JwtService.verify throws (wrong issuer)', () => {
    vi.mocked(mockJwt.verify).mockImplementation(() => { throw new Error('JsonWebTokenError: invalid issuer'); });
    expect(() => guard.canActivate(makeContext('Bearer wrong-iss-token'))).toThrow(UnauthorizedException);
  });

  it('throws 401 when payload has no sub', () => {
    vi.mocked(mockJwt.verify).mockReturnValue({ ...validPayload, sub: '' } as never);
    expect(() => guard.canActivate(makeContext('Bearer no-sub-token'))).toThrow(UnauthorizedException);
  });

  it('throws 401 when the token is not an access token (no typ claim)', () => {
    const untyped: Partial<JwtPayload> = { ...validPayload };
    delete untyped.typ;
    vi.mocked(mockJwt.verify).mockReturnValue(untyped as never);
    expect(() => guard.canActivate(makeContext('Bearer untyped-token'))).toThrow(UnauthorizedException);
  });

  describe('with a real JwtService (F11)', () => {
    const secret = 'auth-guard-spec-secret-0123456789abcdef';
    const realJwt = new JwtService({ secret });
    const realGuard = new AuthGuard(realJwt);
    const claims = { sub: 'user-1', role: 'driver', auth_method: 'phone' };

    it('accepts a token from signAccessToken', () => {
      expect(realGuard.canActivate(makeContext(`Bearer ${signAccessToken(realJwt, claims)}`))).toBe(true);
    });

    it('rejects a token forged with the old public fallback secret', () => {
      const forged = signAccessToken(new JwtService({ secret: 'dev-secret-change-in-prod' }), claims);
      expect(() => realGuard.canActivate(makeContext(`Bearer ${forged}`))).toThrow(UnauthorizedException);
    });

    it('rejects a quote token signed with the same secret', () => {
      const quote = realJwt.sign({ originLat: 1 }, { issuer: 'rcab-quote', expiresIn: '5m' });
      expect(() => realGuard.canActivate(makeContext(`Bearer ${quote}`))).toThrow(UnauthorizedException);
    });

    it('rejects a legacy token with issuer only (no audience / typ)', () => {
      const legacy = realJwt.sign(claims, { issuer: 'rcab', expiresIn: '15m' });
      expect(() => realGuard.canActivate(makeContext(`Bearer ${legacy}`))).toThrow(UnauthorizedException);
    });
  });
});
