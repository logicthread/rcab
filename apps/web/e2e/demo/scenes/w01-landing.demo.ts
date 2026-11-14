import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { stubGoogleSignIn } from '../lib/google-stub';

test('W01 landing page', async ({ browser }) => {
  const scene = new Scene(
    {
      id: 'W01',
      slug: 'landing',
      title: 'Landing page and route guard',
      shows: 'The public landing page, its two entry points, and the booking page bouncing an anonymous visitor to sign-in.',
      chips: ['/', '/book (anonymous)', '/signin'],
      transitions: 'No ride states. Anonymous visitor: / -> /book -> redirected to /signin (withAuth route guard).',
      notes: 'The /signin screen at the end shows the Google button through the recording-only stub in lib/google-stub.ts (no Google client id is configured on the dev API); the redirect itself is the shipped route guard.',
    },
    browser,
  );
  const page = await scene.open('visitor');
  await stubGoogleSignIn(page); // the /signin screen it ends on shows the Google button (see lib/google-stub.ts)
  await scene.intro(page, 2800);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'rcab' })).toBeVisible();
  await scene.step(page, 'Landing page: product name, tagline, Book a ride / Sign in', '/');
  await page.waitForTimeout(3500);
  await page.getByRole('link', { name: 'Book a ride' }).hover();
  await page.waitForTimeout(1200);
  await scene.step(page, 'Book a ride while signed out: the page tries a silent refresh, finds no session...', '/book (anonymous)');
  await page.getByRole('link', { name: 'Book a ride' }).click();
  await page.waitForURL('**/signin', { timeout: 15_000 });
  await scene.step(page, '...and the route guard sends the visitor to /signin', '/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.waitForTimeout(9000);
  await scene.finish();
});
