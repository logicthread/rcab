import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { DriverSim } from '../lib/driver-sim';
import { ensureClient, ensureDriver, releaseDriver, driverId, backdateArrival } from '../lib/fixtures';
import { DRIVER_HOME, DROPOFF, PICKUP, choosePrivate, openBook, pickRouteOnMap, waitForQuote } from '../lib/booking-ui';

test('W05 driver cancel and no-show', async ({ browser }) => {
  const rider = ensureClient(5, 'Farida (demo rider)');
  ensureDriver(5, 'Ghanshyam (demo driver)');
  const driver = new DriverSim(driverId(5), DRIVER_HOME);
  driver.offerPolicy = () => ({ action: 'accept', delayMs: 2000 });
  const scene = new Scene(
    {
      id: 'W05',
      slug: 'driver-cancel-no-show',
      title: 'Driver cancels, then reports a no-show',
      shows: 'Two rides back to back. Ride 1: the driver cancels while en route. Ride 2: the driver arrives, waits out the no-show window and reports the rider as a no-show.',
      chips: ['requested', 'accepted', 'en_route', 'arrived', 'cancelled', 'no_show'],
      transitions: 'Ride 1: requested -> accepted -> en_route -> cancelled (cancelled_by=driver, reason required). Ride 2: requested -> accepted -> en_route -> arrived -> no_show.',
      notes:
        'The no-show is only allowed 5 minutes after `arrived` (policy rides.noShowWaitMs). The harness back-dates rides.arrived_at by 6 minutes in the DEV database instead of recording a 5-minute wait (apps/web/e2e/demo/lib/fixtures.ts backdateArrival). Everything else goes through the real API. The simulated driver stands in for the Flutter app; the driver-app videos (D07) show the real driver UI for the same actions.',
    },
    browser,
  );
  const page = await scene.open('passenger', { person: rider });
  const book = async () => {
    await pickRouteOnMap(page, PICKUP, DROPOFF);
    await choosePrivate(page);
    await waitForQuote(page);
    await page.getByTestId('submit-private').click();
    await expect(page.getByTestId('tracking-status')).toBeVisible({ timeout: 15_000 });
  };
  try {
    await scene.intro(page, 3000);
    await driver.goOnline();
    await openBook(page);

    // ── ride 1: driver cancels ──
    await scene.step(page, 'Ride 1: rider books a private ride');
    await book();
    await scene.step(page, 'Ride 1: Finding your driver', 'requested');
    await expect(page.getByTestId('tracking-status')).toHaveText(/Driver assigned/, { timeout: 30_000 });
    await scene.step(page, 'Ride 1: driver accepted', 'accepted');
    const rideId1 = await driver.tripId();
    void driver.driveTo(PICKUP, 20);
    await expect(page.getByTestId('tracking-status')).toHaveText(/on the way/, { timeout: 20_000 });
    await scene.step(page, 'Ride 1: driver is on the way...', 'en_route');
    await page.waitForTimeout(4000);
    await driver.cancel(rideId1, 'Vehicle problem');
    await expect(page.getByTestId('tracking-status')).toHaveText(/Ride cancelled/, { timeout: 15_000 });
    await scene.step(page, 'Ride 1: driver cancelled (reason: vehicle problem). Rider can book again.', 'cancelled');
    await page.waitForTimeout(3500);
    await page.getByTestId('tracking-new-booking').click();
    await page.waitForTimeout(1200);

    // ── ride 2: no-show ──
    driver.lastAssignment = null;
    await scene.step(page, 'Ride 2: rider books again');
    await book();
    await scene.step(page, 'Ride 2: Finding your driver');
    // The driver's presence heartbeat is also its first location packet after accept, so "assigned" can flip to
    // "on the way" within a couple of seconds: accept either.
    await expect(page.getByTestId('tracking-status')).toHaveText(/Driver assigned|on the way/, { timeout: 30_000 });
    await scene.step(page, 'Ride 2: driver accepted', 'accepted');
    const rideId2 = await driver.tripId();
    await driver.driveTo(PICKUP, 12);
    await driver.transition(rideId2, 'mark_arrived');
    await expect(page.getByTestId('tracking-status')).toHaveText(/has arrived/, { timeout: 15_000 });
    await scene.step(page, 'Ride 2: driver has arrived; waiting for the rider (no-show unlocks after 5 min)', 'arrived');
    await page.waitForTimeout(4000);
    await scene.step(page, '[harness] arrived_at back-dated 6 min in the dev DB to skip the 5-minute wait');
    backdateArrival(rideId2, 6);
    await page.waitForTimeout(2000);
    await driver.markNoShow(rideId2);
    await expect(page.getByTestId('tracking-status')).toHaveText(/no-show/, { timeout: 15_000 });
    await scene.step(page, 'Ride 2: driver reported a no-show: ride ends as no_show', 'no_show');
    await page.waitForTimeout(4000);
    await scene.finish();
  } finally {
    await driver.goOffline();
    releaseDriver(5);
  }
});
