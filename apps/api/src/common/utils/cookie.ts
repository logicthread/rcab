import type { CookieOptions } from 'express';
import { getPolicy } from '../../config/policy/policy';

export const REFRESH_COOKIE_NAME = 'refresh_token';

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    // Same lifetime as the DB row: policy sessions.refreshTokenTtlMs (30 days).
    maxAge: getPolicy().sessions.refreshTokenTtlMs,
  };
}

export function clearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    maxAge: 0,
  };
}
