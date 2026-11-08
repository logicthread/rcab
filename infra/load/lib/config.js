/**
 * Shared k6 configuration (RCAB-E8.S12). Import only from the init context.
 *
 *  - Budget targets come from `perf-budget.generated.json`, which `pnpm policy:doc` generates from the
 *    `perfBudget` category of apps/api/src/config/policy/policy.schema.ts. They are product decisions
 *    and live THERE; this file never hard-codes one. A single run may override a target with
 *    `k6 -e PERF_BUDGET_API_P95_MS=600 ...` (the env name is recorded next to each value).
 *  - Identities come from `tokens.generated.json`, written by `node infra/load/prepare-dev.mjs`. Those
 *    are ordinary signed access tokens for fixture users on the local dev stack (see that script for why
 *    this is not a production backdoor).
 */

const BUDGET = JSON.parse(open('../perf-budget.generated.json'));

/** A budget target by its policy key, honouring the per-run env override. */
export function budget(name) {
  const entry = BUDGET[name];
  if (!entry || typeof entry !== 'object') {
    throw new Error(`unknown perfBudget key '${name}' - run \`pnpm policy:doc\``);
  }
  const override = __ENV[entry.env];
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (!Number.isFinite(n)) throw new Error(`${entry.env}='${override}' is not a number`);
    return n;
  }
  return entry.value;
}

let tokens;
try {
  tokens = JSON.parse(open('../tokens.generated.json'));
} catch (_) {
  tokens = null;
}

/** Fixture identities; fails fast with the fix when they are missing or expired. */
export function identities() {
  if (!tokens) {
    throw new Error('infra/load/tokens.generated.json missing - run `pnpm load:prepare` (dev stack must be up)');
  }
  if (Date.parse(tokens.expiresAt) < Date.now()) {
    throw new Error(`load tokens expired at ${tokens.expiresAt} - re-run \`pnpm load:prepare\``);
  }
  return tokens;
}

export const API_BASE = __ENV.API_BASE || (tokens && tokens.apiBase) || 'http://localhost:3000';

/** `http://host` -> `ws://host` (Socket.IO's websocket transport, EIO 4). */
export function wsUrl(base) {
  return base.replace(/^http/, 'ws') + '/socket.io/?EIO=4&transport=websocket';
}

/** Which scenarios to run: `SCENARIOS=quote,ride_create,offer_contention,driver_location` (default all). */
export function selected(all) {
  const raw = (__ENV.SCENARIOS || '').trim();
  if (raw === '') return all;
  const want = raw.split(',').map((s) => s.trim());
  const unknown = want.filter((w) => all.indexOf(w) === -1);
  if (unknown.length > 0) throw new Error(`unknown SCENARIOS: ${unknown.join(',')} (known: ${all.join(',')})`);
  return want;
}

export function envInt(name, dflt) {
  const v = __ENV[name];
  if (v === undefined || v === '') return dflt;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name}='${v}' is not an integer`);
  return n;
}

/** RFC 4122 v4 from Math.random: idempotency keys need uniqueness, not secrecy. */
export function uuid4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
