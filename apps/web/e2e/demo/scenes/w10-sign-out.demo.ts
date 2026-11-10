import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { ensureClient } from '../lib/fixtures';
import { openBook } from '../lib/booking-ui';
import { stubGoogleSignIn } from '../lib/google-stub';

test('W10 sign out', async ({ browser }) => {
  const rider = ensureClient(10, 'Meera (demo rider)');
  const scene = new Scene(
    {
      id: 'W10',
      slug: 'sign-out',
      title: 'Sign out revokes the session',
      shows: 'A signed-in rider signs out; the app returns to /signin and a reload of /book can no longer silently log back in.',
      chips: ['signed in', 'signed out', 'refresh revoked'],
      transitions: 'No ride states. POST /v1/auth/logout revokes the refresh token and clears the cookie; /book then redirects to /signin.',
      notes: 'The /signin screen it lands on shows the Google button through the recording-only stub in lib/google-stub.ts (no Google client id is configured on the dev API). Sign-out, the revocation and the redirect are the shipped code against the real dev API.',
    },
    browser,
  );
  const page = await scene.open('rider', { person: rider });
  await stubGoogleSignIn(page); // only the /signin screen it lands on; the session itself is real (see lib/google-stub.ts)
  await scene.intro(page, 2600);
  await openBook(page);
  await scene.step(page, 'Signed in (session restored from the refresh cookie)', 'signed in');
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/signin', { timeout: 15_000 });
  await scene.step(page, 'Sign out: local state dropped at once, refresh token revoked server-side, redirect to /signin', 'signed out');
  await page.waitForTimeout(3500);
  await page.goto('/book');
  await page.waitForURL('**/signin', { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await scene.step(page, 'Opening /book again: no silent re-login, straight back to /signin', 'refresh revoked');
  await page.waitForTimeout(7000);
  await scene.finish();
});
