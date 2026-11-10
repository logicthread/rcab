#!/usr/bin/env node
/**
 * Prepare the DEV stack for the k6 workloads (RCAB-E8.S12).
 *
 *   node infra/load/prepare-dev.mjs [--clients N] [--drivers N] [--contention N] [--ttl-s S]
 *                                   [--base-lat LAT --base-lng LNG] [--clean]
 *
 * What it does
 *   1. Upserts N load-test clients and M verified, online drivers (+ vehicle) in the dev Postgres and
 *      the Redis geo index, through `docker compose exec` (no host pg/redis client, no published port).
 *      Rows are tagged `firebase_uid LIKE 'loadtest-%'`, so `--clean` removes exactly them.
 *   2. Mints short-lived HS256 access tokens for them, signed with the dev stack's own JWT_SECRET, and
 *      writes infra/load/tokens.generated.json (git-ignored) for the k6 scripts.
 *
 * Why this is not a production backdoor
 *   - The API gains NO endpoint, flag or bypass. Authentication is unchanged: the guard verifies an
 *     ordinary signed access token. These tokens are valid only where the caller already holds that
 *     environment's JWT_SECRET *and* its database/redis, i.e. the operator of the dev stack.
 *   - This script refuses to run against anything but a loopback API with NODE_ENV != production, and
 *     refuses the compose project unless it is the dev one. It never reads a production env file.
 *
 * Environment
 *   RCAB_ENV_FILE     env file holding JWT_SECRET + POSTGRES_* (default: <repo>/.env.dev)
 *   RCAB_COMPOSE_PROJECT   compose project of the running dev stack (default: rcab-dev)
 *   API_BASE          where k6 will point (default http://localhost:3000); must be loopback
 *   LOAD_BASE_LAT / LOAD_BASE_LNG   pickup cluster centre (default 26.1445 / 91.7362 = Guwahati "Area A");
 *                     the flags --base-lat / --base-lng win. Point it away from other people's fixtures
 *                     (e.g. 26.1150 / 91.7000) so simulated drivers never get offers for real demo rides -
 *                     keep it > dispatch.r2Meters (docs/POLICY.md) from them, and inside the OSRM extract.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const TOKENS_FILE = join(here, 'tokens.generated.json');

// ── guards ───────────────────────────────────────────────────────────────────
function die(msg) {
  console.error(`[load:prepare] ${msg}`);
  process.exit(2);
}

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const apiHost = new URL(API_BASE).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(apiHost)) {
  die(`refusing: API_BASE host '${apiHost}' is not loopback. Dev/test tokens are for the local dev stack only.`);
}
if (process.env.NODE_ENV === 'production') die('refusing: NODE_ENV=production.');

const project = process.env.RCAB_COMPOSE_PROJECT ?? 'rcab-dev';
if (!/(^|[-_])(dev|test)([-_]|$)/.test(project)) {
  die(`refusing: compose project '${project}' is not a dev/test project.`);
}

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : Number(argv[i + 1]);
};
const CLIENTS = flag('clients', 10);
const DRIVERS = flag('drivers', 24);
// Drivers 1..CONTENTION sit at the pickup cluster (the offer-contention scenario's drivers); the rest are
// parked outside the wave-1 radius so they never dilute wave 1's top-K and the contention stays exact.
const CONTENTION = flag('contention', 4);
const TTL_S = flag('ttl-s', 900);
const CLEAN = argv.includes('--clean');
const inRange = (n, max) => Number.isInteger(n) && n >= 1 && n <= max;
if (!inRange(CLIENTS, 99) || !inRange(DRIVERS, 99) || !inRange(TTL_S, 3600)) {
  die('--clients/--drivers must be 1..99 and --ttl-s 1..3600');
}

// ── env ──────────────────────────────────────────────────────────────────────
const envFile = process.env.RCAB_ENV_FILE ?? join(root, '.env.dev');
if (!existsSync(envFile)) die(`env file not found: ${envFile} (set RCAB_ENV_FILE; run \`pnpm dev:up\` once to create it)`);
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

const compose = ['compose', '-p', project, '--env-file', envFile, '-f', join(root, 'infra/docker/docker-compose.dev.yml')];
function run(service, args, input) {
  const r = spawnSync('docker', [...compose, 'exec', '-T', service, ...args], { input, encoding: 'utf8' });
  if (r.status !== 0) die(`docker compose exec ${service} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const psql = (sql) => run('postgres', ['psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', PGU, '-d', PGD], sql);
const redis = (...args) => run('redis', ['redis-cli', ...args]);

// Deterministic ids, disjoint from scripts/seed-dev.sh (…0000000000NN / …01NN / …02NN).
const pad = (n) => String(n).padStart(2, '0');
const driverId = (n) => `00000000-0000-4000-8000-0000005000${pad(n)}`;
const clientId = (n) => `00000000-0000-4000-8000-0000005100${pad(n)}`;
const vehicleId = (n) => `00000000-0000-4000-8000-0000005200${pad(n)}`;

// Guwahati pickup cluster, inside the NE-India OSRM extract (routing returns NoRoute outside it).
const coord = (name, env, dflt, lo, hi) => {
  const v = flag(name, process.env[env] !== undefined && process.env[env] !== '' ? Number(process.env[env]) : dflt);
  if (!Number.isFinite(v) || v < lo || v > hi) die(`--${name}/${env} must be a number in ${lo}..${hi}`);
  return v;
};
const BASE = {
  lat: coord('base-lat', 'LOAD_BASE_LAT', 26.1445, 20, 30),
  lng: coord('base-lng', 'LOAD_BASE_LNG', 91.7362, 85, 98),
};

if (CLEAN) {
  psql(`
    DELETE FROM ratings WHERE rater_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'loadtest-%')
       OR subject_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'loadtest-%');
    DELETE FROM rides WHERE passenger_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'loadtest-%');
    UPDATE driver SET current_vehicle_id = NULL WHERE user_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'loadtest-%');
    DELETE FROM vehicle WHERE driver_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'loadtest-%');
    DELETE FROM app_user WHERE firebase_uid LIKE 'loadtest-%';
  `);
  for (let n = 1; n <= 99; n++) {
    redis('ZREM', 'active_drivers', driverId(n));
    redis('DEL', `driver:state:${driverId(n)}`);
  }
  console.log('[load:prepare] removed load-test users, rides and presence.');
  process.exit(0);
}

// ── fixtures ─────────────────────────────────────────────────────────────────
psql(`
DO $$
DECLARE n int; uid uuid; vid uuid;
BEGIN
  FOR n IN 1..${DRIVERS} LOOP
    uid := ('00000000-0000-4000-8000-0000005000' || lpad(n::text, 2, '0'))::uuid;
    vid := ('00000000-0000-4000-8000-0000005200' || lpad(n::text, 2, '0'))::uuid;
    INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status)
    VALUES (uid, 'loadtest-driver-' || n, '+9198100000' || lpad(n::text, 2, '0'), 'Load Driver ' || n, 'driver', 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active';
    INSERT INTO driver (user_id, license_no, verified_at, availability)
    VALUES (uid, 'LOADLIC' || lpad(n::text, 4, '0'), now(), 'online')
    ON CONFLICT (user_id) DO UPDATE SET verified_at = now(), availability = 'online';
    INSERT INTO vehicle (id, driver_id, type, reg_no, make, model, color, seats, active)
    VALUES (vid, uid, 'cab_sedan', 'LD01' || lpad(n::text, 4, '0'), 'Load', 'Fixture', 'white', 4, true)
    ON CONFLICT (id) DO UPDATE SET active = true;
    UPDATE driver SET current_vehicle_id = vid WHERE user_id = uid;
  END LOOP;
  FOR n IN 1..${CLIENTS} LOOP
    uid := ('00000000-0000-4000-8000-0000005100' || lpad(n::text, 2, '0'))::uuid;
    INSERT INTO app_user (id, firebase_uid, phone_e164, display_name, role, status)
    VALUES (uid, 'loadtest-client-' || n, '+9198200000' || lpad(n::text, 2, '0'), 'Load Client ' || n, 'client', 'active')
    ON CONFLICT (id) DO UPDATE SET status = 'active';
    INSERT INTO client (user_id) VALUES (uid) ON CONFLICT (user_id) DO NOTHING;
  END LOOP;
END $$;
`);

// A client left holding an active ride by an earlier run would 409 every create: cancel those.
psql(`
UPDATE rides SET status = 'cancelled', cancelled_by = 'client', cancel_reason = 'loadtest-prepare'
 WHERE passenger_id IN (SELECT id FROM app_user WHERE firebase_uid LIKE 'loadtest-client-%')
   AND status IN ('requested', 'dispatching', 'accepted', 'en_route', 'arrived');
`);

// Presence: the geo index + state hash the dispatcher reads. Each driver's socket keeps it fresh once
// connected; this seeds it so the first ride after prepare already finds candidates.
const drivers = [];
for (let n = 1; n <= DRIVERS; n++) {
  const near = n <= CONTENTION;
  const lat = near ? BASE.lat + ((n % 5) - 2) * 0.0008 : BASE.lat - 0.022 - (n % 5) * 0.002;
  const lng = near ? BASE.lng + ((n % 7) - 3) * 0.0008 : BASE.lng + ((n % 7) - 3) * 0.003;
  redis('GEOADD', 'active_drivers', String(lng), String(lat), driverId(n));
  redis('HSET', `driver:state:${driverId(n)}`, 'availability', 'online', 'last_seen', String(Date.now()), 'session_id', `loadtest-${n}`);
  drivers.push({ n, id: driverId(n), lat, lng });
}

// ── tokens ───────────────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function mint(sub, role) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, role, auth_method: 'phone', typ: 'access', iss: 'rcab', aud: 'rcab-api', iat: now, exp: now + TTL_S, jti: randomUUID() });
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

const out = {
  _generated: 'by infra/load/prepare-dev.mjs - DEV ONLY, git-ignored, expires at expiresAt. Never commit or reuse outside the local dev stack.',
  apiBase: API_BASE,
  base: BASE,
  expiresAt: new Date(Date.now() + TTL_S * 1000).toISOString(),
  clients: Array.from({ length: CLIENTS }, (_, i) => ({ id: clientId(i + 1), token: mint(clientId(i + 1), 'client') })),
  drivers: drivers.map((d) => ({ id: d.id, lat: d.lat, lng: d.lng, token: mint(d.id, 'driver') })),
};
writeFileSync(TOKENS_FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
console.log(`[load:prepare] ${CLIENTS} clients + ${DRIVERS} online drivers ready; tokens (${TTL_S}s) -> ${TOKENS_FILE}`);
