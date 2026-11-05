/**
 * Stage C (R08) pool test harness — NOT a spec. Builds the real pool stack
 * (PoolLifecycleService + repositories + projection + idempotency) on its OWN
 * `pg.Pool`, so contention tests get genuinely independent Postgres
 * connections (stage-c contract §1.3 rule 9), plus fixtures and the §6
 * invariant queries C owns (I5–I7).
 */
import { Client, Pool } from 'pg';
import Redis from 'ioredis';
import { drizzle } from 'drizzle-orm/node-postgres';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { uniquePhone } from '@rcab/test-fixtures';
import * as schema from '../../src/db/schema';
import { SharedRideRepository } from '../../src/modules/matching/shared-ride.repository';
import { PoolMembershipRepository } from '../../src/modules/matching/pool-membership.repository';
import { PoolProjectionService } from '../../src/modules/matching/pool-projection.service';
import { PoolLifecycleService } from '../../src/modules/matching/pool-lifecycle.service';
import { MatchingService } from '../../src/modules/matching/matching.service';
import { IdempotencyRepository } from '../../src/modules/rides/idempotency.repository';
import type { SharedRideMember } from '../../src/db/schema';

export interface PoolStack {
  pg: Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  repo: SharedRideRepository;
  members: PoolMembershipRepository;
  projection: PoolProjectionService;
  idempotency: IdempotencyRepository;
  lifecycle: PoolLifecycleService;
  events: EventEmitter2;
  bus: {
    toPool: ReturnType<typeof vi.fn>;
    joinPool: ReturnType<typeof vi.fn>;
    toUser: ReturnType<typeof vi.fn>;
    toDriver: ReturnType<typeof vi.fn>;
  };
  matching: (scorer?: { scoreRoutes: (...a: unknown[]) => Promise<number> }) => MatchingService;
  close: () => Promise<void>;
}

/** One service stack on its own pg pool (`max` connections, default 1). */
export function buildPoolStack(
  redis: Redis,
  opts: { max?: number; config?: Record<string, unknown> } = {},
): PoolStack {
  const pg = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: opts.max ?? 1 });
  const db = drizzle(pg, { schema });
  const config = { get: vi.fn((k: string) => opts.config?.[k]) };
  const repo = new SharedRideRepository(db as never);
  const members = new PoolMembershipRepository();
  const projection = new PoolProjectionService(repo, redis);
  const idempotency = new IdempotencyRepository(db as never);
  const events = new EventEmitter2();
  const bus = {
    toPool: vi.fn(),
    joinPool: vi.fn().mockResolvedValue(undefined),
    toUser: vi.fn(),
    toDriver: vi.fn(),
  };
  const lifecycle = new PoolLifecycleService(
    db as never,
    repo,
    members,
    projection,
    idempotency,
    events,
    bus as never,
    config as never,
  );
  const matching = (scorer = { scoreRoutes: async () => 0.95 }) =>
    new MatchingService(repo, scorer as never, lifecycle, members, db as never, config as never);
  return {
    pg,
    db,
    repo,
    members,
    projection,
    idempotency,
    lifecycle,
    events,
    bus,
    matching,
    close: () => pg.end(),
  };
}

export async function seedPassenger(q: Pool | Client): Promise<string> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
    [id, `fb-pool-${id}`, uniquePhone()],
  );
  return id;
}

export const ROUTE = { originLat: 22.5727, originLng: 88.364, destLat: 22.5801, destLng: 88.3701 };

export function memberAt(passengerId: string, i = 0): SharedRideMember {
  return {
    passenger_id: passengerId,
    origin_lat: ROUTE.originLat + i * 0.0003,
    origin_lng: ROUTE.originLng + i * 0.0003,
    dest_lat: ROUTE.destLat + i * 0.0004,
    dest_lng: ROUTE.destLng - i * 0.0002,
    joined_at: new Date().toISOString(),
  };
}

/** Resolves once `n` backends are waiting on a lock (barrier for controlled interleavings). */
export async function waitForLockWaiters(
  q: Pool | Client,
  n: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    );
    if (rows[0].n >= n) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${n} lock waiters (saw ${rows[0].n})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A raw connection holding `SELECT … FOR UPDATE` on a pool row until released. */
export async function holdPoolLock(poolId: string): Promise<{ release: () => Promise<void> }> {
  const c = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
  await c.connect();
  await c.query('BEGIN');
  await c.query('SELECT 1 FROM shared_rides WHERE ride_id = $1 FOR UPDATE', [poolId]);
  return {
    release: async () => {
      await c.query('COMMIT');
      await c.end();
    },
  };
}

/**
 * §6 invariants owned by the pool slice, scoped to `poolIds` (other suites
 * share the database). Every query must return zero rows.
 */
export async function poolInvariantViolations(
  q: Pool | Client,
  poolIds: string[],
): Promise<{ I5: string[]; I6: string[]; I7: string[] }> {
  const I5 = await q.query<{ ride_id: string }>(
    `SELECT s.ride_id FROM shared_rides s
      WHERE s.ride_id = ANY($1)
        AND (s.seat_count <> (SELECT COALESCE(sum(m.seats),0) FROM pool_member m WHERE m.pool_id = s.ride_id)
             OR s.seat_count > s.max_seats)`,
    [poolIds],
  );
  const I6 = await q.query<{ pool_id: string }>(
    `SELECT m.pool_id FROM pool_member m JOIN shared_rides s ON s.ride_id = m.pool_id
      WHERE s.ride_id = ANY($1)
        AND m.active = (s.pool_state IN ('aborted','completed'))`,
    [poolIds],
  );
  const I7 = await q.query<{ ride_id: string }>(
    `SELECT s.ride_id FROM shared_rides s
      WHERE s.ride_id = ANY($1)
        AND s.pool_state IN ('closed_full','closed_timeout') AND s.dispatch_generation >= 1
        AND (NOT EXISTS (SELECT 1 FROM ride_stops t WHERE t.ride_id = s.ride_id)
             OR NOT EXISTS (SELECT 1 FROM outbox o WHERE o.topic = 'pool.dispatch.requested'
                              AND o.aggregate_id = s.ride_id
                              AND o.aggregate_generation = s.dispatch_generation))`,
    [poolIds],
  );
  return {
    I5: I5.rows.map((r) => r.ride_id),
    I6: I6.rows.map((r) => r.pool_id),
    I7: I7.rows.map((r) => r.ride_id),
  };
}

export interface PoolSnapshot {
  poolState: string;
  seatCount: number;
  maxSeats: number;
  generation: number;
  stateVersion: number;
  members: string[];
  stops: number;
  dispatchIntents: Array<{ generation: number; payload: Record<string, unknown> }>;
  expireIntents: number;
}

/** Authoritative Postgres state of one pool. */
export async function snapshot(q: Pool | Client, poolId: string): Promise<PoolSnapshot> {
  const s = await q.query<{
    pool_state: string;
    seat_count: number;
    max_seats: number;
    dispatch_generation: number;
    state_version: string;
  }>(
    `SELECT pool_state, seat_count, max_seats, dispatch_generation, state_version
       FROM shared_rides WHERE ride_id = $1`,
    [poolId],
  );
  const m = await q.query<{ passenger_id: string }>(
    'SELECT passenger_id FROM pool_member WHERE pool_id = $1 ORDER BY joined_at, passenger_id',
    [poolId],
  );
  const stops = await q.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM ride_stops WHERE ride_id = $1',
    [poolId],
  );
  const d = await q.query<{ aggregate_generation: number; payload: Record<string, unknown> }>(
    `SELECT aggregate_generation, payload FROM outbox
      WHERE topic = 'pool.dispatch.requested' AND aggregate_id = $1 ORDER BY id`,
    [poolId],
  );
  const e = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox WHERE topic = 'pool.expire.schedule' AND aggregate_id = $1`,
    [poolId],
  );
  const row = s.rows[0];
  return {
    poolState: row?.pool_state,
    seatCount: row?.seat_count,
    maxSeats: row?.max_seats,
    generation: row?.dispatch_generation,
    stateVersion: Number(row?.state_version),
    members: m.rows.map((r) => r.passenger_id),
    stops: stops.rows[0].n,
    dispatchIntents: d.rows.map((r) => ({
      generation: r.aggregate_generation,
      payload: r.payload,
    })),
    expireIntents: e.rows[0].n,
  };
}

export async function cleanupPools(q: Pool | Client, poolIds: string[], passengerIds: string[]) {
  await q.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [poolIds]);
  await q.query('DELETE FROM shared_rides WHERE ride_id = ANY($1)', [poolIds]);
  await q.query('DELETE FROM idempotency_record WHERE principal_id = ANY($1)', [passengerIds]);
  await q.query('DELETE FROM app_user WHERE id = ANY($1)', [passengerIds]);
}
