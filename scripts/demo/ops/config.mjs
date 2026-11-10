// Shared configuration for the ops/monitoring video harness (scenes M01-M06).
// Everything here is DEV-ONLY: loopback URLs and the dev compose defaults. Nothing is read from prod.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..', '..');
export const OUT_DIR = join(ROOT, 'docs', 'onboarding', 'videos', 'ops');
export const WORK_DIR = process.env.DEMO_WORK_DIR || join(process.env.TMPDIR || '/tmp', 'rcab-demo-ops');

export const URLS = {
  api: 'http://localhost:3000',
  grafana: 'http://localhost:3001', // admin/admin: GF_SECURITY_ADMIN_* in docker-compose.dev.yml
  prometheus: 'http://localhost:9090',
};
export const GRAFANA = { user: 'admin', pass: 'admin' };

/**
 * Where the simulated k6 drivers/riders live. Guwahati "Area C": more than dispatch.r2Meters (docs/POLICY.md,
 * 4000 m) from Area A (the web/driver demo fixtures) and Area B, so the load can never offer a rider's real
 * demo ride to a fixture driver, nor vice versa. record.mjs re-checks the distance on every run.
 */
export const AREAS = {
  A: { lat: 26.1445, lng: 91.7362 },
  B: { lat: 26.18, lng: 91.79 },
  C: { lat: 26.115, lng: 91.7 },
};

export const COMPOSE = [
  'compose', '-p', 'rcab-dev', '--env-file', join(ROOT, '.env.dev'),
  '-f', join(ROOT, 'infra/docker/docker-compose.dev.yml'), '--profile', 'obs',
];
export const DEV_NETWORK = 'rcab-dev_rcab_dev_net';

/** Throwaway Uptime Kuma used by M04. The long-lived dev one on :3003 was set up earlier with unknown creds. */
export const KUMA = { port: 3013, container: 'rcab-demo-kuma', user: 'admin', pass: 'admin1234!' };
/** Throwaway TCP forward to Alertmanager (which publishes no host port) used by M05. */
export const AM = { port: 19093, container: 'rcab-demo-am-forward' };

/** dispatch.r2Meters default from docs/POLICY.md (the harness refuses to run if Area C is within it of A or B). */
export function policyR2Meters() {
  const md = readFileSync(join(ROOT, 'docs', 'POLICY.md'), 'utf8');
  const m = md.match(/\|\s*`dispatch\.r2Meters`[^|]*\|[^|]*\|\s*([0-9.]+)\s*\|/);
  if (!m) throw new Error('could not read dispatch.r2Meters from docs/POLICY.md');
  return Number(m[1]);
}

export function haversineM(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
