import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEV_BROWSER_ORIGINS,
  DEV_JWT_SECRET,
  resolveBrowserOrigins,
  resolveJwtSecret,
} from './auth-config';
import { resolveGoogleClientIds } from '../../infra/google/google-verifier.service';

const STRONG_SECRET = 'b3f1c0a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1';

describe('resolveJwtSecret (F11)', () => {
  it.each(['development', 'test'])('falls back to the dev secret when unset in %s and reports it', (NODE_ENV) => {
    const onFallback = vi.fn();
    expect(resolveJwtSecret({ NODE_ENV }, onFallback)).toBe(DEV_JWT_SECRET);
    expect(resolveJwtSecret({ NODE_ENV, JWT_SECRET: '  ' }, onFallback)).toBe(DEV_JWT_SECRET);
    expect(onFallback).toHaveBeenCalledTimes(2);
  });

  it('uses a configured secret in development as-is', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'development', JWT_SECRET: 'short-dev' })).toBe('short-dev');
  });

  it.each([
    ['production, unset', { NODE_ENV: 'production' }, /must be set/],
    ['production, empty', { NODE_ENV: 'production', JWT_SECRET: '' }, /must be set/],
    ['production, blank', { NODE_ENV: 'production', JWT_SECRET: '   ' }, /must be set/],
    ['NODE_ENV unset, unset secret', {}, /must be set/],
    ['staging, unset', { NODE_ENV: 'staging' }, /must be set/],
    ['public dev secret', { NODE_ENV: 'production', JWT_SECRET: DEV_JWT_SECRET }, /placeholder/],
    ['template placeholder', { NODE_ENV: 'production', JWT_SECRET: '<generate-with-openssl-rand-hex-32-xxxxx>' }, /placeholder/],
    ['change-me text', { NODE_ENV: 'production', JWT_SECRET: 'please-change-me-before-going-live-0123456789' }, /placeholder/],
    ['too short (31 bytes)', { NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET.slice(0, 31) }, /at least 32 bytes/],
    ['repetitive', { NODE_ENV: 'production', JWT_SECRET: 'ab'.repeat(32) }, /repetitive/],
    ['surrounding whitespace', { NODE_ENV: 'production', JWT_SECRET: ` ${STRONG_SECRET}` }, /whitespace/],
  ])('rejects %s', (_label, env, message) => {
    expect(() => resolveJwtSecret(env)).toThrow(message);
  });

  it('never includes the secret value in the error', () => {
    const weak = 'abcdefghij0123456789';
    try {
      resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: weak });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(weak);
    }
  });

  it('accepts a strong random secret in production', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: STRONG_SECRET })).toBe(STRONG_SECRET);
  });
});

describe('resolveBrowserOrigins (F11)', () => {
  it('defaults to the local web origins in development/test', () => {
    expect(resolveBrowserOrigins({ NODE_ENV: 'development' })).toEqual(DEV_BROWSER_ORIGINS);
    expect(resolveBrowserOrigins({ NODE_ENV: 'test' })).toContain('http://localhost:3002');
  });

  it('parses, trims and de-duplicates CORS_ORIGINS', () => {
    expect(
      resolveBrowserOrigins({
        NODE_ENV: 'production',
        CORS_ORIGINS: ' https://app.example.com , https://admin.example.com,https://app.example.com,',
      }),
    ).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('accepts the legacy ALLOWED_ORIGINS alias when CORS_ORIGINS is unset', () => {
    expect(resolveBrowserOrigins({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.example.com' })).toEqual([
      'https://app.example.com',
    ]);
  });

  it('accepts both variables when they agree', () => {
    expect(
      resolveBrowserOrigins({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://a.example.com,https://b.example.com',
        ALLOWED_ORIGINS: 'https://b.example.com, https://a.example.com',
      }),
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it.each([
    ['missing in production', { NODE_ENV: 'production' }, /must list/],
    ['missing with NODE_ENV unset', {}, /must list/],
    ['only separators', { NODE_ENV: 'production', CORS_ORIGINS: ' , ,' }, /must list/],
    ['wildcard', { NODE_ENV: 'production', CORS_ORIGINS: '*' }, /must not contain/],
    ['wildcard in dev too', { NODE_ENV: 'development', CORS_ORIGINS: '*' }, /must not contain/],
    ['"null" origin', { NODE_ENV: 'production', CORS_ORIGINS: 'null' }, /must not contain/],
    ['not a URL', { NODE_ENV: 'production', CORS_ORIGINS: 'app.example.com' }, /not a valid origin/],
    ['trailing slash', { NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com/' }, /bare origin/],
    ['path', { NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com/web' }, /bare origin/],
    ['non-http scheme', { NODE_ENV: 'production', CORS_ORIGINS: 'ftp://app.example.com' }, /http or https/],
    ['plain http in production', { NODE_ENV: 'production', CORS_ORIGINS: 'http://app.example.com' }, /https/],
    [
      'contradictory CORS_ORIGINS / ALLOWED_ORIGINS',
      { NODE_ENV: 'production', CORS_ORIGINS: 'https://a.example.com', ALLOWED_ORIGINS: 'https://b.example.com' },
      /differ/,
    ],
  ])('rejects %s', (_label, env, message) => {
    expect(() => resolveBrowserOrigins(env)).toThrow(message);
  });

  it('allows plain http origins in development', () => {
    expect(resolveBrowserOrigins({ NODE_ENV: 'development', CORS_ORIGINS: 'http://192.168.1.5:3002' })).toEqual([
      'http://192.168.1.5:3002',
    ]);
  });
});

describe('infra/docker/env.example/api.env.example matches what the API reads (F11)', () => {
  const examplePath = join(__dirname, '../../../../../infra/docker/env.example/api.env.example');
  const entries = Object.fromEntries(
    readFileSync(examplePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  ) as Record<string, string>;

  it('documents every auth variable the API consumes', () => {
    for (const key of ['JWT_SECRET', 'FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CLIENT_IDS', 'CORS_ORIGINS']) {
      expect(entries, key).toHaveProperty(key);
    }
  });

  it('ships a Google client id placeholder that configures no audience (RCAB-E8.S15)', () => {
    expect(resolveGoogleClientIds({ GOOGLE_CLIENT_IDS: entries.GOOGLE_CLIENT_IDS })).toEqual([]);
  });

  it('does not document variables the API never reads', () => {
    expect(entries).not.toHaveProperty('JWT_PRIVATE_KEY_PATH');
    expect(entries).not.toHaveProperty('FIREBASE_ADMIN_SDK_PATH');
  });

  it('ships an origin list that validates in production', () => {
    expect(() => resolveBrowserOrigins({ NODE_ENV: 'production', CORS_ORIGINS: entries.CORS_ORIGINS })).not.toThrow();
  });

  it('ships no usable JWT secret, so an unedited copy cannot start in production', () => {
    expect(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: entries.JWT_SECRET })).toThrow();
  });
});
