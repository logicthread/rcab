import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { ensureClient } from '../lib/fixtures';
import { DROPOFF, PICKUP, choosePrivate, openBook, pickRouteOnMap, waitForQuote } from '../lib/booking-ui';

test('W06 no driver available', async ({ browser }) => {
  const rider = ensureClient(6, 'Hari (demo rider)');
  const scene = new Scene(
    {
      id: 'W06',
      slug: 'no-driver',
      title: 'No driver available',
      shows: 'Rider books while no driver is online nearby; dispatch widens wave 1 to wave 2, then hard-fails after 60 s.',
      chips: ['requested', 'dispatching', 'no_driver'],
      transitions: 'requested -> dispatching (wave 1: 2 km, wave 2 at +30 s: 4 km) -> no_driver at +60 s (dispatch.waveOneTimeoutMs / hardFailMs).',
      notes: 'Recorded at the shipped default windows (no env overrides, api not restarted): the 60 s wait is real time.',
    },
    browser,
  );
  const page = await scene.open('passenger', { person: rider });
  await scene.intro(page, 2800);
  await openBook(page);
  await scene.step(page, 'No driver is online anywhere near this pickup');
  await pickRouteOnMap(page, PICKUP, DROPOFF);
  await choosePrivate(page);
  await waitForQuote(page);
  await page.getByTestId('submit-private').click();
  await expect(page.getByTestId('tracking-status')).toBeVisible({ timeout: 15_000 });
  const t0 = Date.now();
  await scene.step(page, 't+0 s: ride created, wave 1 offers nobody (nobody within 2 km)', 'requested');
  await page.waitForTimeout(29_000);
  await scene.step(page, 't+30 s: wave 2 widens the search to 4 km (still nobody)', 'dispatching');
  await expect(page.getByTestId('tracking-status')).toHaveText(/No driver available/, { timeout: 60_000 });
  await scene.step(page, `t+${Math.round((Date.now() - t0) / 1000)} s: hard fail, ride ends as no_driver; rider can try again`, 'no_driver');
  await page.waitForTimeout(5000);
  await scene.finish();
});
