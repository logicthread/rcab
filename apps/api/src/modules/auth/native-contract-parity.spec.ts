/**
 * Cross-client parity (integration fixup): the Flutter driver app codes against
 * apps/driver-app/test/fixtures/native_auth_contract.json, while the API proves
 * its controller against test/fixtures/native-auth-contract.json
 * (auth.controller.spec.ts). The API fixture is the source of truth; this spec
 * fails when the mobile mirror drifts from it (paths, methods, header names,
 * request/response key sets and types, `token_type` casing, status codes).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture JSON is walked dynamically
type Json = Record<string, any>;

const apiContract: Json = JSON.parse(
  readFileSync(join(__dirname, '../../../test/fixtures/native-auth-contract.json'), 'utf8'),
);
const mobileContract: Json = JSON.parse(
  readFileSync(join(__dirname, '../../../../driver-app/test/fixtures/native_auth_contract.json'), 'utf8'),
);

/** Recursively maps a JSON value to its shape (sorted keys + primitive types). */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
}

const headerNames = (h: Json | undefined): string[] => Object.keys(h ?? {}).map((k) => k.toLowerCase()).sort();

describe('native auth contract parity: API fixture vs driver-app fixture', () => {
  const api = apiContract.endpoints as Json;

  it.each([
    ['firebase_exchange', 'response_200'],
    ['google', 'response_200'],
    ['refresh', 'response_200'],
  ])('%s: path, method, request body and 200 body match the API', (name, mobileResponseKey) => {
    const a = api[name];
    const m = mobileContract[name];

    expect(m.path).toBe(a.path);
    expect(m.method).toBe(a.method);
    expect(shapeOf(m.request)).toEqual(shapeOf(a.request.body));

    expect(shapeOf(m[mobileResponseKey])).toEqual(shapeOf(a.response.body));
    expect(m[mobileResponseKey].token_type).toBe(a.response.body.token_type);
    expect(m[mobileResponseKey].expires_in).toBe(a.response.body.expires_in);
    expect(Object.keys(m[mobileResponseKey].user).sort()).toEqual(Object.keys(a.response.body.user).sort());
  });

  it('refresh: a reused token is a 401 on both sides', () => {
    expect(mobileContract.refresh.reuse_status).toBe(apiContract.errors.invalid_refresh_token.status);
  });

  it('refresh: both sides agree on the reuse grace window', () => {
    expect(apiContract.errors.invalid_refresh_token.reuse_grace_seconds).toBe(10);
  });

  it('logout: path, method, body and 204 match the API; possession-based, no bearer header', () => {
    const a = api.logout;
    const m = mobileContract.logout;

    expect(m.path).toBe(a.path);
    expect(m.method).toBe(a.method);
    expect(shapeOf(m.request)).toEqual(shapeOf(a.request.body));
    expect(m.response_status).toBe(a.response.status);
    // An expired access token must not block sign-out: neither side may
    // require (or send) Authorization on native logout.
    expect(headerNames(a.request.headers)).not.toContain('authorization');
    expect(headerNames(m.headers)).toEqual([]);
    expect(apiContract.errors.unauthorized).toBeUndefined();
  });

  it('config: path, method and 200 body match the API (RCAB-E8.S15)', () => {
    const a = api.config;
    const m = mobileContract.config;

    expect(m.path).toBe(a.path);
    expect(m.method).toBe(a.method);
    expect(shapeOf(m.response_200)).toEqual(shapeOf(a.response.body));
  });

  it('google + phone-gate error codes carry the same status on both sides', () => {
    const codes = mobileContract.error_codes as Record<string, number>;
    for (const code of ['google_token_invalid', 'google_email_unverified', 'google_not_configured', 'auth_method_disabled']) {
      expect(codes[code], code).toBe(apiContract.errors[code].status);
    }
    expect(codes.account_disabled).toBe(apiContract.errors.account_disabled_on_exchange.status);
  });
});
