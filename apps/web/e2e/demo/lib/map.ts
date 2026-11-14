import type { Page } from '@playwright/test';
import type { Pos } from './driver-sim';

/**
 * Click a lat/lng on the Leaflet map (Web-Mercator maths). The map is the first `.leaflet-container`; `center`
 * and `zoom` are the map's CURRENT view (the booking page uses zoom 13 centred on Guwahati until a point is
 * set, then setView(point, 14)).
 */
export async function clickLatLng(page: Page, target: Pos, center: Pos, zoom: number): Promise<void> {
  const box = await page.locator('.leaflet-container').first().boundingBox();
  if (!box) throw new Error('map not visible');
  const scale = 256 * 2 ** zoom;
  const px = (lng: number) => ((lng + 180) / 360) * scale;
  const py = (lat: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  };
  const dx = px(target.lng) - px(center.lng);
  const dy = py(target.lat) - py(center.lat);
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  if (x < box.x + 4 || x > box.x + box.width - 4 || y < box.y + 4 || y > box.y + box.height - 4) {
    throw new Error(`target ${target.lat},${target.lng} falls outside the visible map (${dx.toFixed(0)},${dy.toFixed(0)} px)`);
  }
  await page.mouse.move(x, y, { steps: 8 });
  await page.waitForTimeout(250);
  await page.mouse.click(x, y);
}
