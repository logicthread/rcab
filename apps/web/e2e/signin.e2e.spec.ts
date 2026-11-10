import { test, expect } from '@playwright/test';

// First real e2e. Deliberately targets the bug classes that shipped to Demo 1 and
// were only caught by manual testing (RCAB-E1.S13), re-aimed at Google-only
// sign-in (RCAB-E8.S15):
//   1. render: the sign-in page mounts and shows exactly the methods the API enables,
//   2. no page errors on mount (the old reCAPTCHA StrictMode crash class),
//   3. CORS: a browser-origin (:3002) credentialed POST to the API (:3000) is not
//      blocked, and the API answers an invalid token with its own error.
//
// Requires the dev stack up (`pnpm dev:up`). No real Google round-trip: that needs
// an OAuth client and an interactive account pick, so it is a manual/staging check.

const API_BASE = process.env.E2E_API_URL ?? 'http://localhost:3000';

test('sign-in renders the enabled methods and the API is reachable cross-origin (CORS)', async ({
  page,
  request,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const config = (await (await request.get(`${API_BASE}/v1/auth/config`)).json()) as {
    methods: string[];
    google: { clientId: string | null };
  };

  await page.goto('/signin');

  // 1. render: driven by the API's config, not hard-coded
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  if (config.methods.includes('google')) {
    const google = page.getByRole('region', { name: 'Google sign-in' });
    await expect(google).toBeVisible();
    // With a client id the Google button container is mounted; without one the page says so.
    if (config.google.clientId) {
      await expect(page.getByTestId('google-signin-button')).toBeAttached();
    } else {
      await expect(google.getByRole('alert')).toContainText(/not set up/i);
    }
  }
  if (config.methods.includes('phone')) {
    await expect(page.locator('#phone')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send OTP' })).toBeVisible();
  } else {
    await expect(page.locator('#phone')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send OTP' })).toHaveCount(0);
  }

  // 2. nothing crashed while mounting
  const crashes = pageErrors.filter((m) => /Cannot read properties of null|grecaptcha/i.test(m));
  expect(crashes, `unexpected page errors: ${pageErrors.join(' | ')}`).toEqual([]);

  // 3. CORS: a preflighted POST from the page origin must not be blocked. An invalid
  //    token must come back from the API itself: reaching the handler proves CORS
  //    passed (a CORS failure rejects the fetch with a TypeError), and pinning the
  //    status/code catches a proxy / 5xx masquerading as "reachable".
  const cors = await page.evaluate(async (apiBase) => {
    try {
      const r = await fetch(`${apiBase}/v1/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id_token: 'e2e-invalid' }),
      });
      const body = (await r.json()) as { error?: { code?: string } };
      return { reached: true, status: r.status, code: body.error?.code ?? null };
    } catch {
      return { reached: false, status: 0, code: null };
    }
  }, API_BASE);

  expect(cors.reached, 'cross-origin API call was blocked (CORS regression)').toBe(true);
  // Dev without a Google client id answers 503 google_not_configured; with one, 401 google_token_invalid.
  expect([
    { status: 401, code: 'google_token_invalid' },
    { status: 503, code: 'google_not_configured' },
  ]).toContainEqual({ status: cors.status, code: cors.code });
});

test('phone firebase-exchange is refused while phone sign-in is disabled', async ({ request }) => {
  const config = (await (await request.get(`${API_BASE}/v1/auth/config`)).json()) as {
    methods: string[];
  };
  test.skip(config.methods.includes('phone'), 'phone sign-in is enabled on this stack');

  const res = await request.post(`${API_BASE}/v1/auth/firebase-exchange`, {
    data: { id_token: 'e2e-invalid' },
  });
  expect(res.status()).toBe(403);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('auth_method_disabled');
});
