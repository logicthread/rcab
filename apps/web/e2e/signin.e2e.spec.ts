import { test, expect } from '@playwright/test';

// First real e2e. Deliberately targets the three bug classes that shipped to
// Demo 1 and were only caught by manual testing (RCAB-E1.S13):
//   1. render — the sign-in page mounts,
//   2. reCAPTCHA StrictMode — no `Cannot read properties of null` pageerror,
//   3. CORS — a browser-origin (:3002) request to the API (:3000) is not blocked.
//
// Requires the dev stack up (`pnpm dev:up`). No Firebase OTP round-trip — that
// needs test-phone provisioning and is a later e2e.

const API_BASE = process.env.E2E_API_URL ?? 'http://localhost:3000';

test('sign-in renders cleanly and the API is reachable cross-origin (CORS)', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/signin');

  // 1. render
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('#phone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send OTP' })).toBeVisible();

  // 2. reCAPTCHA StrictMode crash would surface as a pageerror on mount.
  const recaptchaCrash = pageErrors.filter((m) =>
    /Cannot read properties of null|grecaptcha/i.test(m),
  );
  expect(recaptchaCrash, `unexpected page errors: ${pageErrors.join(' | ')}`).toEqual([]);

  // 3. CORS: a preflighted POST from the page origin must not be blocked. A bad
  //    token yields 400/401 — any HTTP status means CORS passed; a CORS failure
  //    rejects the fetch (TypeError) instead.
  const cors = await page.evaluate(async (apiBase) => {
    try {
      const r = await fetch(`${apiBase}/v1/auth/firebase-exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id_token: 'e2e-invalid' }),
      });
      return { reached: true, status: r.status };
    } catch {
      return { reached: false, status: 0 };
    }
  }, API_BASE);

  expect(cors.reached, 'cross-origin API call was blocked (CORS regression)').toBe(true);
  expect(cors.status).toBeGreaterThan(0);
});
