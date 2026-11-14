import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { DriverSim } from '../lib/driver-sim';
import { ensureClient, ensureDriver, releaseDriver, driverId } from '../lib/fixtures';
import { DRIVER_HOME, DROPOFF, PICKUP, choosePrivate, openBook, pickRouteOnMap, waitForQuote } from '../lib/booking-ui';

test('W09 reload and reconnect restore tracking', async ({ browser }) => {
  const rider = ensureClient(9, 'Latha (demo rider)');
  ensureDriver(9, 'Mohan (demo driver)');
  const driver = new DriverSim(driverId(9), DRIVER_HOME);
  driver.offerPolicy = () => ({ action: 'accept', delayMs: 2500 });
  const scene = new Scene(
    {
      id: 'W09',
      slug: 'reload-reconnect',
      title: 'Reload and reconnect restore tracking',
      shows: 'Mid-ride the rider reloads the page, then loses the realtime connection while the driver arrives; both times the tracking view recovers the true state.',
      chips: ['accepted', 'en_route', 'reload restored', 'socket dropped', 'arrived (caught up)'],
      transitions: 'Reload: session from refresh cookie + ride from GET /v1/rides/:id + ride:snapshot. Drop: WebSocket blocked while the driver goes en_route -> arrived; on reconnect the ride:snapshot catches the UI up.',
      notes: 'The connection loss is simulated with Playwright page.routeWebSocket (closes every socket.io connection), then removed so socket.io-client reconnects by itself.',
    },
    browser,
  );
  const page = await scene.open('passenger', { person: rider });
  // Every socket.io WebSocket goes through this route: pass-through while `blocked` is false, closed immediately
  // while true (so socket.io-client's reconnect attempts keep failing until the scene lets them through).
  let blocked = false;
  const live: Array<{ close: () => void }> = [];
  await page.routeWebSocket(/socket\.io/, (ws) => {
    if (blocked) {
      void ws.close();
      return;
    }
    live.push(ws);
    ws.connectToServer();
  });
  try {
    await scene.intro(page, 3000);
    await driver.goOnline();
    await openBook(page);
    await pickRouteOnMap(page, PICKUP, DROPOFF);
    await choosePrivate(page);
    await waitForQuote(page);
    await page.getByTestId('submit-private').click();
    await expect(page.getByTestId('tracking-status')).toBeVisible({ timeout: 15_000 });
    await scene.step(page, 'Ride booked, finding a driver');
    await expect(page.getByTestId('tracking-status')).toHaveText(/Driver assigned|on the way/, { timeout: 30_000 });
    const rideId = await driver.tripId();
    const drive = driver.driveTo(PICKUP, 22);
    await expect(page.getByTestId('tracking-status')).toHaveText(/on the way/, { timeout: 20_000 });
    await scene.step(page, 'Driver is en route; the rider hits reload (F5)', 'en_route');
    await page.waitForTimeout(4000);

    await page.reload();
    await scene.step(page, 'Reloading: session restored via refresh cookie, active ride id read from localStorage...');
    await expect(page.getByTestId('tracking-status')).toHaveText(/on the way/, { timeout: 20_000 });
    await scene.step(page, '...ride re-fetched and re-subscribed: tracking view is back, driver dot still moving', 'reload restored');
    await page.waitForTimeout(5000);

    // Drop the realtime connection while the ride moves on.
    blocked = true;
    for (const ws of live.splice(0)) ws.close();
    await scene.step(page, 'Realtime connection dropped (WebSocket blocked). The page cannot hear the driver.', 'socket dropped');
    await drive; // the driver reaches the pickup while the page is deaf
    await page.waitForTimeout(1500);
    await driver.transition(rideId, 'mark_arrived');
    await scene.step(page, 'Meanwhile the driver arrives. The rider still sees the old state (no push can reach them).');
    await expect(page.getByTestId('tracking-status')).toHaveText(/on the way/);
    await page.waitForTimeout(5000);
    blocked = false;
    await scene.step(page, 'Connection allowed again: socket.io reconnects and re-subscribes...');
    await expect(page.getByTestId('tracking-status')).toHaveText(/has arrived/, { timeout: 40_000 });
    await scene.step(page, '...the ride:snapshot catches the UI up to the true state: arrived', 'arrived (caught up)');
    await page.waitForTimeout(4000);
    await scene.finish();
  } finally {
    await driver.goOffline();
    releaseDriver(9);
  }
});
