#!/usr/bin/env node
// @ts-check
/**
 * system-probe.mjs — host capability + load-capacity estimator
 *
 * Usage:
 *   pnpm system:probe              # interactive, full run
 *   pnpm system:probe --ci         # non-interactive, no installs, no load phase
 *   pnpm system:probe --no-load    # interactive but skip k6
 *   pnpm system:probe --output /tmp/report.json
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { statfsSync } from 'node:fs';
import { cpus, totalmem, freemem, platform as osPlatform, release as osRelease } from 'node:os';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const { values: flags } = parseArgs({
  options: {
    ci: { type: 'boolean', default: false },
    'no-load': { type: 'boolean', default: false },
    output: { type: 'string', default: resolve(ROOT, 'system-probe-report.json') },
  },
  strict: false,
});

const CI = flags.ci;
const NO_LOAD = flags['no-load'] || CI;
const OUTPUT_PATH = flags.output;

// ---------------------------------------------------------------------------
// ANSI colour helpers
// ---------------------------------------------------------------------------
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ok = (s) => `${C.green}✓${C.reset} ${s}`;
const fail = (s) => `${C.red}✗${C.reset} ${s}`;
const warn_ = (s) => `${C.yellow}!${C.reset} ${s}`;
const info = (s) => process.stdout.write(`${C.dim}›${C.reset} ${s}\n`);

// ---------------------------------------------------------------------------
// Host inventory
// ---------------------------------------------------------------------------
export function inventoryHost() {
  const cpu = cpus();
  const ramTotalGb = Math.round((totalmem() / 1024 ** 3) * 10) / 10;
  const ramFreeGb  = Math.round((freemem()  / 1024 ** 3) * 10) / 10;

  let diskFreeGb = null;
  try {
    const stat = statfsSync('/');
    diskFreeGb = Math.round((stat.bfree * stat.bsize) / 1024 ** 3);
  } catch { /* non-POSIX host */ }

  const isLinux = osPlatform() === 'linux';
  let osName = osPlatform() === 'darwin'
    ? `macOS (Darwin ${osRelease()})`
    : `Linux ${osRelease()}`;
  if (isLinux && existsSync('/etc/os-release')) {
    const pretty = readFileSync('/etc/os-release', 'utf8')
      .split('\n')
      .find(l => l.startsWith('PRETTY_NAME='));
    if (pretty) osName = pretty.replace('PRETTY_NAME=', '').replace(/"/g, '');
  }

  return {
    os: osName,
    arch: process.arch,
    cpu_model: cpu[0]?.model ?? 'unknown',
    cpu_logical_cores: cpu.length,
    ram_total_gb: ramTotalGb,
    ram_free_gb: ramFreeGb,
    disk_free_gb: diskFreeGb,
  };
}

// ---------------------------------------------------------------------------
// Port availability
// ---------------------------------------------------------------------------
const DEV_PORTS = { api: 3000, loki: 3001, grafana: 3002, uptime_kuma: 3003, prometheus: 9090 };

function checkPort(port) {
  return new Promise(res => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => { srv.close(); res(true); });
    srv.listen(port, '127.0.0.1');
  });
}

export async function checkPorts(portMap = DEV_PORTS) {
  const results = {};
  for (const [name, port] of Object.entries(portMap)) {
    results[name] = { port, available: await checkPort(port) };
  }
  return results;
}

// ---------------------------------------------------------------------------
// Dep detection
// ---------------------------------------------------------------------------
function runCmd(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * @param {{ run?: (cmd: string, args: string[]) => string | null }} [overrides]
 */
export function detectDeps(overrides = {}) {
  const run = overrides.run ?? runCmd;

  const dockerRaw   = run('docker',  ['--version']);
  const composeRaw  = run('docker',  ['compose', 'version', '--short']);
  const nodeRaw     = run('node',    ['--version']);
  const pnpmRaw     = run('pnpm',    ['--version']);
  const gitRaw      = run('git',     ['--version']);
  const k6Raw       = run('k6',      ['version']);

  const nodeMajor = nodeRaw
    ? parseInt(nodeRaw.replace(/^v/, '').split('.')[0], 10)
    : 0;
  const nodeOk = nodeMajor >= 20;

  const deps = {
    docker:         { version: dockerRaw,  status: dockerRaw  ? 'ok' : 'missing' },
    docker_compose: { version: composeRaw, status: composeRaw ? 'ok' : 'missing' },
    node:           { version: nodeRaw,    status: nodeOk ? 'ok' : nodeRaw ? 'version_too_old' : 'missing', minimum: 'v20' },
    pnpm:           { version: pnpmRaw,    status: pnpmRaw    ? 'ok' : 'missing' },
    git:            { version: gitRaw,     status: gitRaw     ? 'ok' : 'missing' },
    k6:             { version: k6Raw,      status: k6Raw      ? 'ok' : 'missing', optional: true },
  };

  const missing = Object.entries(deps)
    .filter(([, d]) => d.status !== 'ok')
    .map(([name]) => ({ name, ...deps[name] }));

  return { deps, missing };
}

// ---------------------------------------------------------------------------
// Install hints + consent-gated prompt
// ---------------------------------------------------------------------------
const INSTALL_CMDS = {
  docker:         { darwin: 'brew install --cask docker',      linux: 'sudo apt-get install -y docker.io docker-compose-plugin' },
  docker_compose: { darwin: 'brew install docker-compose',     linux: 'sudo apt-get install -y docker-compose-plugin' },
  node:           { darwin: 'brew install node@20',            linux: 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs' },
  pnpm:           { darwin: 'corepack enable && corepack install -g pnpm@latest', linux: 'corepack enable && corepack install -g pnpm@latest' },
  git:            { darwin: 'brew install git',                linux: 'sudo apt-get install -y git' },
  k6:             { darwin: 'brew install k6',                 linux: 'sudo apt-get install -y k6' },
};

async function promptAndInstall(missing) {
  if (!missing.length) return;
  const plat = osPlatform() === 'darwin' ? 'darwin' : 'linux';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim().toLowerCase())));

  for (const { name, optional } of missing) {
    const cmd = INSTALL_CMDS[name]?.[plat];
    if (!cmd) continue;
    const tag = optional ? ' (optional)' : '';
    const answer = await ask(`\n  Missing: ${C.yellow}${name}${C.reset}${tag}\n  Install: ${C.dim}${cmd}${C.reset}\n  Proceed? [y/N] `);
    if (answer === 'y' || answer === 'yes') {
      try {
        // execa is imported dynamically so the module can be tested without it
        const { execa } = await import('execa');
        await execa('sh', ['-c', cmd], { stdio: 'inherit' });
        process.stdout.write(ok(`${name} installed\n`));
      } catch {
        process.stdout.write(fail(`install failed — run manually: ${cmd}\n`));
      }
    }
  }
  rl.close();
}

// ---------------------------------------------------------------------------
// Compose stack management
// ---------------------------------------------------------------------------
const COMPOSE_ARGS = [
  '--env-file', '.env.dev',
  '-f', 'infra/docker/docker-compose.dev.yml',
];

async function isStackRunning() {
  try {
    const { execa } = await import('execa');
    const { stdout } = await execa('docker', [...COMPOSE_ARGS, 'ps', '--format', 'json'], { cwd: ROOT });
    if (!stdout.trim()) return false;
    const lines = stdout.trim().split('\n');
    return lines.some(l => { try { return JSON.parse(l).State === 'running'; } catch { return false; } });
  } catch {
    return false;
  }
}

async function bringUpStack() {
  info('Bringing up dev stack (pnpm dev:up)…');
  const { execa } = await import('execa');
  await execa('pnpm', ['dev:up'], { cwd: ROOT, stdio: 'inherit' });

  // Poll /v1/health/ready until 200 or timeout
  info('Waiting for API to become ready…');
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://localhost:3000/v1/health/ready', { signal: AbortSignal.timeout(2000) });
      if (r.ok) { info('API is ready.'); return; }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Dev stack did not become ready within 90s');
}

async function tearDownStack() {
  if (CI) { info('CI mode — skipping teardown.'); return; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question('\n  Tear down the dev stack that was started by this probe? [y/N] ', a => { rl.close(); r(a.trim().toLowerCase()); }));
  if (answer === 'y' || answer === 'yes') {
    const { execa } = await import('execa');
    await execa('docker', [...COMPOSE_ARGS, 'down'], { cwd: ROOT, stdio: 'inherit' });
  }
}

// ---------------------------------------------------------------------------
// Load phase (k6)
// ---------------------------------------------------------------------------
const K6_SUMMARY = '/tmp/k6-probe-summary.json';
const PERF_BUDGET = { api_p95_ms: 400, quote_p95_ms: 250, dispatch_p95_ms: 3000, error_rate_max: 0.005 };

async function runLoad(k6Available) {
  if (!k6Available) return null;

  const script = resolve(ROOT, 'infra/load/probe.js');
  if (!existsSync(script)) { info(`k6 script not found at ${script} — skipping load phase`); return null; }

  info('Running k6 load scenarios (~3 min total)…');
  try {
    const { execa } = await import('execa');
    await execa('k6', [
      'run',
      `--env=SUMMARY_FILE=${K6_SUMMARY}`,
      '--env=API_BASE=http://localhost:3000',
      script,
    ], { cwd: ROOT, stdio: 'inherit' });

    if (!existsSync(K6_SUMMARY)) return null;
    const raw = JSON.parse(readFileSync(K6_SUMMARY, 'utf8'));
    return parseK6Summary(raw);
  } catch (err) {
    process.stdout.write(warn_(`Load phase failed: ${err.message}\n`));
    return null;
  }
}

function parseK6Summary(raw) {
  const m = raw.metrics ?? {};
  const get = (key, stat) => m[key]?.values?.[stat] ?? null;
  return {
    health_ready: {
      p95_ms:     get('http_req_duration{scenario:health_read}', 'p(95)') ?? get('http_req_duration', 'p(95)'),
      rps:        get('http_reqs{scenario:health_read}', 'rate')           ?? get('http_reqs', 'rate'),
      error_rate: get('http_req_failed{scenario:health_read}', 'rate')     ?? get('http_req_failed', 'rate'),
    },
    note: 'Scenarios target /v1/health/ready — re-run after E4 adds quote + dispatch routes',
  };
}

// ---------------------------------------------------------------------------
// Capacity model
// ---------------------------------------------------------------------------
export function buildCapacityModel(host, loadResult) {
  if (!loadResult?.health_ready) return null;

  const { rps, p95_ms, error_rate } = loadResult.health_ready;
  if (!rps || rps <= 0) return null;

  // Conservative: assume health/ready overhead ≈ quote path overhead
  // Sustainable RPS = measured RPS (k6 was already at moderate VU count)
  const sustainableRps = rps;

  // Phase-0 request-rate model (from performance-budget + testing-strategy):
  //   Dispatch: 50 concurrent → each ride ~30s apart → ~0.033 requests/s per driver
  //   Quote:    200 RPS shared → per driver ~2 RPS when searching (booking rate ~3/hr avg)
  // Simplified: 1 active driver ≈ 2 RPS (location + occasional booking flow)
  const concurrentDrivers  = Math.floor(sustainableRps / 2);
  const concurrentClients  = Math.floor(sustainableRps / 0.5);

  const withinBudget =
    (p95_ms ?? Infinity) <= PERF_BUDGET.api_p95_ms &&
    (error_rate ?? 1) < PERF_BUDGET.error_rate_max;

  return {
    concurrent_active_drivers: concurrentDrivers,
    concurrent_active_clients: concurrentClients,
    phase_0_budget_status: withinBudget ? 'within' : 'exceeded',
    kpi_checks: {
      api_p95_ms: { budget: PERF_BUDGET.api_p95_ms, measured: p95_ms, ok: (p95_ms ?? Infinity) <= PERF_BUDGET.api_p95_ms },
      error_rate:  { budget: PERF_BUDGET.error_rate_max, measured: error_rate, ok: (error_rate ?? 1) < PERF_BUDGET.error_rate_max },
      drivers_100: { required: 100, estimated: concurrentDrivers, ok: concurrentDrivers >= 100 },
      clients_5k:  { required: 5000, estimated: concurrentClients, ok: concurrentClients >= 5000 },
    },
    note: 'Model uses health/ready as proxy; numbers are conservative estimates until E4 routes exist.',
  };
}

// ---------------------------------------------------------------------------
// Report + terminal output
// ---------------------------------------------------------------------------
function writeReport(report) {
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  info(`Report written to ${OUTPUT_PATH}`);
}

function printSummary(report) {
  const hr = `${C.dim}${'─'.repeat(60)}${C.reset}`;
  const h = (s) => `\n${C.bold}${C.cyan}${s}${C.reset}\n`;

  process.stdout.write(`\n${C.bold}╔══════════════════════════════════╗${C.reset}\n`);
  process.stdout.write(`${C.bold}║    rcab  system  probe  report   ║${C.reset}\n`);
  process.stdout.write(`${C.bold}╚══════════════════════════════════╝${C.reset}\n`);

  // Host
  process.stdout.write(h('Host'));
  const hst = report.host;
  process.stdout.write(`  OS:    ${hst.os}\n`);
  process.stdout.write(`  CPU:   ${hst.cpu_model}  (${hst.cpu_logical_cores} logical cores)\n`);
  process.stdout.write(`  RAM:   ${hst.ram_total_gb} GB total  /  ${hst.ram_free_gb} GB free\n`);
  if (hst.disk_free_gb != null) process.stdout.write(`  Disk:  ${hst.disk_free_gb} GB free at /\n`);

  // Ports
  process.stdout.write(h('Dev Stack Ports'));
  for (const [name, { port, available }] of Object.entries(report.ports)) {
    process.stdout.write(`  ${available ? ok(`${name} :${port}`) : warn_(`${name} :${port} — in use (may be the running stack)`)}\n`);
  }

  // Deps
  process.stdout.write(h('Dependencies'));
  for (const [name, dep] of Object.entries(report.deps)) {
    const line = dep.status === 'ok'
      ? ok(`${name}  ${C.dim}${dep.version ?? ''}${C.reset}`)
      : dep.optional
        ? warn_(`${name} — ${dep.status} (optional)`)
        : fail(`${name} — ${dep.status}`);
    process.stdout.write(`  ${line}\n`);
  }

  // Load
  if (report.load) {
    process.stdout.write(h('Load Results  (health/ready proxy)'));
    const lr = report.load.health_ready;
    process.stdout.write(`  p95 latency : ${lr.p95_ms?.toFixed(1) ?? 'n/a'} ms  (budget ≤ ${PERF_BUDGET.api_p95_ms} ms)\n`);
    process.stdout.write(`  throughput  : ${lr.rps?.toFixed(1) ?? 'n/a'} req/s\n`);
    process.stdout.write(`  error rate  : ${lr.error_rate != null ? (lr.error_rate * 100).toFixed(2) + ' %' : 'n/a'}\n`);
    process.stdout.write(`  ${C.dim}${report.load.note}${C.reset}\n`);
  } else {
    process.stdout.write(h('Load Results'));
    process.stdout.write(`  ${C.dim}Skipped (--ci / --no-load / k6 not installed)${C.reset}\n`);
  }

  // Capacity envelope
  if (report.envelope) {
    const env = report.envelope;
    const badge = env.phase_0_budget_status === 'within'
      ? `${C.green}WITHIN BUDGET${C.reset}`
      : `${C.red}EXCEEDS BUDGET${C.reset}`;
    process.stdout.write(h(`Capacity Envelope  [${badge}]`));
    process.stdout.write(`  Concurrent active drivers  : ~${env.concurrent_active_drivers}\n`);
    process.stdout.write(`  Concurrent active clients  : ~${env.concurrent_active_clients}\n`);
    for (const [k, v] of Object.entries(env.kpi_checks)) {
      process.stdout.write(`  ${v.ok ? ok(k) : fail(k)}\n`);
    }
    process.stdout.write(`  ${C.dim}${env.note}${C.reset}\n`);
  }

  process.stdout.write(`\n${hr}\n`);
  process.stdout.write(`  Report : ${OUTPUT_PATH}\n`);
  process.stdout.write(`${hr}\n\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  if (!CI) process.stdout.write(`\n${C.bold}${C.cyan}rcab system probe${C.reset}  ${C.dim}(--ci for non-interactive)${C.reset}\n\n`);

  info('Inventorying host…');
  const host = inventoryHost();

  info('Checking dev-stack port availability…');
  const ports = await checkPorts();

  info('Detecting dependencies…');
  const { deps, missing } = detectDeps();

  const criticalMissing = missing.filter(m => !m.optional);
  if (!CI && missing.length > 0) {
    await promptAndInstall(missing);
    // Re-detect after potential installs
    Object.assign({ deps, missing }, detectDeps());
  }

  let stackWasUp = false;
  let loadResult = null;

  if (!NO_LOAD) {
    const k6Ok = deps.k6?.status === 'ok';
    if (!k6Ok) {
      process.stdout.write(warn_('k6 not found — skipping load phase. Install k6 to get capacity estimates.\n'));
    } else {
      stackWasUp = await isStackRunning();
      if (!stackWasUp) {
        if (criticalMissing.length > 0) {
          process.stdout.write(warn_('Critical deps missing — skipping stack bring-up and load phase.\n'));
        } else {
          await bringUpStack();
        }
      }
      if (criticalMissing.length === 0) {
        loadResult = await runLoad(k6Ok);
      }
      if (!stackWasUp) await tearDownStack();
    }
  }

  const envelope = buildCapacityModel(host, loadResult);

  const report = {
    generated: new Date().toISOString(),
    host,
    ports,
    deps,
    missing: missing.map(({ name, status, optional }) => ({ name, status, optional: optional ?? false })),
    load: loadResult,
    envelope,
  };

  writeReport(report);
  printSummary(report);

  const exitCode = criticalMissing.filter(m => !m.optional).length > 0 ? 1 : 0;
  process.exit(exitCode);
}

// Only run when executed directly, not when imported for testing
const isMain = process.argv[1] &&
  (new URL(import.meta.url).pathname === process.argv[1] ||
   process.argv[1].endsWith('system-probe.mjs'));

if (isMain) {
  main().catch(err => {
    process.stderr.write(`\n${C.red}probe error:${C.reset} ${err.message}\n`);
    process.exit(2);
  });
}
