import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard, type JwtPayload } from './auth.guard';
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
  iss: 'rcab',
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
});
