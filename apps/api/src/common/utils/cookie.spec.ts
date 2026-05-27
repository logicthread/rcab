import { describe, it, expect, afterEach } from 'vitest';
import { refreshCookieOptions, clearCookieOptions } from './cookie';

describe('refreshCookieOptions', () => {
  const saved = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = saved;
  });

  it('sets Secure=true only in production', () => {
    process.env.NODE_ENV = 'production';
    expect(refreshCookieOptions().secure).toBe(true);
  });

  it('sets Secure=false in development', () => {
    process.env.NODE_ENV = 'development';
    expect(refreshCookieOptions().secure).toBe(false);
  });

  it('sets Secure=false in test', () => {
    process.env.NODE_ENV = 'test';
    expect(refreshCookieOptions().secure).toBe(false);
  });

  it('always sets httpOnly, SameSite=lax, correct path and maxAge', () => {
    const opts = refreshCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/v1/auth');
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('clearCookieOptions', () => {
  it('sets maxAge=0', () => {
    expect(clearCookieOptions().maxAge).toBe(0);
  });

  it('preserves httpOnly and path', () => {
    const opts = clearCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe('/v1/auth');
  });
});
