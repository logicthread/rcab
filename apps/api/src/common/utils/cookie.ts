import type { CookieOptions } from 'express';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const REFRESH_COOKIE_NAME = 'refresh_token';

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    maxAge: THIRTY_DAYS_MS,
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
