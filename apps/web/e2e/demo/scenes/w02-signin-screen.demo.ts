import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { stubGoogleSignIn } from '../lib/google-stub';

// UI only: no real Google login. Google Identity Services and the API's answers are simulated in the
// recording browser (lib/google-stub.ts); the page code under test is the shipped code.
test('W02 sign-in screen', async ({ browser }) => {
  const scene = new Scene(
    {
      id: 'W02',
      slug: 'signin-screen',
      title: 'Sign-in screen (Continue with Google)',
      shows:
        'The Google-only sign-in screen: the page reads the enabled methods from the API, shows a single "Continue with Google" button (no phone field), and explains what went wrong when sign-in is refused. No real Google login.',
      chips: ['google only', 'email unverified', 'account disabled'],
      transitions:
        'No ride states. Sign-in is Google ID token -> POST /v1/auth/google -> access token + refresh cookie (refused here by simulated answers, so no session is created). Phone OTP is switched off by policy auth.enabledMethods.',
      notes:
        'UI only by design. The recording browser replaces three things (lib/google-stub.ts): GET /v1/auth/config (the dev API has no Google client id yet, so it would show "not set up"), the Google Identity Services script (the button you see is a look-alike drawn by the stub; the real one is Google\'s own iframe) and POST /v1/auth/google (always an error; no session is minted). Everything else is the shipped page. The flows behind sign-in (W03-W10) start from a harness-created session instead (README, "Sessions").',
    },
    browser,
  );
  const page = await scene.open('visitor');
  const stub = await stubGoogleSignIn(page);
  await scene.intro(page, 2800);
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.locator('#phone')).toHaveCount(0);
  await scene.step(page, 'The page asks the API which sign-in methods are on (GET /v1/auth/config): Google only, so there is no phone field', 'google only');
  await page.waitForTimeout(6000);

  stub.setExchangeError('google_email_unverified', 403);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('not verified');
  await scene.step(page, 'Simulated: Google returns an ID token with an unverified email; the API answers google_email_unverified (403) and the page says what to do', 'email unverified');
  await page.waitForTimeout(6500);

  stub.setExchangeError('account_disabled', 403);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('disabled');
  await scene.step(page, 'Simulated: a suspended account is refused with account_disabled (403); still no session', 'account disabled');
  await page.waitForTimeout(6500);
  await scene.finish();
});
