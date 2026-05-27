import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

function makeContext(origin?: string, referer?: string) {
  const req = {
    headers: {
      ...(origin !== undefined ? { origin } : {}),
      ...(referer !== undefined ? { referer } : {}),
    },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as import('@nestjs/common').ExecutionContext;
}

describe('CsrfGuard', () => {
  let guard: CsrfGuard;
  const savedEnv = { NODE_ENV: process.env.NODE_ENV, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS };

  beforeEach(() => {
    guard = new CsrfGuard();
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_ORIGINS;
  });

  afterEach(() => {
    process.env.NODE_ENV = savedEnv.NODE_ENV;
    if (savedEnv.ALLOWED_ORIGINS !== undefined) {
      process.env.ALLOWED_ORIGINS = savedEnv.ALLOWED_ORIGINS;
    } else {
      delete process.env.ALLOWED_ORIGINS;
    }
  });

  it('allows requests with no Origin header (non-browser / same-origin)', () => {
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it('allows same-origin request matching dev default (localhost:3001)', () => {
    expect(guard.canActivate(makeContext('http://localhost:3001'))).toBe(true);
  });

  it('allows same-origin request matching dev default (localhost:3000)', () => {
    expect(guard.canActivate(makeContext('http://localhost:3000'))).toBe(true);
  });

  it('rejects cross-origin request not in allowed list', () => {
    expect(() => guard.canActivate(makeContext('https://evil.com'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(makeContext('https://evil.com'))).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'csrf_rejected' }) }),
    );
  });

  it('allows custom origin set via ALLOWED_ORIGINS env var', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com,https://api.example.com';
    expect(guard.canActivate(makeContext('https://app.example.com'))).toBe(true);
  });

  it('rejects origin not in custom ALLOWED_ORIGINS list', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    expect(() => guard.canActivate(makeContext('https://other.com'))).toThrow(ForbiddenException);
  });

  it('rejects cross-origin Origin regardless of Referer', () => {
    expect(() =>
      guard.canActivate(makeContext('https://evil.com', 'http://localhost:3001/path')),
    ).toThrow(ForbiddenException);
  });
});
