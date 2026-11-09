/**
 * Driver-app demo harness — host-side fixtures + sessions (RCAB-E8.S14).
 *
 * TEST-HARNESS ONLY. Mirrors infra/load/prepare-dev.mjs: it talks to the running DEV compose stack
 * through `docker compose exec` (postgres / redis) and mints ordinary signed access tokens with the
 * dev stack's own JWT_SECRET. The API gains NO endpoint, flag or bypass: the app and the API run
 * their normal code paths with an ordinary session, exactly as after a real Firebase OTP sign-in.
 *
 * Refuses to run unless: the API base is loopback, NODE_ENV is not production, the env file does not
 * set NODE_ENV=production, and the compose project name is a dev/test one.
 *
 * Fixture users live in "Area B" (Narengi, Guwahati — see AREA_B), >= 2 x dispatch.r2Meters away
 * from the web harness's Area A (26.1445, 91.7362), so the two harnesses never offer each other's
 * rides. All rows are tagged `firebase_uid LIKE 'demo-drv-%'` and cleaned by `resetScene()`.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..', '..', '..', '..');

export function die(msg) {
  console.error(`[driver-demo] ${msg}`);
  process.exit(2);
}

// ── guards ───────────────────────────────────────────────────────────────────
export const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const apiHost = new URL(API_BASE).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(apiHost)) {
  die(`refusing: API_BASE host '${apiHost}' is not loopback (dev stack only).`);
}
if (process.env.NODE_ENV === 'production') die('refusing: NODE_ENV=production.');
const project = process.env.RCAB_COMPOSE_PROJECT ?? 'rcab-dev';
if (!/(^|[-_])(dev|test)([-_]|$)/.test(project)) die(`refusing: compose project '${project}' is not dev/test.`);

const envFile = process.env.RCAB_ENV_FILE ?? join(ROOT, '.env.dev');
if (!existsSync(envFile)) die(`env file not found: ${envFile} (run \`pnpm dev:up\` once)`);
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    }),
);
if ((env.NODE_ENV ?? '') === 'production') die(`refusing: ${envFile} sets NODE_ENV=production.`);
const JWT_SECRET = env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) die(`JWT_SECRET missing or < 32 chars in ${envFile}`);
const PGU = env.POSTGRES_USER ?? 'rcab';
const PGD = env.POSTGRES_DB ?? 'rcab';

const compose = ['compose', '-p', project, '--env-file', envFile, '-f', join(ROOT, 'infra/docker/docker-compose.dev.yml')];
function exec(service, args, input) {
  const r = spawnSync('docker', [...compose, 'exec', '-T', service, ...args], { input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker compose exec ${service} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
export const psql = (sql) => exec('postgres', ['psql', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-U', PGU, '-d', PGD], sql);
export const redis = (...args) => exec('redis', ['redis-cli', ...args]).trim();

// ── fixture ids (disjoint from seed-dev …00NN/01NN/02NN and load-test …50NN/51NN/52NN) ──
export const IDS = {
  driver: '00000000-0000-4000-8000-000000700001', // main demo driver (has a vehicle)
  rival: '00000000-0000-4000-8000-000000700002', // simulated second driver (D05 "lost")
  newDriver: '00000000-0000-4000-8000-000000700003', // onboarding driver, starts with no vehicle (D02)
  vehicle: '00000000-0000-4000-8000-000000720001',
  rivalVehicle: '00000000-0000-4000-8000-000000720002',
  clients: [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000071000${n}`),
};
export const DRIVERS = [IDS.driver, IDS.rival, IDS.newDriver];

/** Area B — Narengi, Guwahati. ~9.8 km from Area A (26.1445, 91.7362) > 2 x R2 (4 km). */
export const AREA_B = { lat: 26.19, lng: 91.82 };

export function upsertFixtures() {
  const [c1, c2, c3, c4] = IDS.clients;
  psql(`
  INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status) VALUES
    ('${IDS.driver}', 'demo-drv-main', '+919830070001', 'Demo Driver B1', 'driver', 'active'),
    ('${IDS.rival}', 'demo-drv-rival', '+919830070002', 'Demo Driver B2 (rival)', 'driver', 'active'),
    ('${IDS.newDriver}', 'demo-drv-new', '+919830070003', 'Demo Driver B3 (new)', 'driver', 'active'),
    ('${c1}', 'demo-drv-client-1', '+919830071001', 'Demo Passenger B1', 'client', 'active'),
    ('${c2}', 'demo-drv-client-2', '+919830071002', 'Demo Passenger B2', 'client', 'active'),
    ('${c3}', 'demo-drv-client-3', '+919830071003', 'Demo Passenger B3', 'client', 'active'),
    ('${c4}', 'demo-drv-client-4', '+919830071004', 'Demo Passenger B4', 'client', 'active')
  ON CONFLICT (id) DO UPDATE SET status = 'active';
  INSERT INTO driver (user_id, license_no, verified_at, availability) VALUES
    ('${IDS.driver}', 'AS01-DEMO-0001', now(), 'offline'),
    ('${IDS.rival}', 'AS01-DEMO-0002', now(), 'offline'),
    ('${IDS.newDriver}', 'AS01-DEMO-0003', now(), 'offline')
  ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO client (user_id) VALUES ('${c1}'), ('${c2}'), ('${c3}'), ('${c4}') ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO vehicle (id, driver_id, type, reg_no, make, model, color, seats, active) VALUES
    ('${IDS.vehicle}', '${IDS.driver}', 'cab_sedan', 'AS01DB0001', 'Maruti', 'Dzire', 'white', 4, true),
    ('${IDS.rivalVehicle}', '${IDS.rival}', 'cab_sedan', 'AS01DB0002', 'Hyundai', 'Aura', 'silver', 4, true)
  ON CONFLICT (id) DO UPDATE SET active = true;
  UPDATE driver SET current_vehicle_id = '${IDS.vehicle}' WHERE user_id = '${IDS.driver}';
  UPDATE driver SET current_vehicle_id = '${IDS.rivalVehicle}' WHERE user_id = '${IDS.rival}';
  `);
}

const LIVE = `('requested','dispatching','accepted','en_route','arrived','in_progress')`;
const clientList = () => IDS.clients.map((c) => `'${c}'`).join(',');
const driverList = () => DRIVERS.map((d) => `'${d}'`).join(',');

/** Return every demo user to a clean, offline, trip-free state (idempotent). */
export function resetScene({ newDriverVehicles = false } = {}) {
  psql(`
  UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'client', cancel_reason = 'demo-reset'
   WHERE (passenger_id IN (${clientList()}) OR driver_id IN (${driverList()})) AND status IN ${LIVE};
  UPDATE dispatch_offer SET state = 'revoked', resolved_at = now()
   WHERE driver_id IN (${driverList()}) AND state = 'offered';
  UPDATE pool_member SET active = false, left_at = now() WHERE passenger_id IN (${clientList()}) AND active;
  UPDATE shared_rides SET pool_state = 'aborted'
   WHERE pool_state NOT IN ('completed','aborted')
     AND (claimed_by_driver_id IN (${driverList()})
          OR ride_id IN (SELECT pool_id FROM pool_member WHERE passenger_id IN (${clientList()})));
  DELETE FROM driver_active_assignment WHERE driver_id IN (${driverList()});
  -- sessions minted by earlier scenes (each scene mints a fresh one after this reset)
  DELETE FROM auth_refresh_token WHERE user_id IN (${driverList()});
  UPDATE driver SET availability = 'offline' WHERE user_id IN (${driverList()});
  ${newDriverVehicles ? `UPDATE driver SET current_vehicle_id = NULL WHERE user_id = '${IDS.newDriver}';
  DELETE FROM vehicle WHERE driver_id = '${IDS.newDriver}';` : ''}
  `);
  for (const d of DRIVERS) {
    redis('ZREM', 'active_drivers', d);
    redis('DEL', `driver:state:${d}`);
  }
}

// ── sessions ─────────────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/** An ordinary rcab access token (same claims as AuthService.signAccessToken). */
export function mintAccess(sub, role, ttlS = 1800) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, role, auth_method: 'phone', typ: 'access', iss: 'rcab', aud: 'rcab-api', iat: now, exp: now + ttlS, jti: randomUUID() });
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * A native session for a fixture user: an access token plus a refresh token whose SHA-256 digest is
 * stored in auth_refresh_token exactly as AuthService stores one after a Firebase exchange, so the
 * app's refresh interceptor and possession-based logout behave normally.
 */
export function mintSession(userId, role, ttlS = 1800) {
  const refresh = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(refresh, 'utf8').digest('hex');
  psql(`INSERT INTO auth_refresh_token (token_hash, family_id, user_id, auth_method, expires_at)
        VALUES ('${hash}', '${randomUUID()}', '${userId}', 'phone', now() + interval '1 day');`);
  return { userId, jwt: mintAccess(userId, role, ttlS), refresh };
}
