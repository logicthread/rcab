/**
 * Dev-stack access for the demo harness (RCAB-E8.S14). TEST-HARNESS ONLY.
 *
 * Mirrors the guards of infra/load/prepare-dev.mjs: the harness refuses to run against a non-loopback
 * API, NODE_ENV=production, or a compose project that is not a dev/test one. It talks to Postgres and
 * Redis through `docker compose exec` (no host clients, no published-port assumptions) and mints
 * ordinary signed access tokens with the dev stack's own JWT_SECRET. The shipped app/API gain nothing.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

/** Repo root (apps/web/e2e/demo/lib -> up five). */
export const REPO_ROOT = resolve(__dirname, '../../../../..');

export const API_BASE = process.env.E2E_API_URL ?? 'http://localhost:3000';
export const WEB_BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

function die(msg: string): never {
  throw new Error(`[demo-harness] ${msg}`);
}

const apiHost = new URL(API_BASE).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(apiHost)) {
  die(`refusing: API host '${apiHost}' is not loopback. The demo harness is for the local dev stack only.`);
}
if (process.env.NODE_ENV === 'production') die('refusing: NODE_ENV=production.');

const project = process.env.RCAB_COMPOSE_PROJECT ?? 'rcab-dev';
if (!/(^|[-_])(dev|test)([-_]|$)/.test(project)) die(`refusing: compose project '${project}' is not a dev/test project.`);

const envFile = process.env.RCAB_ENV_FILE ?? join(REPO_ROOT, '.env.dev');
if (!existsSync(envFile)) die(`env file not found: ${envFile} (run \`pnpm dev:up\` once)`);
const env: Record<string, string> = Object.fromEntries(
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

const compose = ['compose', '-p', project, '--env-file', envFile, '-f', join(REPO_ROOT, 'infra/docker/docker-compose.dev.yml')];

/**
 * `docker compose exec` under a loaded Docker VM occasionally stalls for minutes; because these calls are
 * synchronous they would also freeze Playwright's own timers. Each attempt is bounded and retried (3 attempts).
 */
function run(service: string, args: string[], input?: string): string {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync('docker', [...compose, 'exec', '-T', service, ...args], {
      input,
      encoding: 'utf8',
      timeout: 40_000,
      killSignal: 'SIGKILL',
    });
    if (r.status === 0) return r.stdout;
    last = r.error ? `${r.error.message} (attempt ${attempt})` : r.stderr || r.stdout;
  }
  return die(`docker compose exec ${service} failed: ${last}`);
}

/** Run SQL in the dev Postgres; returns stdout (unaligned, tuples only). */
export function psql(sql: string): string {
  return run('postgres', ['psql', '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-U', PGU, '-d', PGD], sql);
}

export function redis(...args: string[]): string {
  return run('redis', ['redis-cli', ...args]).trim();
}

const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/** Short-lived ordinary access token (same claims the API signs), for a fixture user. */
export function mintAccessToken(sub: string, role: 'client' | 'driver', ttlS = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    sub,
    role,
    auth_method: 'phone',
    typ: 'access',
    iss: 'rcab',
    aud: 'rcab-api',
    iat: now,
    exp: now + ttlS,
    jti: randomUUID(),
  });
  const sig = createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * Insert a hashed refresh-token row for a fixture user (same shape AuthService.issueSession writes) and
 * return the raw token, to be placed in the browser's HttpOnly `refresh_token` cookie. The web app then
 * signs in through its normal silent-refresh path (POST /v1/auth/refresh).
 */
export function createRefreshToken(userId: string): string {
  const raw = randomBytes(48).toString('base64url');
  const hash = createHash('sha256').update(raw, 'utf8').digest('hex');
  psql(`INSERT INTO auth_refresh_token (token_hash, family_id, user_id, auth_method, expires_at)
        VALUES ('${hash}', '${randomUUID()}', '${userId}', 'phone', now() + interval '1 day');`);
  return raw;
}

/**
 * Harness-only time travel for the scheduled-ride scene: a scheduled ride is woken by a delayed BullMQ job
 * (`scheduled:wake`, due at pickup - scheduled.wakeLeadMs, i.e. >= 5 minutes after the earliest possible
 * booking). Promoting it makes the REAL wake worker run now instead of waiting. Nothing in the app/API changes.
 */
export async function promoteScheduledWake(rideId: string, generation = 1): Promise<boolean> {
  // bullmq/ioredis live in apps/api's node_modules, not in the web package.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const req = createRequire(join(REPO_ROOT, 'apps/api/package.json'));
  const { Queue } = req('bullmq');
  const queue = new Queue('scheduled-dispatch', { connection: { host: '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6379) } });
  try {
    const job = await queue.getJob(`scheduled-wake-${rideId}-g${generation}`);
    if (!job) {
      // job-id spelling is owned by apps/api/src/modules/outbox/outbox.jobs.ts; fall back to scanning delayed jobs
      const delayed = await queue.getDelayed(0, 200);
      const hit = delayed.find((j: { data?: { rideId?: string } }) => j.data?.rideId === rideId);
      if (!hit) return false;
      await hit.promote();
      return true;
    }
    await job.promote();
    return true;
  } finally {
    await queue.close();
  }
}
