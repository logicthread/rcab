#!/usr/bin/env node
/**
 * Driver-app demo director (RCAB-E8.S14) — TEST-HARNESS ONLY.
 *
 *   node director.mjs --scene D04 --out <dir> [--port 8787] [--serial emulator-5554]
 *
 * A tiny HTTP "cue" server the on-device scene (integration_test/demo/*_test.dart) calls through
 * http://10.0.2.2:<port>/cue/<name>. It owns everything outside the app:
 *   - the screen recorder (adb shell screenrecord), started on `ready`, stopped + pulled on `end`;
 *   - the GPS (adb emu geo fix), placed in Area B and moved along OSRM routes during rides;
 *   - runtime permission grants / the system permission dialog;
 *   - simulated passengers (ordinary client sessions calling the public API) and, for D05, a
 *     simulated rival driver over Socket.IO.
 * Nothing here touches the shipped app or adds anything to the API.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { API_BASE, AREA_B, IDS, ROOT, mintAccess, psql, redis, die } from './fixtures.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : argv[i + 1];
};
const SCENE = arg('scene') ?? die('--scene required');
const OUT = arg('out') ?? die('--out required');
const PORT = Number(arg('port', '8787'));
const SERIAL = arg('serial', 'emulator-5554');
const PKG = 'com.rcab.driver_app';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(`[director ${SCENE}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...a) => spawnSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8' });

// ── places in Area B (Narengi, Guwahati) ─────────────────────────────────────
const P = {
  driverStart: { lat: AREA_B.lat, lng: AREA_B.lng },
  pickup: { lat: 26.1872, lng: 91.8161 },
  dropoff: { lat: 26.1800, lng: 91.805 },
  rivalSpot: { lat: 26.1868, lng: 91.8172 },
  // D06 shared: three riders on one corridor (pickups and drops each within a few hundred metres)
  // (tight enough that route similarity >= matching.similarityThreshold, so all three share one pool)
  shared: [
    { o: { lat: 26.1874, lng: 91.8158 }, d: { lat: 26.1801, lng: 91.8052 } },
    { o: { lat: 26.1871, lng: 91.8155 }, d: { lat: 26.1799, lng: 91.8049 } },
    { o: { lat: 26.1868, lng: 91.8152 }, d: { lat: 26.1797, lng: 91.8046 } },
  ],
};

let gps = { ...P.driverStart };
function geoFix(p) {
  gps = { lat: p.lat, lng: p.lng };
  adb('emu', 'geo', 'fix', String(p.lng), String(p.lat));
}

// ── OSRM (no host port: query it from inside the api container) ─────────────
function route(a, b) {
  const url = `http://osrm:5000/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
  const r = spawnSync('docker', ['exec', 'rcab-dev-api-1', 'curl', '-s', url], { encoding: 'utf8' });
  try {
    const coords = JSON.parse(r.stdout).routes[0].geometry.coordinates;
    return coords.map(([lng, lat]) => ({ lat, lng }));
  } catch {
    return [a, b];
  }
}

/** Move the emulator GPS along the road from the current fix to `to` over `secs` (background). */
let driveToken = 0;
function drive(to, secs) {
  const my = ++driveToken;
  const pts = route(gps, to);
  const steps = Math.max(2, Math.round(secs));
  (async () => {
    for (let i = 1; i <= steps && my === driveToken; i++) {
      const p = pts[Math.min(pts.length - 1, Math.round((i / steps) * (pts.length - 1)))];
      geoFix(p);
      await sleep(1000);
    }
  })();
}

// ── recorder ─────────────────────────────────────────────────────────────────
// `adb shell screenrecord` cannot encode on a headless swiftshader emulator (Encoder failed, err=-38),
// so the emulator console's own recorder is used: it writes VP9 .webm straight to the host.
let recording = false;
let recStartedAt = 0;
const rawPath = () => join(OUT, `${SCENE}.raw.webm`);
function startRecording() {
  adb('emu', 'screenrecord', 'stop');
  const r = adb('emu', 'screenrecord', 'start', '--time-limit', '180', rawPath());
  recording = true;
  recStartedAt = Date.now();
  log('recording ->', rawPath(), r.stdout.trim());
}
async function stopRecording() {
  if (!recording) return;
  recording = false;
  adb('emu', 'screenrecord', 'stop');
  await sleep(2500); // let the emulator finalise the file
  log('recording stopped', `(${Math.round((Date.now() - recStartedAt) / 1000)} s)`);
}

// ── permissions ──────────────────────────────────────────────────────────────
function grantLocation() {
  for (const p of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_BACKGROUND_LOCATION']) {
    adb('shell', 'pm', 'grant', PKG, `android.permission.${p}`);
  }
}
function revokeLocation() {
  for (const p of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_BACKGROUND_LOCATION']) {
    adb('shell', 'pm', 'revoke', PKG, `android.permission.${p}`);
  }
}
/** Wait for the system permission dialog and press its allow button. */
async function allowSystemDialog(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
    const xml = adb('shell', 'cat', '/sdcard/ui.xml').stdout;
    const m =
      xml.match(/text="(Allow only while using the app|While using the app|Allow all the time|Allow)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ??
      xml.match(/resource-id="com\.android\.permissioncontroller:id\/permission_allow_foreground_only_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (m) {
      const [x1, y1, x2, y2] = m.slice(-4).map(Number);
      await sleep(1200); // let the viewer read the dialog
      adb('shell', 'input', 'tap', String((x1 + x2) >> 1), String((y1 + y2) >> 1));
      return true;
    }
    await sleep(400);
  }
  return false;
}

// ── API as a passenger ───────────────────────────────────────────────────────
async function api(method, path, token, body, headers = {}) {
  // The dev api hot-reloads when anyone edits its source (tsx watch): retry a
  // refused connection for a few seconds instead of failing the scene. The same
  // idempotency-key is reused, so a retried POST /v1/rides cannot double-book.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) {
      if (attempt >= 15) throw e;
      log(`api ${method} ${path} unreachable (${e.cause?.code ?? e.message}), retrying`);
      await sleep(1000);
    }
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return json;
}
const clientToken = (n) => mintAccess(IDS.clients[n], 'client', 1800);

async function requestSolo(n = 0, from = P.pickup, to = P.dropoff) {
  const tok = clientToken(n);
  const route = { originLat: from.lat, originLng: from.lng, destLat: to.lat, destLng: to.lng };
  const q = await api('POST', '/v1/rides/quote', tok, { type: 'normal', ...route });
  const ride = await api('POST', '/v1/rides', tok, { type: 'normal', ...route, quoteToken: q.quoteToken }, { 'idempotency-key': randomUUID() });
  log('solo ride requested', ride.rideId ?? ride.id, ride.status);
  return { rideId: ride.rideId ?? ride.id, status: ride.status, fare: q.soloFare };
}
async function cancelAsClient(n, rideId) {
  try {
    return await api('POST', `/v1/rides/${rideId}/cancel`, clientToken(n), { reason: 'demo: passenger changed plans' });
  } catch (e) {
    return { error: String(e.message) };
  }
}
async function rideStatus(n, rideId) {
  return api('GET', `/v1/rides/${rideId}`, clientToken(n));
}

// ── a simulated rival driver (D05 "lost") ────────────────────────────────────
let rival = null;
async function startRival({ acceptAfterMs = 3500 } = {}) {
  const require = createRequire(join(ROOT, 'apps/web/package.json'));
  const { io } = require('socket.io-client');
  const tok = mintAccess(IDS.rival, 'driver', 1800);
  await api('POST', '/v1/drivers/online', tok, P.rivalSpot);
  const sock = io(API_BASE, { transports: ['websocket'], auth: { token: tok } });
  const beat = setInterval(() => sock.emit('driver:location', { ...P.rivalSpot, heading: 0, speed: 0 }), 4000);
  sock.on('ride_offer', (o) => {
    log('rival got offer', o.offerId);
    setTimeout(() => sock.emit('ride_offer_response', { offerId: o.offerId, accept: true }, (ack) => log('rival accept ack', JSON.stringify(ack))), acceptAfterMs);
  });
  rival = { sock, tok, beat };
}
async function stopRival() {
  if (!rival) return;
  clearInterval(rival.beat);
  try {
    await api('POST', '/v1/drivers/offline', rival.tok);
  } catch {}
  rival.sock.close();
  rival = null;
}

// ── presence (what dispatch sees) ────────────────────────────────────────────
function presence(driverId = IDS.driver) {
  const pos = redis('GEOPOS', 'active_drivers', driverId).split('\n').filter(Boolean);
  const lastSeen = Number(redis('HGET', `driver:state:${driverId}`, 'last_seen')) || null;
  const availability = psql(`SELECT availability FROM driver WHERE user_id = '${driverId}'`).trim();
  return {
    inGeoIndex: pos.length === 2,
    lng: pos[0] ? Number(pos[0]).toFixed(4) : null,
    lat: pos[1] ? Number(pos[1]).toFixed(4) : null,
    lastSeenAgoS: lastSeen ? Math.round((Date.now() - lastSeen) / 1000) : null,
    availability,
  };
}

// ── cues ─────────────────────────────────────────────────────────────────────
const state = { rides: [] };
const cues = {
  async ready(q) {
    geoFix(P.driverStart);
    // Granting at runtime is safe; revoking would kill the running app, so a scene that shows the
    // permission dialog (D03) is revoked at director start-up, before the app launches.
    if (q.grant !== '0') grantLocation();
    startRecording();
    await sleep(1200);
    return { ok: true };
  },
  async allow() {
    return { allowed: await allowSystemDialog() };
  },
  async presence(q) {
    return presence(q.driver === 'new' ? IDS.newDriver : IDS.driver);
  },
  async geo(q) {
    const p = P[q.at] ?? { lat: Number(q.lat), lng: Number(q.lng) };
    geoFix(p);
    return { ...gps };
  },
  async drive(q) {
    const target = q.to === 'pickup' ? P.pickup : q.to === 'dropoff' ? P.dropoff : P.shared[Number(q.leg ?? 0)]?.[q.to === 'sdrop' ? 'd' : 'o'] ?? P.pickup;
    drive(target, Number(q.secs ?? 10));
    return { to: target };
  },
  async 'request-ride'(q) {
    const n = Number(q.client ?? 0);
    const r = await requestSolo(n);
    state.rides.push({ n, ...r });
    return r;
  },
  async 'cancel-ride'() {
    const r = state.rides.at(-1);
    return r ? cancelAsClient(r.n, r.rideId) : { none: true };
  },
  async 'ride-status'() {
    const r = state.rides.at(-1);
    if (!r) return { none: true };
    const s = await rideStatus(r.n, r.rideId);
    return { rideId: r.rideId, status: s.status };
  },
  /** The scene driver's refresh-token rows (D08: logout revokes it server-side). */
  async session(q) {
    const id = q.driver === 'new' ? IDS.newDriver : IDS.driver;
    const row = psql(`SELECT count(*) FILTER (WHERE revoked_at IS NULL AND expires_at > now()) || '|' ||
      count(*) FILTER (WHERE revoked_at > now() - interval '5 minutes')
      FROM auth_refresh_token WHERE user_id = '${id}'`).trim();
    const [live, revokedJustNow] = row.split('|').map(Number);
    return { live, revokedJustNow };
  },
  async 'backdate-arrival'(q) {
    const r = state.rides.at(-1);
    const secs = Number(q.secs ?? 305);
    psql(`UPDATE rides SET arrived_at = now() - interval '${secs} seconds' WHERE id = '${r.rideId}' AND status = 'arrived';`);
    return { rideId: r.rideId, backdatedS: secs };
  },
  async 'rival-on'(q) {
    await startRival({ acceptAfterMs: Number(q.after ?? 3500) });
    return { rival: true };
  },
  async 'rival-off'() {
    await stopRival();
    return { rival: false };
  },
  async 'request-shared'() {
    const out = [];
    for (let i = 0; i < P.shared.length; i++) {
      const { o, d } = P.shared[i];
      const tok = clientToken(i);
      const body = { type: 'shared', originLat: o.lat, originLng: o.lng, destLat: d.lat, destLng: d.lng };
      const r = await api('POST', '/v1/rides', tok, body, { 'idempotency-key': randomUUID() });
      // POST /v1/rides (shared) answers { sharedRideId, mode: opened|slotted, poolStatus, perSeatPrice, … }.
      log('shared seat', i + 1, JSON.stringify({ pool: r.sharedRideId, mode: r.mode, poolStatus: r.poolStatus, seat: r.perSeatPrice }));
      out.push({ pool: r.sharedRideId, mode: r.mode, poolStatus: r.poolStatus });
      await sleep(1500);
    }
    return { seats: out };
  },
  async pool() {
    const row = psql(`SELECT ride_id || '|' || pool_state || '|' || seat_count FROM shared_rides sr
      WHERE EXISTS (SELECT 1 FROM pool_member m WHERE m.pool_id = sr.ride_id AND m.passenger_id = '${IDS.clients[0]}')
      ORDER BY created_at DESC LIMIT 1`).trim();
    const [id, poolState, seats] = row.split('|');
    return { id, poolState, seats: Number(seats) };
  },
  async end() {
    driveToken++;
    await stopRival();
    setTimeout(async () => {
      await stopRecording();
      server.close();
      process.exit(0);
    }, 50);
    return { ok: true };
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const name = url.pathname.replace(/^\/cue\//, '');
  const q = Object.fromEntries(url.searchParams);
  const fn = cues[name];
  if (!fn) {
    res.writeHead(404).end(JSON.stringify({ error: `unknown cue ${name}` }));
    return;
  }
  try {
    log('cue', name, JSON.stringify(q));
    const out = await fn(q);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? {}));
  } catch (e) {
    log('cue failed', name, e.message);
    res.writeHead(500).end(JSON.stringify({ error: e.message }));
  }
});
if (SCENE === 'D03') revokeLocation();
geoFix(P.driverStart);

server.listen(PORT, '127.0.0.1', () => log(`cue server on 127.0.0.1:${PORT} (emulator: http://10.0.2.2:${PORT})`));
process.on('SIGTERM', async () => {
  await stopRecording();
  process.exit(1);
});
