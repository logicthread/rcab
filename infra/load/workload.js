/**
 * k6 realistic workload for the DEV stack (RCAB-E8.S12 / R12). `pnpm test:load:workload`.
 *
 * Scenarios (select with SCENARIOS=a,b; default all):
 *   quote             authenticated POST /v1/rides/quote at a fixed arrival rate.
 *   ride_create       quote -> POST /v1/rides with an Idempotency-Key -> replay the SAME key (must return the
 *                     same ride) -> cancel. Exercises the durable-intent + idempotency path.
 *   offer_contention  N simulated drivers hold Socket.IO sessions near one pickup; riders create rides; every
 *                     driver gets the wave-1 offer and tries to accept it after a short think time. Exactly
 *                     one accept may win per ride. Also measures ride create -> first ride_offer received.
 *   driver_location   M simulated drivers hold sessions and emit `driver:location` every
 *                     perfBudget.driverLocationIntervalMs (the driver app's foreground cadence).
 *
 * Thresholds are the Phase-0 budget (docs/POLICY.md, category `perfBudget`; generated into
 * perf-budget.generated.json). Results of a short run are a SMOKE signal, not a capacity claim.
 *
 * Limits (documented, not hidden):
 *   - Simulated drivers speak the real Socket.IO protocol, but `driver:location` has no ack, so the run can
 *     prove delivery only indirectly (session stays up; presence is checked afterwards in Redis).
 *   - All traffic comes from one IP, so the API's per-client throttle (rateLimits.* in POLICY.md) applies;
 *     429s are counted (`http_429`) and fail the business-success gate rather than being hidden.
 *   - Fixture identities are dev-only (prepare-dev.mjs); a production stack cannot be targeted.
 *
 * Env: API_BASE, SCENARIOS, DURATION (default 30s), QUOTE_RATE (/s), CREATE_RATE (/s), RIDER_VUS,
 *      CONTENTION_DRIVERS, LOCATION_DRIVERS, ACCEPT_THINK_MS, PERF_BUDGET_* overrides.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { API_BASE, budget, envInt, identities, selected, uuid4 } from './lib/config.js';
import { session } from './lib/socketio.js';

const ALL = ['quote', 'ride_create', 'offer_contention', 'driver_location'];
const RUN = selected(ALL);
const DURATION_S = parseInt((__ENV.DURATION || '30s').replace(/s$/, ''), 10);
const QUOTE_RATE = envInt('QUOTE_RATE', 5);
const CREATE_RATE = envInt('CREATE_RATE', 1);
// >1 makes riders compete for the same few drivers: a driver holding a live offer is not offered a second ride.
const RIDER_VUS = envInt('RIDER_VUS', 1);
const CONTENTION_DRIVERS = envInt('CONTENTION_DRIVERS', 4); // keep <= dispatch.k1 (5) so every driver is offered
const LOCATION_DRIVERS = envInt('LOCATION_DRIVERS', 10);
const ACCEPT_THINK_MS = envInt('ACCEPT_THINK_MS', 80);
const LOCATION_INTERVAL_MS = budget('driverLocationIntervalMs');
const RIDE_EVERY_MS = envInt('RIDE_EVERY_MS', 4000);
const CANCEL_AFTER_MS = envInt('CANCEL_AFTER_MS', 1500);

// ── custom metrics ───────────────────────────────────────────────────────────
const businessSuccess = new Rate('business_success');
const http5xx = new Rate('http_5xx');
const http429 = new Counter('http_429');
const dispatchFirstOfferMs = new Trend('dispatch_first_offer_ms', true);
const acceptAckMs = new Trend('offer_accept_ack_ms', true);
const offersReceived = new Counter('offers_received');
const acceptWon = new Counter('offer_accept_won');
const acceptLost = new Counter('offer_accept_lost');
const ridesAcceptedSeen = new Counter('rides_accepted_seen');
const locationSent = new Counter('driver_location_sent');
const wsSessionOk = new Rate('ws_session_ok');

// ── options ──────────────────────────────────────────────────────────────────
const scenarios = {};
if (RUN.indexOf('quote') !== -1) {
  scenarios.quote = {
    executor: 'constant-arrival-rate',
    rate: QUOTE_RATE,
    timeUnit: '1s',
    duration: `${DURATION_S}s`,
    preAllocatedVUs: 5,
    maxVUs: 20,
    exec: 'quoteScenario',
  };
}
if (RUN.indexOf('ride_create') !== -1) {
  scenarios.ride_create = {
    executor: 'constant-arrival-rate',
    rate: CREATE_RATE,
    timeUnit: '1s',
    duration: `${DURATION_S}s`,
    preAllocatedVUs: 5,
    maxVUs: 20,
    exec: 'rideCreateScenario',
  };
}
if (RUN.indexOf('offer_contention') !== -1) {
  scenarios.offer_contention = {
    executor: 'per-vu-iterations',
    vus: CONTENTION_DRIVERS,
    iterations: 1,
    maxDuration: `${DURATION_S + 30}s`,
    exec: 'contentionScenario',
  };
}
if (RUN.indexOf('driver_location') !== -1) {
  scenarios.driver_location = {
    executor: 'per-vu-iterations',
    vus: LOCATION_DRIVERS,
    iterations: 1,
    maxDuration: `${DURATION_S + 30}s`,
    exec: 'locationScenario',
  };
}

const thresholds = {
  http_5xx: [`rate<${budget('errorRate5xx')}`],
  business_success: [`rate>${budget('minBusinessSuccessRate')}`],
  http_req_duration: [`p(95)<${budget('apiP95Ms')}`, `p(99)<${budget('apiP99Ms')}`],
};
if (scenarios.quote) thresholds['http_req_duration{kind:quote}'] = [`p(95)<${budget('quoteP95Ms')}`];
if (scenarios.offer_contention) {
  thresholds.dispatch_first_offer_ms = [`p(95)<${budget('dispatchP95Ms')}`];
  thresholds.ws_session_ok = [`rate>${budget('minBusinessSuccessRate')}`];
}
if (scenarios.driver_location) thresholds.ws_session_ok = [`rate>${budget('minBusinessSuccessRate')}`];

export const options = { scenarios, thresholds, discardResponseBodies: false };

// ── helpers ──────────────────────────────────────────────────────────────────
function who() {
  return identities();
}

function jitter(span) {
  return (Math.random() - 0.5) * span;
}

/** A route inside the dev OSRM extract: pickup near the fixture cluster, drop ~3 km away. */
function trip(base) {
  return {
    originLat: base.lat + jitter(0.004),
    originLng: base.lng + jitter(0.004),
    destLat: base.lat + 0.018 + jitter(0.004),
    destLng: base.lng + 0.012 + jitter(0.004),
  };
}

function api(method, path, token, body, kind, extraHeaders) {
  const headers = Object.assign(
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    extraHeaders || {},
  );
  const res = http.request(method, `${API_BASE}${path}`, body ? JSON.stringify(body) : null, {
    headers,
    tags: { kind: kind || 'api' },
    timeout: '15s',
  });
  http5xx.add(res.status >= 500);
  if (res.status === 429) http429.add(1);
  return res;
}

function json(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function pick(list) {
  return list[(__VU + __ITER) % list.length];
}

// ── scenario: quote ──────────────────────────────────────────────────────────
export function quoteScenario() {
  const ids = who();
  const c = pick(ids.clients);
  const res = api('POST', '/v1/rides/quote', c.token, Object.assign({ type: 'normal' }, trip(ids.base)), 'quote');
  const body = json(res);
  const ok = check(res, {
    'quote 2xx': (r) => r.status >= 200 && r.status < 300,
    'quote has token + fare': () => !!(body && body.quoteToken && body.soloFare),
  });
  businessSuccess.add(ok);
}

// ── scenario: ride_create (idempotent) ───────────────────────────────────────
export function rideCreateScenario() {
  const ids = who();
  const c = pick(ids.clients);
  const t = trip(ids.base);
  const q = api('POST', '/v1/rides/quote', c.token, Object.assign({ type: 'normal' }, t), 'quote');
  const qb = json(q);
  if (q.status < 200 || q.status >= 300 || !qb || !qb.quoteToken) {
    businessSuccess.add(false);
    return;
  }

  const key = uuid4();
  const create = () => api('POST', '/v1/rides', c.token, Object.assign({ type: 'normal', quoteToken: qb.quoteToken }, t), 'api', { 'Idempotency-Key': key });
  const first = create();
  const fb = json(first);
  const created = check(first, {
    'create 2xx': (r) => r.status >= 200 && r.status < 300,
    'create returns rideId': () => !!(fb && fb.rideId),
  });
  if (!created) {
    businessSuccess.add(false);
    return;
  }

  // The same key + same intent must return the SAME ride, never a second one.
  const replay = create();
  const rb = json(replay);
  const same = check(replay, {
    'replay 2xx': (r) => r.status >= 200 && r.status < 300,
    'replay returns the same ride': () => !!(rb && rb.rideId === fb.rideId),
  });

  sleep(0.3);
  const cancel = api('POST', `/v1/rides/${fb.rideId}/cancel`, c.token, {});
  const cancelled = check(cancel, { 'cancel 200': (r) => r.status === 200 });
  businessSuccess.add(same && cancelled);
}

// ── scenario: offer fan-out + accept contention ──────────────────────────────
export function contentionScenario() {
  const ids = who();
  const drv = ids.drivers[(__VU - 1) % ids.drivers.length];
  const isRider = __VU <= RIDER_VUS;
  const rider = isRider ? ids.clients[(__VU - 1) % ids.clients.length] : null;
  const createdAt = {}; // rideId -> ms when this VU (as rider) sent the create
  const firstOfferSeen = {};
  let opened = false;
  let dropped = false;

  const startRide = (client) => {
    const t = trip(ids.base);
    const q = api('POST', '/v1/rides/quote', rider.token, Object.assign({ type: 'normal' }, t), 'quote');
    const qb = json(q);
    if (q.status < 200 || q.status >= 300 || !qb || !qb.quoteToken) {
      businessSuccess.add(false);
      return;
    }
    const sentAt = Date.now();
    const res = api('POST', '/v1/rides', rider.token, Object.assign({ type: 'normal', quoteToken: qb.quoteToken }, t), 'api', { 'Idempotency-Key': uuid4() });
    const body = json(res);
    if (res.status < 200 || res.status >= 300 || !body || !body.rideId) {
      businessSuccess.add(false);
      return;
    }
    createdAt[body.rideId] = sentAt;
    // Let the offers fan out and be contested, then verify the outcome and release the drivers.
    client.socket.setTimeout(() => {
      const d = api('GET', `/v1/rides/${body.rideId}`, rider.token, null, 'api');
      const db = json(d);
      const accepted = !!(db && (db.status === 'accepted' || db.status === 'en_route'));
      if (accepted) ridesAcceptedSeen.add(1);
      businessSuccess.add(d.status === 200 && accepted);
      api('POST', `/v1/rides/${body.rideId}/cancel`, rider.token, {});
    }, CANCEL_AFTER_MS);
  };

  const res = session(API_BASE, drv.token, {
    onOpen(client) {
      client.socket.setTimeout(() => client.close(), DURATION_S * 1000);
    },
    onReady(client) {
      opened = true;
      const sendLoc = () => {
        client.emit('driver:location', { lat: drv.lat + jitter(0.0004), lng: drv.lng + jitter(0.0004), heading: 90, speed: 6 });
        locationSent.add(1);
      };
      sendLoc();
      client.socket.setInterval(sendLoc, LOCATION_INTERVAL_MS);
      if (isRider) {
        client.socket.setInterval(() => startRide(client), RIDE_EVERY_MS);
      }
    },
    onEvent(name, data, client) {
      if (name !== 'ride_offer' || !data || !data.offerId) return;
      const now = Date.now();
      offersReceived.add(1);
      if (data.rideId && createdAt[data.rideId] !== undefined && !firstOfferSeen[data.rideId]) {
        firstOfferSeen[data.rideId] = true;
        dispatchFirstOfferMs.add(now - createdAt[data.rideId]);
      }
      client.socket.setTimeout(() => {
        const sent = Date.now();
        client.emit('ride_offer_response', { offerId: data.offerId, accept: true }, (ack) => {
          acceptAckMs.add(Date.now() - sent);
          if (__ENV.DEBUG_ACK) console.log(`vu${__VU} offer ${data.offerId.slice(0, 8)} ride ${String(data.rideId).slice(0, 8)} wave ${data.waveNumber} ack ${JSON.stringify(ack)}`);
          if (ack && ack.ok === true) acceptWon.add(1, { replay: String(ack.replay === true) });
          else acceptLost.add(1, { reason: String((ack && ack.reason) || 'unknown') });
        });
      }, ACCEPT_THINK_MS + Math.random() * ACCEPT_THINK_MS);
    },
    onClose(reason) {
      if (reason === 'namespace_disconnected' || reason === 'error') dropped = true;
    },
  });
  wsSessionOk.add(res.status === 101 && opened && !dropped);
}

// ── scenario: driver location cadence ────────────────────────────────────────
export function locationScenario() {
  const ids = who();
  // Disjoint from the contention drivers so the two scenarios never share a presence key.
  const idx = (CONTENTION_DRIVERS + __VU - 1) % ids.drivers.length;
  const drv = ids.drivers[idx];
  let opened = false;
  let dropped = false;

  const res = session(API_BASE, drv.token, {
    onOpen(client) {
      client.socket.setTimeout(() => client.close(), DURATION_S * 1000);
    },
    onReady(client) {
      opened = true;
      let step = 0;
      const send = () => {
        step++;
        client.emit('driver:location', {
          lat: drv.lat + step * 0.00005,
          lng: drv.lng + step * 0.00005,
          heading: 45,
          speed: 8,
        });
        locationSent.add(1);
      };
      send();
      client.socket.setInterval(send, LOCATION_INTERVAL_MS);
    },
    onClose(reason) {
      if (reason === 'namespace_disconnected' || reason === 'error') dropped = true;
    },
  });
  wsSessionOk.add(res.status === 101 && opened && !dropped);
}
