import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { DriverSim } from '../lib/driver-sim';
import { ensureClient, ensureDriver, releaseDriver, driverId } from '../lib/fixtures';
import { DRIVER_HOME, DROPOFF, PICKUP, openBook, pickRouteOnMap, waitForQuote } from '../lib/booking-ui';

const VIEW = { width: 640, height: 720 };

test('W07 shared ride with two passengers', async ({ browser }) => {
  const riderA = ensureClient(7, 'Ishaan (demo rider 1)');
  const riderB = ensureClient(8, 'Jaya (demo rider 2)');
  ensureDriver(7, 'Kiran (demo driver)');
  const driver = new DriverSim(driverId(7), DRIVER_HOME);
  driver.offerPolicy = () => ({ action: 'accept', delayMs: 3000 });
  const scene = new Scene(
    {
      id: 'W07',
      slug: 'shared-ride-two-passengers',
      title: 'Shared ride: two passengers, one cab',
      shows: 'Two riders on similar routes book a share; the second joins the first rider\'s pool, the pool closes when its 60 s window ends, a driver claims it and works the pickup/drop-off itinerary to completion. Left panel = rider 1, right panel = rider 2.',
      chips: ['open', 'closed_timeout', 'claimed', 'closed_started', 'completed'],
      transitions: 'Pool: open (seat 1) -> open (seat 2 joined; max_seats is 3) -> closed_timeout (60 s after opening) -> driver offer accepted (claimed) -> closed_started (first pickup confirmed) -> completed (last drop-off confirmed).',
      panels: ['rider-1', 'rider-2'],
      notes:
          'Side by side: two recorded browser contexts (640x720 each) composed with ffmpeg hstack, aligned to the moment the second context opened. The pool window (matching.poolTimeoutMs, 60 s) is real time, no env overrides. With the shipped matching.maxSeats = 3 two riders do not fill the pool, so it closes by timeout (closed_timeout); a third rider joining inside the window would close it as closed_full instead (state-machines.md, section 3). The rider UI shows pool status and seat count but no map tracking for shared rides (a product gap, listed in the web INDEX). The driver is the simulator (lib/driver-sim.ts) confirming stops over the real Socket.IO events.',
    },
    browser,
  );
  const p1 = await scene.open('rider-1', { person: riderA, viewport: VIEW });
  const p2 = await scene.open('rider-2', { person: riderB, viewport: VIEW });
  try {
    await Promise.all([scene.intro(p1, 3200), scene.intro(p2, 3200)]);
    await driver.goOnline();
    await Promise.all([openBook(p1), openBook(p2)]);

    await scene.step(p1, 'Rider 1 taps pickup and dropoff (Share is the default ride type)');
    await pickRouteOnMap(p1, PICKUP, DROPOFF);
    await waitForQuote(p1);
    await scene.step(p2, 'Rider 2 plans a nearly identical trip (150 m away at each end)');
    await pickRouteOnMap(
      p2,
      { lat: PICKUP.lat + 0.0012, lng: PICKUP.lng + 0.001 },
      { lat: DROPOFF.lat - 0.001, lng: DROPOFF.lng - 0.0012 },
    );
    await waitForQuote(p2);

    await scene.step(p1, 'Rider 1 books a share: opens a new pool (seat 1)');
    await p1.getByTestId('submit-shared').click();
    await expect(p1.getByTestId('pool-status')).toHaveAttribute('data-seat-count', '1', { timeout: 15_000 });
    await scene.step(p1, 'Pool open: waiting up to 60 s for a co-rider. Fare is fixed at join.', 'open');
    await scene.step(p2, 'Waiting for rider 1 to open the pool...');
    await p1.waitForTimeout(1500);

    await scene.step(p2, 'Rider 2 books a share: matched into rider 1\'s pool (route similarity + detour check)');
    await p2.getByTestId('submit-shared').click();
    await expect(p2.getByTestId('pool-status')).toHaveAttribute('data-seat-count', '2', { timeout: 15_000 });
    await expect(p1.getByTestId('pool-status')).toHaveAttribute('data-seat-count', '2', { timeout: 15_000 });
    await scene.step(p1, 'Seat 2 joined (pool:update push). 2 of 3 seats: the pool stays open until its 60 s window ends.');
    await scene.step(p2, 'Joined at seat 2. Fare was fixed when joining. Waiting for the pool window to end.');
    await expect(p1.getByTestId('pool-status')).toHaveAttribute('data-pool-status', 'closed_timeout', { timeout: 75_000 });
    await scene.step(p1, 'Window over: pool closes (closed_timeout) and goes to dispatch', 'closed_timeout');
    await scene.step(p2, 'Pool closed: now being offered to nearby drivers', 'closed_timeout');
    await p1.waitForTimeout(1500);

    const poolId = await driver.tripId(30_000);
    await scene.step(p1, 'Dispatch offered the whole pool to the nearby driver; driver accepts -> claimed', 'claimed');
    await scene.step(p2, 'Driver claimed the pool', 'claimed');
    const stops = (await driver.stopsOf(poolId)).sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    expect(stops.length).toBe(4);

    let first = true;
    for (const s of stops) {
      await driver.driveTo({ lat: s.lat, lng: s.lng }, 5);
      driver.confirmStop(poolId, s.sequenceIndex, s.type);
      const label = `stop ${s.sequenceIndex + 1}/4: ${s.type} confirmed`;
      if (first) {
        await expect(p1.getByTestId('pool-status')).toHaveAttribute('data-pool-status', 'closed_started', { timeout: 15_000 });
        await scene.step(p1, `${label}: trip under way -> closed_started`, 'closed_started');
        await scene.step(p2, `${label}: trip under way -> closed_started`, 'closed_started');
        first = false;
      } else {
        await scene.step(p1, label);
        await scene.step(p2, label);
      }
      await p1.waitForTimeout(1200);
    }
    await expect(p1.getByTestId('pool-status')).toHaveAttribute('data-pool-status', 'completed', { timeout: 15_000 });
    await scene.step(p1, 'Last drop-off confirmed: pool completed', 'completed');
    await scene.step(p2, 'Pool completed', 'completed');
    await p1.waitForTimeout(4000);
    await scene.finish();
  } finally {
    await driver.goOffline();
    releaseDriver(7);
  }
});
