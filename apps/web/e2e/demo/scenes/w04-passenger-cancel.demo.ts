import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { DriverSim } from '../lib/driver-sim';
import { ensureClient, ensureDriver, releaseDriver, driverId } from '../lib/fixtures';
import { DRIVER_HOME, DROPOFF, PICKUP, choosePrivate, openBook, pickRouteOnMap, waitForQuote } from '../lib/booking-ui';

test('W04 passenger cancels before pickup', async ({ browser }) => {
  const rider = ensureClient(4, 'Dev (demo rider)');
  ensureDriver(4, 'Chandan (demo driver)');
  const driver = new DriverSim(driverId(4), DRIVER_HOME);
  driver.offerPolicy = () => ({ action: 'accept', delayMs: 3000 });
  const scene = new Scene(
    {
      id: 'W04',
      slug: 'passenger-cancel',
      title: 'Passenger cancels before pickup',
      shows: 'Rider books, a driver accepts and starts driving, then the rider cancels from the tracking panel.',
      chips: ['requested', 'dispatching', 'accepted', 'en_route', 'cancelled'],
      transitions: 'requested -> dispatching -> accepted -> en_route -> cancelled (cancelled_by=client). No fee in Phase-0.',
      notes: 'The Cancel button is only offered before in_progress; the API rejects a client cancel once the trip started (rides.clientCancellableFrom in docs/POLICY.md).',
    },
    browser,
  );
  const page = await scene.open('passenger', { person: rider });
  try {
    await scene.intro(page, 2800);
    await driver.goOnline();
    await openBook(page);
    await pickRouteOnMap(page, PICKUP, DROPOFF);
    await choosePrivate(page);
    await waitForQuote(page);
    await scene.step(page, 'Rider has a quote and books');
    await page.getByTestId('submit-private').click();
    await expect(page.getByTestId('tracking-status')).toBeVisible({ timeout: 15_000 });
    await scene.step(page, 'Finding your driver', 'requested');
    await expect(page.getByTestId('tracking-status')).toHaveText(/Driver assigned/, { timeout: 30_000 });
    await scene.step(page, 'Driver accepted', 'accepted');
    void driver.driveTo(PICKUP, 25);
    await expect(page.getByTestId('tracking-status')).toHaveText(/on the way/, { timeout: 20_000 });
    await scene.step(page, 'Driver is on the way; rider changes their mind', 'en_route');
    await page.waitForTimeout(4000);
    await page.getByTestId('tracking-cancel').click();
    await expect(page.getByTestId('tracking-status')).toHaveText(/Ride cancelled/, { timeout: 15_000 });
    await scene.step(page, 'Rider cancelled: ride is terminal, driver is released', 'cancelled');
    await page.waitForTimeout(3500);
    await page.getByTestId('tracking-new-booking').click();
    await scene.step(page, 'New booking resets the form');
    await page.waitForTimeout(2500);
    await scene.finish();
  } finally {
    await driver.goOffline();
    releaseDriver(4);
  }
});
