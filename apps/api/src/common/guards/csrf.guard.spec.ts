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

const ENV_KEYS = ['NODE_ENV', 'ALLOWED_ORIGINS', 'CORS_ORIGINS'] as const;

describe('CsrfGuard', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.CORS_ORIGINS;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });

  it('allows requests with neither Origin nor Referer (non-browser client)', () => {
    expect(new CsrfGuard().canActivate(makeContext())).toBe(true);
  });

  it('allows the dev web app origin (localhost:3002) by default', () => {
    expect(new CsrfGuard().canActivate(makeContext('http://localhost:3002'))).toBe(true);
  });

  it('keeps the legacy dev defaults (localhost:3001 / 3000)', () => {
    const guard = new CsrfGuard();
    expect(guard.canActivate(makeContext('http://localhost:3001'))).toBe(true);
    expect(guard.canActivate(makeContext('http://localhost:3000'))).toBe(true);
  });

  it('rejects cross-origin request not in allowed list', () => {
    const guard = new CsrfGuard();
    expect(() => guard.canActivate(makeContext('https://evil.com'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(makeContext('https://evil.com'))).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'csrf_rejected' }) }),
    );
  });

  it('uses the same CORS_ORIGINS list as credentialed CORS', () => {
    process.env.CORS_ORIGINS = 'https://app.example.com,https://api.example.com';
    const guard = new CsrfGuard();
    expect(guard.canActivate(makeContext('https://app.example.com'))).toBe(true);
    expect(() => guard.canActivate(makeContext('http://localhost:3002'))).toThrow(ForbiddenException);
  });

  it('still honours the legacy ALLOWED_ORIGINS alias', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    const guard = new CsrfGuard();
    expect(guard.canActivate(makeContext('https://app.example.com'))).toBe(true);
    expect(() => guard.canActivate(makeContext('https://other.com'))).toThrow(ForbiddenException);
  });

  it('rejects cross-origin Origin regardless of Referer', () => {
    expect(() =>
      new CsrfGuard().canActivate(makeContext('https://evil.com', 'http://localhost:3002/path')),
    ).toThrow(ForbiddenException);
  });

  it('rejects the opaque "null" Origin', () => {
    expect(() => new CsrfGuard().canActivate(makeContext('null'))).toThrow(ForbiddenException);
  });

  it('checks Referer when Origin is absent', () => {
    const guard = new CsrfGuard();
    expect(guard.canActivate(makeContext(undefined, 'http://localhost:3002/book?x=1'))).toBe(true);
    expect(() => guard.canActivate(makeContext(undefined, 'https://evil.com/page'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(makeContext(undefined, 'not a url'))).toThrow(ForbiddenException);
  });

  describe('startup validation (F11)', () => {
    it('refuses to construct in production without an origin list', () => {
      process.env.NODE_ENV = 'production';
      expect(() => new CsrfGuard()).toThrow(/CORS_ORIGINS/);
    });

    it('refuses to construct in production with a wildcard', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = '*';
      expect(() => new CsrfGuard()).toThrow(/CORS_ORIGINS/);
    });

    it('does not apply dev defaults in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://app.example.com';
      const guard = new CsrfGuard();
      expect(() => guard.canActivate(makeContext('http://localhost:3002'))).toThrow(ForbiddenException);
      expect(guard.canActivate(makeContext('https://app.example.com'))).toBe(true);
    });
  });
});
