import { describe, it, expect, beforeAll } from 'vitest';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// Coordinates within the default fixture PBF region (India north-eastern zone).
// Two points in Guwahati, Assam.
const ORIGIN = '91.7362,26.1445';
const DEST = '91.7502,26.1558';

describe.skipIf(skip)('osrm connectivity', () => {
  const osrmUrl = process.env.OSRM_URL ?? process.env.TEST_OSRM_URL ?? 'http://localhost:5001';
  let reachable = false;

  beforeAll(async () => {
    try {
      const res = await fetch(`${osrmUrl}/route/v1/driving/${ORIGIN};${DEST}?overview=false`, {
        signal: AbortSignal.timeout(5_000),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
  });

  it('OSRM returns a valid route or is gracefully skipped when not running', async () => {
    if (!reachable) {
      console.warn(`[osrm-connectivity] OSRM unreachable at ${osrmUrl} — skipping route assertion.`);
      // Not a hard failure: OSRM is opt-in via docker-compose.test.yml --profile osrm
      return;
    }

    const res = await fetch(`${osrmUrl}/route/v1/driving/${ORIGIN};${DEST}?overview=false`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; routes: unknown[] };
    expect(body.code).toBe('Ok');
    expect(body.routes.length).toBeGreaterThan(0);
  });
});
