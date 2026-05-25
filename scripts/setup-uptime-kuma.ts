/**
 * Idempotent bootstrap for Uptime Kuma: creates admin account and
 * adds the /v1/health/ready HTTP monitor if it doesn't exist.
 *
 * Usage: pnpm setup:uptime-kuma
 */

import { io } from 'socket.io-client';

const KUMA_URL = process.env.KUMA_URL ?? 'http://localhost:3003';
const KUMA_USER = process.env.KUMA_USER ?? 'admin';
const KUMA_PASS = process.env.KUMA_PASS ?? 'admin1234!';
const MONITOR_URL = process.env.KUMA_MONITOR_URL ?? 'http://api:3000/v1/health/ready';

function log(msg: string): void {
  console.log(`[setup-uptime-kuma] ${msg}`);
}

async function waitForKuma(maxAttempts = 30): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(KUMA_URL);
      if (res.ok || res.status === 302) return;
    } catch {
      // not ready yet
    }
    log(`waiting for Uptime Kuma... (${i}/${maxAttempts})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Uptime Kuma did not become ready');
}

async function needsSetup(): Promise<boolean> {
  const res = await fetch(`${KUMA_URL}/api/entry-page`);
  const data = (await res.json()) as { type: string };
  return data.type === 'setup';
}

function connectSocket(): Promise<ReturnType<typeof io>> {
  return new Promise((resolve, reject) => {
    const socket = io(KUMA_URL, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 10_000);
  });
}

function emit(
  socket: ReturnType<typeof io>,
  event: string,
  ...args: unknown[]
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.emit(event, ...args, (res: { ok: boolean; msg?: string; [k: string]: unknown }) => {
      if (res.ok) resolve(res);
      else reject(new Error(res.msg ?? `${event} failed`));
    });
    setTimeout(() => reject(new Error(`${event} timeout`)), 10_000);
  });
}

async function run(): Promise<void> {
  await waitForKuma();

  const socket = await connectSocket();
  log('connected to Uptime Kuma socket');

  try {
    if (await needsSetup()) {
      log('running initial setup...');
      await emit(socket, 'setup', KUMA_USER, KUMA_PASS);
      log('admin account created');
    } else {
      log('already set up — logging in...');
      await emit(socket, 'login', { username: KUMA_USER, password: KUMA_PASS, token: '' });
      log('logged in');
    }

    const monitorList = (await emit(socket, 'getMonitorList')) as {
      [id: string]: { name: string };
    };
    const existing = Object.values(monitorList).find(
      (m) => m.name === 'API Health',
    );

    if (existing) {
      log('monitor "API Health" already exists — skipping');
    } else {
      log('adding HTTP monitor for /v1/health/ready...');
      await emit(socket, 'add', {
        type: 'http',
        name: 'API Health',
        url: MONITOR_URL,
        method: 'GET',
        interval: 60,
        retryInterval: 60,
        maxretries: 3,
        accepted_statuscodes: ['200-299'],
        active: true,
      });
      log('monitor created');
    }
  } finally {
    socket.disconnect();
  }

  log('done');
}

run().catch((err) => {
  console.error('[setup-uptime-kuma] fatal:', err);
  process.exit(1);
});
