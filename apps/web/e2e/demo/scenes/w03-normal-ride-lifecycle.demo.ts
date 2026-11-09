import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { DriverSim } from '../lib/driver-sim';
import { ensureClient, ensureDriver, releaseDriver, driverId } from '../lib/fixtures';
import { DRIVER_HOME, DROPOFF, PICKUP, choosePrivate, openBook, pickRouteOnMap, waitForQuote } from '../lib/booking-ui';

const CHIPS = ['requested', 'dispatching', 'accepted', 'en_route', 'arrived', 'in_progress', 'completed', 'rated'];

test('W03 normal ride full lifecycle', async ({ browser }) => {
  const rider = ensureClient(3, 'Asha (demo rider)');
  ensureDriver(3, 'Bimal (demo driver)');
  const driver = new DriverSim(driverId(3), DRIVER_HOME);
  const scene = new Scene(
    {
      id: 'W03',
      slug: 'normal-ride-lifecycle',
      title: 'Normal ride: quote to rating',
      shows: 'Passenger quotes and books a private ride; a driver accepts and drives it to completion; passenger rates the driver.',
      chips: CHIPS,
      transitions: 'requested -> dispatching -> accepted -> en_route -> arrived -> in_progress -> completed, then rating',
    },
    browser,
  );
  const page = await scene.open('passenger', { person: rider });
  try {
    await scene.intro(page);
    await driver.goOnline();
    await openBook(page);
    await scene.step(page, 'Rider taps pickup and dropoff on the map; a driver is online nearby', undefined);
    await pickRouteOnMap(page, PICKUP, DROPOFF);
    await choosePrivate(page);
    await waitForQuote(page);
    await scene.step(page, 'Fare quote (signed quote token locks fare + route); rider taps Book');
    await page.getByTestId('quote-panel').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1800);

    // Driver answers the first offer after a think time.
    driver.offerPolicy = () => ({ action: 'accept', delayMs: 4000 });
    await page.getByTestId('submit-private').click();
    await expect(page.getByTestId('tracking-status')).toBeVisible({ timeout: 15_000 });
    await scene.step(page, 'Ride created: Finding your driver (dispatch wave 1 offers the nearest driver)', 'requested');

    await expect(page.getByTestId('tracking-status')).toHaveText(/Driver assigned/, { timeout: 30_000 });
    await scene.step(page, 'Driver accepted the offer', 'dispatching');
    await scene.step(page, 'accepted: Driver assigned', 'accepted');
    await page.waitForTimeout(1500);

    // First location packet after accept => implicit start_en_route; then the drive to pickup.
    const toPickup = driver.driveTo(PICKUP, 12);
    await expect(page.getByTestId('tracking-status')).toHaveText(/on the way/, { timeout: 20_000 });
    await scene.step(page, 'en_route: driver heads to pickup; live position on the map', 'en_route');
    await toPickup;
    const rideId = await driver.tripId();
    await driver.transition(rideId, 'mark_arrived');
    await expect(page.getByTestId('tracking-status')).toHaveText(/has arrived/, { timeout: 15_000 });
    await scene.step(page, 'arrived: driver is at the pickup point', 'arrived');
    await page.waitForTimeout(3000);

    await driver.transition(rideId, 'start_ride');
    await expect(page.getByTestId('tracking-status')).toHaveText(/destination/, { timeout: 15_000 });
    await scene.step(page, 'in_progress: trip started (rider can no longer cancel)', 'in_progress');
    await driver.driveTo(DROPOFF, 14);

    await driver.transition(rideId, 'end_ride');
    await expect(page.getByTestId('tracking-status')).toHaveText(/Trip complete/, { timeout: 15_000 });
    await scene.step(page, 'completed: trip complete, rating prompt opens', 'completed');
    await page.waitForTimeout(2000);

    await page.getByTestId('rating-star-5').click();
    await page.getByTestId('rating-text').fill('Smooth ride, thanks!');
    await page.getByTestId('rating-submit').click();
    await expect(page.getByTestId('rating-done')).toBeVisible();
    await scene.step(page, 'Rider rates the driver 5 stars (POST /v1/rides/:id/ratings)', 'rated');
    await page.waitForTimeout(2500);
    await scene.finish({ driverLog: driver.log.length });
  } finally {
    await driver.goOffline();
    releaseDriver(3);
  }
});

