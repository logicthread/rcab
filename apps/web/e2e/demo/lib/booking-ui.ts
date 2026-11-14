import { expect, type Page } from '@playwright/test';
import { clickLatLng } from './map';
import type { Pos } from './driver-sim';
import { AREA_A } from './fixtures';

/** The demo trip, all inside AREA A (~1.6 km, routable in the dev OSRM extract). */
export const PICKUP: Pos = { lat: 26.1465, lng: 91.738 };
export const DROPOFF: Pos = { lat: 26.1565, lng: 91.7505 };
/** Where the simulated driver starts: ~450 m from the pickup, well inside dispatch R1 (2 km). */
export const DRIVER_HOME: Pos = { lat: 26.1495, lng: 91.7415 };

export async function openBook(page: Page): Promise<void> {
  await page.goto('/book');
  await expect(page.getByRole('heading', { name: 'Book a ride' })).toBeVisible({ timeout: 20_000 });
}

/** Tap the map twice (pickup, then dropoff) exactly like a rider would. */
export async function pickRouteOnMap(page: Page, pickup: Pos = PICKUP, dropoff: Pos = DROPOFF): Promise<void> {
  await page.locator('.leaflet-container').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200); // tiles + initial view
  await clickLatLng(page, pickup, AREA_A, 13);
  await page.waitForTimeout(1500); // setView(pickup, 14) animation
  await clickLatLng(page, dropoff, pickup, 14);
  await page.waitForTimeout(1200);
}

export async function waitForQuote(page: Page): Promise<void> {
  await expect(page.getByTestId('quote-panel')).toContainText('₹', { timeout: 30_000 });
}

export async function choosePrivate(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Private' }).click();
}

export async function chooseShare(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Share' }).click();
}

export async function trackingStatus(page: Page): Promise<string> {
  return (await page.getByTestId('tracking-status').textContent()) ?? '';
}

/** Scroll an element to the middle of the viewport so it is not hidden behind the caption bar. */
export async function centerOn(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await page.waitForTimeout(700);
}
