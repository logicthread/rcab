// Collision-free unique test data. Integration specs share one Postgres per run
// with global UNIQUE constraints on `phone_e164` and `reg_no`; the old
// `Math.random()`-based generators (9000-wide spaces) collided ~10% of the time
// across a full run, flaking specs like "duplicate reg_no → 409".
//
// Both derive from randomUUID per call — no shared counter (vitest isolates the
// module per test file, so a counter would reset and collide across files).
import { randomUUID } from 'node:crypto';

/** Unique E.164-shaped phone: `+91` + a 10-digit suffix seeded from randomUUID
 *  (~1e10 space → collision prob negligible over a full run). */
export function uniquePhone(): string {
  const n = parseInt(randomUUID().replace(/-/g, '').slice(0, 12), 16) % 10_000_000_000;
  return `+91${String(n).padStart(10, '0')}`;
}

/** Unique vehicle registration number, e.g. `KA-01-TST-a1b2c3d4`. */
export function uniqueRegNo(prefix = 'KA-01-TST'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
