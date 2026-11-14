#!/usr/bin/env node
/**
 * Prepare one driver-app demo scene (RCAB-E8.S14) — TEST-HARNESS ONLY.
 *
 *   node session.mjs --scene D04      # prints DEMO_JWT=… / DEMO_REFRESH=… lines
 *
 * Upserts the Area-B fixture users, returns every demo user to a clean offline state, and mints an
 * ordinary session for the scene's driver (see fixtures.mjs for the guards and why this is not a
 * backdoor). D01 (sign-in screen) gets no session; D02 uses the "new" driver with no vehicle.
 */
import { IDS, mintSession, resetScene, upsertFixtures, die } from './fixtures.mjs';

const i = process.argv.indexOf('--scene');
const scene = i === -1 ? die('--scene required') : process.argv[i + 1];

upsertFixtures();
resetScene({ newDriverVehicles: scene === 'D02' });

if (scene === 'D01') {
  console.log('DEMO_JWT=');
  console.log('DEMO_REFRESH=');
} else {
  const s = mintSession(scene === 'D02' ? IDS.newDriver : IDS.driver, 'driver', 1800);
  console.log(`DEMO_JWT=${s.jwt}`);
  console.log(`DEMO_REFRESH=${s.refresh}`);
}
