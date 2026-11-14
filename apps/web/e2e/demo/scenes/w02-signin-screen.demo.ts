import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';

// UI only: real sign-in needs a Firebase phone OTP (SMS), which a recording must not trigger.
test('W02 sign-in screen', async ({ browser }) => {
  const scene = new Scene(
    {
      id: 'W02',
      slug: 'signin-screen',
      title: 'Sign-in screen (phone OTP UI)',
      shows: 'The phone-number step of sign-in, client-side validation, and the form layout. No OTP is sent.',
      chips: ['phone step', 'otp step (not recorded)'],
      transitions: 'No ride states. Sign-in is Firebase phone OTP -> POST /v1/auth/firebase-exchange -> access token + refresh cookie (not exercised here).',
      notes:
        'UI only by design: the OTP step needs a real SMS. The flows that sit behind sign-in (W03-W10) start from a harness-created session instead (README, "Sessions").',
    },
    browser,
  );
  const page = await scene.open('visitor');
  await scene.intro(page, 2800);
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await scene.step(page, 'Step 1: phone number in E.164 format; reCAPTCHA is invisible and created lazily on submit', 'phone step');
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Send OTP' }).click(); // empty -> native required validation
  await scene.step(page, 'Submitting an empty form is blocked by the browser (required field)');
  await page.waitForTimeout(2500);
  await page.locator('#phone').click();
  await page.locator('#phone').pressSequentially('+91 98765 43210', { delay: 120 });
  await scene.step(page, 'Rider types a phone number. (Send OTP would now call Firebase; not pressed in this recording.)');
  await page.waitForTimeout(8500);
  await scene.finish();
});
