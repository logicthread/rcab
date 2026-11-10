/**
 * Adds a few extra monitors to the THROWAWAY Uptime Kuma used by M04 (scripts/demo/ops/scenes.mjs).
 * Env: KUMA_URL, KUMA_USER, KUMA_PASS (set by the harness). Dev only.
 */
import { io } from 'socket.io-client';

const URL_ = process.env.KUMA_URL ?? 'http://localhost:3013';
const USER = process.env.KUMA_USER ?? 'admin';
const PASS = process.env.KUMA_PASS ?? 'admin1234!';

const MONITORS = [
  { name: 'API live', url: 'http://api:3000/v1/health/live' },
  { name: 'Web app', url: 'http://web:3000/' },
  { name: 'Prometheus', url: 'http://prometheus:9090/-/healthy' },
  { name: 'Grafana', url: 'http://grafana:3000/api/health' },
  { name: 'Deliberate failure (404, demo)', url: 'http://api:3000/v1/this-route-does-not-exist' },
];

const socket = io(URL_, { transports: ['websocket'] });
const emit = (event: string, ...args: unknown[]) =>
  new Promise<any>((resolve, reject) => {
    socket.emit(event, ...args, (res: any) => (res?.ok === false ? reject(new Error(res.msg ?? event)) : resolve(res)));
    setTimeout(() => reject(new Error(`${event} timeout`)), 10000);
  });

socket.on('connect', async () => {
  try {
    await emit('login', { username: USER, password: PASS, token: '' });
    for (const m of MONITORS) {
      await emit('add', {
        type: 'http', name: m.name, url: m.url, method: 'GET', interval: 20, retryInterval: 20, maxretries: 0,
        accepted_statuscodes: ['200-299'], active: true,
      });
      console.log(`[kuma-monitors] added ${m.name}`);
    }
    // Speed up the existing "API Health" monitor too (it was created with a 60 s interval).
  } catch (e) {
    console.error('[kuma-monitors] failed:', e);
    process.exitCode = 1;
  } finally {
    socket.disconnect();
  }
});
