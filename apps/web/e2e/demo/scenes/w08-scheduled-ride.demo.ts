import { test, expect } from '@playwright/test';
import { Scene } from '../lib/scene';
import { ensureClient } from '../lib/fixtures';
import { promoteScheduledWake, psql } from '../lib/devstack';
import { DROPOFF, PICKUP, centerOn, choosePrivate, openBook, pickRouteOnMap, waitForQuote } from '../lib/booking-ui';

test('W08 scheduled ride', async ({ browser }) => {
  const rider = ensureClient(10, 'Neha (demo rider)');
  const scene = new Scene(
    {
      id: 'W08',
      slug: 'scheduled-ride',
      title: 'Schedule a ride for later, then cancel',
      shows: 'Rider switches Private to "Later", picks a pickup time, books; the ride waits as "Scheduled"; when the wake fires the server starts searching ("Finding your driver"); the rider reopens the page and sees the searching state; the rider cancels.',
      chips: ['requested (scheduled)', 'wake: searching', 'cancelled'],
      transitions: 'requested (type=scheduled, wake job delayed to T-10 min) -> [wake job runs] dispatch starts, still requested -> cancelled (cancelled_by=client, wake job removed).',
      notes:
        'The wake job normally fires scheduled.wakeLeadMs (10 min) before pickup, and the earliest bookable pickup is 15 min out, so a real wake is >= 5 min after booking. The harness promotes the delayed BullMQ job (lib/devstack.ts promoteScheduledWake) so the real wake worker runs immediately. No driver is online in this area, so the search has no taker; the "Still looking ... until <time>" copy comes from the ride:snapshot (retryUntil = pickup + scheduled.retryCutoffAfterPickupMs); the live ride_dispatch_retry push (first re-arm) arrives only after the 4-minute scheduled accept window (scheduled.dispatchWindowMs) and is not part of this recording.',
    },
    browser,
  );
  const page = await scene.open('passenger', { person: rider });
  await scene.intro(page, 3000);
  await openBook(page);
  await scene.step(page, 'Rider taps pickup and dropoff, chooses Private');
  await pickRouteOnMap(page, PICKUP, DROPOFF);
  await choosePrivate(page);
  await waitForQuote(page);
  await scene.step(page, 'Pickup time: Now is the default. The rider taps "Later"');
  await centerOn(page, 'schedule-picker');
  await page.waitForTimeout(1200);
  await page.getByTestId('schedule-later').click();
  await page.waitForTimeout(1200);
  // 2 hours out, rounded to the minute, entered the way a rider would (local wall-clock time).
  const at = new Date(Date.now() + 2 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  await page.getByTestId('schedule-input').fill(local);
  await scene.step(page, 'Picks a pickup time 2 h from now (allowed window: 15 min to 24 h). Button now says "Schedule ride"');
  await page.waitForTimeout(2200);
  await expect(page.getByTestId('schedule-error')).toHaveCount(0);
  await centerOn(page, 'submit-private');
  await page.waitForTimeout(1200);

  await page.getByTestId('submit-private').click();
  await expect(page.getByTestId('tracking-status')).toHaveText(/^Scheduled for /, { timeout: 15_000 });
  await scene.step(page, 'Booked: type=scheduled. The ride waits as requested; nothing is dispatched yet', 'requested (scheduled)');
  await page.getByTestId('tracking-panel').scrollIntoViewIfNeeded();
  await page.waitForTimeout(4500);

  const rideId = psql(`SELECT id FROM rides WHERE passenger_id = '${rider.id}' ORDER BY created_at DESC LIMIT 1;`).trim();
  await scene.step(page, '[harness] time travel: promote the delayed wake job so the real T-10 min wake runs now');
  const promoted = await promoteScheduledWake(rideId);
  expect(promoted).toBe(true);
  // Wake => dispatch_generation >= 1. The status stays `requested` and no event is pushed on the first wake, so the
  // open page keeps saying "Scheduled" until it re-subscribes: a reload (or reconnect) delivers a ride:snapshot whose
  // retryUntil marks the search as running.
  await expect.poll(() => psql(`SELECT dispatch_generation FROM rides WHERE id = '${rideId}';`).trim(), { timeout: 20_000 }).not.toBe('0');
  await page.waitForTimeout(1500);
  await scene.step(page, 'Wake ran: dispatch started, nobody nearby. The rider reopens the page...');
  await page.reload();
  await expect(page.getByTestId('tracking-status')).toHaveText(/Still looking for a driver/, { timeout: 20_000 });
  await scene.step(page, '...the ride:snapshot says the search is on: "Still looking for a driver, we will keep trying until <time>"', 'wake: searching');
  await page.waitForTimeout(4000);

  await page.getByTestId('tracking-cancel').click();
  await expect(page.getByTestId('tracking-status')).toHaveText(/Ride cancelled/, { timeout: 15_000 });
  await scene.step(page, 'Rider cancels: cancelled_by=client, the pending job is removed', 'cancelled');
  await page.waitForTimeout(4000);
  await scene.finish();
});
