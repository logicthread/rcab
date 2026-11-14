// Scene definitions for the ops/monitoring videos (M01-M05 browser scenes; M06 is the terminal replay).
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium, recordScene, startK6, sleep, scrollDown, sh, log, prepareLoad } from './lib.mjs';
import { URLS, GRAFANA, KUMA, AM, DEV_NETWORK, ROOT, WORK_DIR } from './config.mjs';
import { runTerminalScene } from './terminal.mjs';

// ---------------------------------------------------------------- helpers

/** Log in to Grafana once, off-camera, and reuse the session (the cred is the dev-compose default). */
async function grafanaSession() {
  const file = join(WORK_DIR, 'grafana-state.json');
  const b = await chromium.launch({ headless: true });
  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    // API login (same endpoint the login form posts to): robust against Grafana UI redirects; the cookie lands in the context.
    const res = await ctx.request.post(`${URLS.grafana}/login`, { data: { user: GRAFANA.user, password: GRAFANA.pass }, timeout: 20000 });
    if (!res.ok()) throw new Error(`grafana login failed: HTTP ${res.status()}`);
    await ctx.storageState({ path: file });
  } finally {
    await b.close();
  }
  return file;
}

const dash = (uid, slug, q = '') => `${URLS.grafana}/d/${uid}/${slug}?orgId=1&from=now-5m&to=now&refresh=5s${q}`;

async function grafanaWait(page, ms = 2500) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="data-testid Panel header title"], [data-testid*="Panel header"]', { timeout: 20000 }).catch(() => {});
  await sleep(ms);
}

// ---------------------------------------------------------------- M01 Grafana

export const M01 = {
  id: 'M01', slug: 'grafana-dashboards', title: 'Grafana: API and dispatch dashboards under load',
  card: ['Grafana :3001 (dev login admin / admin) - provisioned folder "rcab"', 'k6 workload in Area C feeds Overview, Dispatch, Redis, Postgres',
    'Shows: ride_state_transition (requested -> dispatching -> accepted/cancelled), dispatch outcomes, outbox, route-template HTTP p95'],
  states: 'requested -> dispatching -> accepted -> cancelled (k6 riders), offer won / lost (trip_taken)',
  regen: 'pnpm demo:record:ops -- --scenes M01',
  async run() {
    const state = await grafanaSession();
    prepareLoad(); // synchronous: do it before the camera rolls
    // Start k6 BEFORE recording and let Prometheus collect ~40 s, so panels already have a curve when the camera starts.
    const k6 = startK6({ name: 'm01', duration: '115s', scenarios: 'quote,ride_create,offer_contention,driver_location' });
    await sleep(40000);
    const out = await recordScene(this, async (page, cap) => {
      await cap('Overview dashboard: request rate, error rate, p50/p95/p99, active drivers (refresh 5 s, k6 traffic from Area C)');
      await page.goto(dash('rcab-overview', 'overview', '&kiosk'));
      await grafanaWait(page, 7000);
      await cap('Dispatch dashboard: dispatch latency by stage and outcome counters (offer_won / no_driver / expired ...)');
      await page.goto(dash('rcab-dispatch', 'dispatch', '&kiosk'));
      await grafanaWait(page, 6500);
      await scrollDown(page, { steps: 1, px: 300, pause: 500 });
      await cap('Ride state transitions (from -> to) and pool joins / closures: the business state machine as a metric');
      await sleep(6500);
      await scrollDown(page, { steps: 1, px: 300, pause: 500 });
      await cap('Outbox backlog / oldest pending age / publish results: the transactional-outbox health panels');
      await sleep(6500);
      await scrollDown(page, { steps: 1, px: 300, pause: 500 });
      await cap('HTTP p95 by ROUTE TEMPLATE (/v1/rides/:id, not raw URLs): bounded label cardinality');
      await sleep(7000);
      await cap('Redis dashboard (redis_exporter): memory, ops/sec, blocked clients');
      await page.goto(dash('rcab-redis', 'redis', '&kiosk'));
      await grafanaWait(page, 5500);
      await cap('Postgres dashboard (postgres_exporter): connections, locks, longest transaction');
      await page.goto(dash('rcab-postgres', 'postgres', '&kiosk'));
      await grafanaWait(page, 5500);
      await cap('Back to Overview: same load, a minute later (k6 stops shortly after; rates then decay to zero)');
      await page.goto(dash('rcab-overview', 'overview', '&kiosk'));
      await grafanaWait(page, 5000);
    }, { storageState: state });
    await k6;
    return out;
  },
};

// ---------------------------------------------------------------- M02 Prometheus

const promGraph = (expr, tab = 1, range = '5m') =>
  `${URLS.prometheus}/graph?g0.expr=${encodeURIComponent(expr)}&g0.tab=${tab}&g0.range_input=${range}&g0.step_input=10`;

export const M02 = {
  id: 'M02', slug: 'prometheus-targets-and-queries', title: 'Prometheus: targets and business-metric queries',
  card: ['Prometheus :9090 - scrape targets api / redis / postgres', 'rcab_dispatch_outcome_total, rcab_ride_state_transition_total,',
    'http_request_duration_seconds p95 by route template', 'Alert rules: ApiHighErrorRate, ApiHighP99Latency'],
  states: 'dispatch outcomes (offer_won, expired, ...) and ride state transitions as counters',
  regen: 'pnpm demo:record:ops -- --scenes M02',
  async run() {
    prepareLoad();
    return recordScene(this, async (page, cap) => {
      const k6 = startK6({ name: 'm02', duration: '50s', scenarios: 'quote,ride_create,offer_contention' });
      await cap('Status > Targets: the api (/metrics, 10 s), redis and postgres exporter jobs are UP');
      await page.goto(`${URLS.prometheus}/targets`);
      await sleep(5500);
      await cap('Business metric: rcab_dispatch_outcome_total by outcome and kind (table)');
      await page.goto(promGraph('sum by (outcome, kind) (rcab_dispatch_outcome_total)', 1));
      await sleep(5500);
      await cap('Same metric as a rate graph: sum by (outcome) (rate(...[1m])) while k6 offers rides');
      await page.goto(promGraph('sum by (outcome) (rate(rcab_dispatch_outcome_total[1m]))', 0));
      await sleep(6000);
      await cap('Ride state machine as a counter: rcab_ride_state_transition_total by (from, to)');
      await page.goto(promGraph('sum by (from, to) (rcab_ride_state_transition_total)', 1));
      await sleep(6000);
      await cap('HTTP latency: p95 by route TEMPLATE (histogram_quantile over http_request_duration_seconds_bucket)');
      await page.goto(promGraph('histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[1m])))', 1));
      await sleep(6000);
      await cap('Drivers and websockets: rcab_active_drivers, rcab_busy_drivers, rcab_ws_connections');
      await page.goto(promGraph('{__name__=~"rcab_active_drivers|rcab_busy_drivers|rcab_ws_connections"}', 1));
      await sleep(5000);
      await cap('Alerts: the two rules shipped in infra/observability/alert_rules.yml (inactive = healthy)');
      await page.goto(`${URLS.prometheus}/alerts`);
      await sleep(5500);
      await k6;
    });
  },
};

// ---------------------------------------------------------------- M03 Loki by request id

export const M03 = {
  id: 'M03', slug: 'loki-logs-by-request-id', title: 'Loki: trace one request through the logs',
  card: ['Every API response carries x-request-id (created in middleware, or taken from the caller)', 'Grafana Logs dashboard + Explore find the exact log line',
    'LogQL: {container=~".*api.*"} | json | request_id = "<id>"'],
  states: 'POST /v1/rides/quote (200) and an unauthenticated GET (401), found by request id',
  regen: 'pnpm demo:record:ops -- --scenes M03',
  async run() {
    const state = await grafanaSession();
    const stamp = Date.now();
    const ridOk = `ops-demo-quote-${stamp}`;
    const ridBad = `ops-demo-401-${stamp}`;
    prepareLoad();
    return recordScene(this, async (page, cap) => {
      const tokens = JSON.parse(readFileSync(join(ROOT, 'infra/load/tokens.generated.json'), 'utf8'));
      const c = tokens.clients[0];
      const body = { type: 'normal', originLat: tokens.base.lat, originLng: tokens.base.lng, destLat: tokens.base.lat + 0.018, destLng: tokens.base.lng + 0.012 };
      await cap(`Make two requests with our own x-request-id headers: ${ridOk} (quote) and ${ridBad} (no token)`);
      const r1 = await fetch(`${URLS.api}/v1/rides/quote`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.token}`, 'x-request-id': ridOk }, body: JSON.stringify(body) });
      const r2 = await fetch(`${URLS.api}/v1/rides/${'00000000-0000-4000-8000-000000000000'}`, { headers: { 'x-request-id': ridBad } });
      log(`quote -> ${r1.status} (echoed ${r1.headers.get('x-request-id')}); unauth GET -> ${r2.status}`);
      await page.goto('about:blank');
      await page.setContent(`<body style="margin:0;background:#070b14;color:#e8eefc;font:22px/1.6 ui-monospace,Menlo,monospace;padding:70px">
        <div style="color:#7fb0ff;font-weight:700">$ curl -si -H 'x-request-id: ${ridOk}' -X POST ${URLS.api}/v1/rides/quote ...</div>
        <div>HTTP ${r1.status}  x-request-id: ${r1.headers.get('x-request-id')}</div><br>
        <div style="color:#7fb0ff;font-weight:700">$ curl -si -H 'x-request-id: ${ridBad}' ${URLS.api}/v1/rides/0000...</div>
        <div>HTTP ${r2.status}  x-request-id: ${r2.headers.get('x-request-id')}</div><br>
        <div style="color:#9fb3d6;font-size:18px">promtail ships container stdout to Loki every few seconds ...</div></body>`);
      await sleep(11000); // promtail -> loki latency
      await cap('Logs dashboard: type/paste the id into the "Request ID" variable (pre-filled here via var-request_id)');
      await page.goto(dash('rcab-logs', 'logs', `&var-request_id=${encodeURIComponent(ridOk)}`));
      await grafanaWait(page, 7000);
      await cap(`Same dashboard for the 401: ${ridBad}`);
      await page.goto(dash('rcab-logs', 'logs', `&var-request_id=${encodeURIComponent(ridBad)}`));
      await grafanaWait(page, 6500);
      await cap('Explore (Loki datasource): LogQL filters on the parsed JSON field, so request_id is NOT a high-cardinality label');
      const expr = `{container=~".*api.*"} | json | request_id = \`${ridOk}\``;
      const panes = { a: { datasource: 'loki', queries: [{ refId: 'A', expr, queryType: 'range', datasource: { type: 'loki', uid: 'loki' } }], range: { from: 'now-15m', to: 'now' } } };
      await page.goto(`${URLS.grafana}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`);
      await sleep(7000);
      await cap('Expand the log line: route, status, duration_ms and request_id are the parsed pino fields');
      const row = page.locator('[data-testid="logs-row"], [class*="logs-row"]').first();
      await row.click({ timeout: 4000 }).catch(() => {});
      await sleep(7000);
    }, { storageState: state });
  },
};

// ---------------------------------------------------------------- M04 Uptime Kuma

export const M04 = {
  id: 'M04', slug: 'uptime-kuma-monitors', title: 'Uptime Kuma: external-style health monitors',
  card: ['Uptime Kuma 1.x - HTTP monitors against /v1/health/ready and friends', 'Throwaway instance on :3013 (dev-only creds admin / admin1234!)',
    'One deliberately failing monitor shows what DOWN looks like'],
  states: 'monitor UP (green) vs DOWN (red); heartbeat history; response-time chart',
  regen: 'pnpm demo:record:ops -- --scenes M04',
  async run() {
    const url = `http://localhost:${KUMA.port}`;
    sh('docker', ['rm', '-f', KUMA.container], { allowFail: true });
    sh('docker', ['run', '-d', '--name', KUMA.container, '--network', DEV_NETWORK, '-p', `127.0.0.1:${KUMA.port}:3001`, 'louislam/uptime-kuma:1']);
    try {
      const env = { ...process.env, KUMA_URL: url, KUMA_USER: KUMA.user, KUMA_PASS: KUMA.pass };
      sh('pnpm', ['exec', 'tsx', 'scripts/setup-uptime-kuma.ts'], { env });
      sh('pnpm', ['exec', 'tsx', 'scripts/demo/ops/kuma-monitors.ts'], { env });
      log('waiting 70 s for heartbeats to accumulate');
      await sleep(70000);
      return await recordScene(this, async (page, cap) => {
        await cap('Login page (first-run setup was done by scripts/setup-uptime-kuma.ts; dev-only creds admin / admin1234!)');
        await page.goto(`${url}/dashboard`);
        await page.waitForSelector('input#floatingInput, input[name="username"], input[type="text"]', { timeout: 20000 });
        await sleep(1200);
        await page.fill('input#floatingInput, input[name="username"], input[type="text"]', KUMA.user);
        await page.fill('input#floatingPassword, input[name="password"], input[type="password"]', KUMA.pass);
        await sleep(800);
        await page.click('button[type="submit"]');
        await cap('Dashboard: every monitor GREEN except the deliberate 404 monitor (RED); the bar is the heartbeat history');
        await page.waitForSelector('.monitor-list, .item', { timeout: 20000 }).catch(() => {});
        await sleep(7000);
        await cap('Open "API Health" (GET /v1/health/ready, accepted 200-299): uptime %, avg response time, live chart');
        await page.locator('text=API Health').first().click({ timeout: 5000 }).catch(() => {});
        await sleep(8000);
        await cap('Open the deliberately failing monitor: DOWN with the HTTP 404 reason in the event list');
        await page.locator('text=Deliberate failure').first().click({ timeout: 5000 }).catch(() => {});
        await sleep(8000);
        await cap('Maintenance windows, notifications and public status pages live under the same UI (not configured in Phase 0)');
        await page.goto(`${url}/maintenance`);
        await sleep(5000);
      });
    } finally {
      sh('docker', ['rm', '-f', '-v', KUMA.container], { allowFail: true });
    }
  },
};

// ---------------------------------------------------------------- M05 Alertmanager

export const M05 = {
  id: 'M05', slug: 'alertmanager-alert-rules', title: 'Alert rules to Alertmanager',
  card: ['Prometheus evaluates infra/observability/alert_rules.yml every 15 s', 'Alertmanager :9093 has no host port - a throwaway socat forward is used',
    'A clearly labelled demo alert is injected to show the Alertmanager UI', 'Phase 0: receiver "default" has no notifier configured'],
  states: 'alert inactive -> pending -> firing -> grouped in Alertmanager -> resolved',
  regen: 'pnpm demo:record:ops -- --scenes M05',
  async run() {
    const am = `http://localhost:${AM.port}`;
    sh('docker', ['rm', '-f', AM.container], { allowFail: true });
    sh('docker', ['run', '-d', '--name', AM.container, '--network', DEV_NETWORK, '-p', `127.0.0.1:${AM.port}:9093`, 'alpine/socat',
      'tcp-listen:9093,fork,reuseaddr', 'tcp:alertmanager:9093']);
    const post = (endsInMs) => fetch(`${am}/api/v2/alerts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{
        labels: { alertname: 'RcabDemoAlert', severity: 'warning', source: 'scripts/demo/ops' },
        annotations: { summary: 'Injected by the onboarding video harness - not a real incident', description: 'Shows how a Prometheus alert appears in Alertmanager. Auto-resolves.' },
        startsAt: new Date(Date.now() - 1000).toISOString(), endsAt: new Date(Date.now() + endsInMs).toISOString(),
      }]),
    });
    try {
      await sleep(2500);
      return await recordScene(this, async (page, cap) => {
        await cap('Prometheus > Alerts: ApiHighErrorRate (5xx > 1% for 5 m, critical) and ApiHighP99Latency (p99 > 1.5 s for 10 m, warning)');
        await page.goto(`${URLS.prometheus}/alerts`);
        await sleep(4500);
        await page.locator('text=ApiHighErrorRate').first().click({ timeout: 4000 }).catch(() => {});
        await sleep(4500);
        await cap('Prometheus > Status > Configuration: alerting.alertmanagers -> alertmanager:9093 (inside the compose network)');
        await page.goto(`${URLS.prometheus}/config`);
        await sleep(5500);
        await cap('Alertmanager UI (via the throwaway port forward): nothing firing in a healthy stack');
        await page.goto(am);
        await sleep(4500);
        await cap('Inject a labelled demo alert (POST /api/v2/alerts) - the same API Prometheus uses');
        await post(10 * 60 * 1000);
        await page.reload();
        await sleep(6000);
        await cap('Alert grouped by alertname with labels + annotations; silence / expire actions available');
        await page.locator('text=RcabDemoAlert').first().click({ timeout: 4000 }).catch(() => {});
        await sleep(5000);
        await cap('Status tab: route (group_by alertname, group_wait 30 s, repeat 4 h) and receiver "default" - no notifier yet (Phase-0 gap)');
        await page.goto(`${am}/#/status`);
        await sleep(2500);
        await scrollDown(page, { steps: 4, px: 420, pause: 1800 });
        await cap('Resolve the demo alert (endsAt = now): the list empties');
        await post(-1000);
        await page.goto(am);
        await sleep(6000);
      });
    } finally {
      await post(-1000).catch(() => {});
      sh('docker', ['rm', '-f', AM.container], { allowFail: true });
    }
  },
};

// ---------------------------------------------------------------- M06 terminal tooling

export const M06 = {
  id: 'M06', slug: 'dev-tooling-terminal', title: 'Dev tooling in the terminal',
  card: ['pnpm dev:smoke / obs:smoke - stack and metrics health', 'pnpm system:probe --ci - host capability and port check',
    'redis-inspect and pool-inspect (.claude/skills) - presence, BullMQ, pools', 'pnpm policy:doc:check - POLICY.md drift gate',
    'scripts/recovery/backup-rehearsal.sh - backup + restore drill on fixture data'],
  states: 'n/a (operational tooling). Commands are really executed; output is replayed with typing',
  regen: 'pnpm demo:record:ops -- --scenes M06',
  async run() {
    prepareLoad();
    return runTerminalScene(this);
  },
};

export const SCENES = { M01, M02, M03, M04, M05, M06 };
