import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as schema from '../../src/db/schema';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import { IdempotencyRepository } from '../../src/modules/rides/idempotency.repository';
import { PoolMembershipRepository } from '../../src/modules/matching/pool-membership.repository';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('RidesRepository — idempotency (real Postgres)', () => {
  let pool: Pool;
  let repo: RidesRepository;
  let idem: IdempotencyRepository;
  let passengerId: string;
  let otherPassengerId: string;

  async function seedClient(id: string) {
    const phone = `+91${Math.floor(Math.random() * 1e10)
      .toString()
      .padStart(10, '0')}`;
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
      [id, `fb-${id}`, phone],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    const db = drizzle(pool, { schema });
    repo = new RidesRepository(db as never);
    idem = new IdempotencyRepository(db as never);
    // rides.passenger_id references app_user — seed clients to satisfy the FK.
    passengerId = randomUUID();
    otherPassengerId = randomUUID();
    await seedClient(passengerId);
    await seedClient(otherPassengerId);
  });

  afterAll(async () => {
    const ids = [passengerId, otherPassengerId];
    await pool.query('DELETE FROM idempotency_record WHERE principal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM rides WHERE passenger_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM app_user WHERE id = ANY($1)', [ids]);
    await pool.end();
  });

  function params(key: string) {
    return {
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: key,
    };
  }

  it('inserts a requested ride on first use of an idempotency key', async () => {
    const key = `idem-${randomUUID()}`;
    const { row, created } = await repo.create(params(key));
    expect(created).toBe(true);
    expect(row.status).toBe('requested');
    expect(row.fareCents).toBe(18500);

    const found = await repo.findById(row.id);
    expect(found?.id).toBe(row.id);
  });

  it('returns the same ride (no duplicate insert) when the key is reused', async () => {
    const key = `idem-${randomUUID()}`;
    const first = await repo.create(params(key));
    const second = await repo.create(params(key));

    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);

    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM rides WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0].n).toBe(1);
  });

  // Concurrency: two requests with the SAME idempotency key genuinely in flight
  // at once (not the sequential replay above). The unique constraint +
  // onConflictDoNothing must still collapse them to a single row. RCAB-E1.S12.
  it('concurrent double-submit of one idempotency key → exactly one row, one created', async () => {
    const key = `idem-${randomUUID()}`;

    const [a, b] = await Promise.all([repo.create(params(key)), repo.create(params(key))]);

    // Exactly one insert wins; the other resolves to the same row via the
    // on-conflict fallback.
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(a.row.id).toBe(b.row.id);

    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM rides WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0].n).toBe(1);
  });

  // Concurrency: a client and the bound driver hit cancel at the same instant on
  // an `accepted` ride. `cancel()` runs SELECT … FOR UPDATE inside a transaction,
  // so on a real connection pool the two serialize — exactly one applies and the
  // loser sees a non-cancellable state. Requires real separate connections (this
  // spec uses `pg.Pool`, unlike the single-Client dispatch-pool spec). RCAB-E1.S12.
  it('concurrent client-cancel + driver-cancel → exactly one applies, state coherent', async () => {
    const { row } = await repo.create(params(`idem-${randomUUID()}`));
    // The guard (F06) references `driver`: the bound driver needs real rows.
    const driverId = randomUUID();
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'driver')`,
      [driverId, `fb-${driverId}`, `+92${String(Date.now()).slice(-10)}`],
    );
    await pool.query('INSERT INTO driver (user_id) VALUES ($1)', [driverId]);
    expect(await repo.claimSolo(row.id, driverId)).not.toBeNull(); // → accepted + guard

    const [client, driver] = await Promise.all([
      repo.cancel({
        rideId: row.id,
        actor: 'client',
        actorId: passengerId,
        isNoShow: false,
        reason: 'client bailed',
        noShowWaitMs: 300_000,
      }),
      repo.cancel({
        rideId: row.id,
        actor: 'driver',
        actorId: driverId,
        isNoShow: false,
        reason: 'driver bailed',
        noShowWaitMs: 300_000,
      }),
    ]);

    // Exactly one cancel wins; the loser sees `cancelled` (not cancellable) →
    // invalid_transition. No torn write.
    expect([client.ok, driver.ok].filter(Boolean)).toHaveLength(1);
    const loser = client.ok ? driver : client;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.reason).toBe('invalid_transition');

    const { rows } = await pool.query<{ status: string; cancelled_by: string }>(
      'SELECT status, cancelled_by FROM rides WHERE id = $1',
      [row.id],
    );
    expect(rows[0].status).toBe('cancelled');
    expect(['client', 'driver']).toContain(rows[0].cancelled_by);
    // The winning cancel released the driver's guard in the same transaction.
    const guards = await pool.query(
      'SELECT 1 FROM driver_active_assignment WHERE driver_id = $1',
      [driverId],
    );
    expect(guards.rowCount).toBe(0);
  });

  // RCAB-E6.S2: scheduled rides persist type + scheduled_for (migration 0011).
  it('persists a scheduled ride with type=scheduled and scheduled_for', async () => {
    const when = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const { row, created } = await repo.create({
      ...params(`idem-${randomUUID()}`),
      type: 'scheduled',
      scheduledFor: when,
    });

    expect(created).toBe(true);
    expect(row.type).toBe('scheduled');
    expect(row.scheduledFor?.getTime()).toBe(when.getTime());

    const { rows } = await pool.query<{ type: string; scheduled_for: Date }>(
      'SELECT type, scheduled_for FROM rides WHERE id = $1',
      [row.id],
    );
    expect(rows[0].type).toBe('scheduled');
    expect(new Date(rows[0].scheduled_for).getTime()).toBe(when.getTime());
  });
  // F07 / R05 (migration 0013): the key is scoped to (passenger, operation).
  it('the same key under two accounts → two independent rides (no global UNIQUE)', async () => {
    const key = `idem-${randomUUID()}`;
    const a = await repo.create({ ...params(key), requestFingerprint: 'fp-a' });
    const b = await repo.create({
      ...params(key),
      passengerId: otherPassengerId,
      requestFingerprint: 'fp-b',
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.row.id).not.toBe(a.row.id);
    expect(b.row.passengerId).toBe(otherPassengerId);

    // Scoped lookup never crosses accounts.
    const bobsView = await repo.findByIdempotencyScope(otherPassengerId, 'ride.create.solo', key);
    expect(bobsView?.row.id).toBe(b.row.id);
    expect(bobsView?.requestFingerprint).toBe('fp-b');
  });

  it('a duplicate in scope returns the stored fingerprint (for the caller to compare)', async () => {
    const key = `idem-${randomUUID()}`;
    await repo.create({ ...params(key), requestFingerprint: 'fp-original' });
    const dup = await repo.create({ ...params(key), requestFingerprint: 'fp-different' });
    expect(dup.created).toBe(false);
    expect(dup.requestFingerprint).toBe('fp-original');
  });

  it('the same key for solo and scheduled operations does not collide', async () => {
    const key = `idem-${randomUUID()}`;
    const solo = await repo.create(params(key));
    const sched = await repo.create({
      ...params(key),
      type: 'scheduled',
      scheduledFor: new Date(Date.now() + 3 * 3600_000),
    });
    expect(sched.created).toBe(true);
    expect(sched.row.id).not.toBe(solo.row.id);
    const { rows } = await pool.query<{ idempotency_operation: string }>(
      'SELECT idempotency_operation FROM rides WHERE id = $1',
      [sched.row.id],
    );
    expect(rows[0].idempotency_operation).toBe('ride.create.scheduled');
  });

  it('migration 0013 replaced the global unique with the scoped one', async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'rides'::regclass AND contype = 'u'`,
    );
    const names = rows.map((r) => r.conname);
    expect(names).toContain('rides_idempotency_scope_uq');
    expect(names).not.toContain('rides_idempotency_key_key');
  });

  // F15: durable claim for shared create.
  it('idempotency_record: concurrent first use → exactly one claim; scoped per principal', async () => {
    const scope = {
      principalId: passengerId,
      operation: 'ride.create.shared' as const,
      key: `k-${randomUUID()}`,
    };
    const [x, y] = await Promise.all([idem.claim(scope, 'fp'), idem.claim(scope, 'fp')]);
    expect([x.kind, y.kind].sort()).toEqual(['claimed', 'existing']);

    // Another principal with the same key claims independently.
    const other = await idem.claim({ ...scope, principalId: otherPassengerId }, 'fp-other');
    expect(other.kind).toBe('claimed');

    const resourceId = randomUUID();
    await idem.complete(scope, resourceId, { sharedRideId: resourceId, mode: 'opened' });
    const again = await idem.claim(scope, 'fp');
    expect(again).toEqual({
      kind: 'existing',
      record: {
        requestFingerprint: 'fp',
        state: 'completed',
        resourceId,
        response: { sharedRideId: resourceId, mode: 'opened' },
      },
    });

    // release only drops a pending claim, never a completed one.
    await idem.release(scope);
    expect((await idem.find(scope))?.state).toBe('completed');
    const otherScope = { ...scope, principalId: otherPassengerId };
    await idem.release(otherScope);
    expect(await idem.find(otherScope)).toBeNull();
  });
  // F15 reclaim: a pending claim stranded by a crash / failed complete().
  it('idempotency_record: stale pending claim is reclaimed by exactly one same-fingerprint retry', async () => {
    const scope = {
      principalId: passengerId,
      operation: 'ride.create.shared' as const,
      key: `k-${randomUUID()}`,
    };
    expect((await idem.claim(scope, 'fp')).kind).toBe('claimed');
    // Fresh pending → still just "existing" (409 at the controller).
    expect((await idem.claim(scope, 'fp')).kind).toBe('existing');

    await pool.query(
      `UPDATE idempotency_record SET created_at = now() - interval '2 minutes'
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [scope.principalId, scope.key],
    );
    // A different intent never takes over someone else's claim.
    expect((await idem.claim(scope, 'other-fp')).kind).toBe('existing');

    const [x, y] = await Promise.all([idem.claim(scope, 'fp'), idem.claim(scope, 'fp')]);
    expect([x.kind, y.kind].sort()).toEqual(['existing', 'reclaimed']);
    const won = [x, y].find((c) => c.kind === 'reclaimed');
    expect(
      won?.kind === 'reclaimed' && Date.now() - won.previousAttemptAt.getTime(),
    ).toBeGreaterThan(60_000);

    // Reclaiming restamped it: it is fresh again, and can then complete.
    expect((await idem.claim(scope, 'fp')).kind).toBe('existing');
    const resourceId = randomUUID();
    await idem.complete(scope, resourceId, { sharedRideId: resourceId });
    expect((await idem.find(scope))?.state).toBe('completed');
  });

  it('a completed record is never reclaimed, however old', async () => {
    const scope = {
      principalId: passengerId,
      operation: 'ride.create.shared' as const,
      key: `k-${randomUUID()}`,
    };
    await idem.claim(scope, 'fp');
    await idem.complete(scope, randomUUID(), { ok: true });
    await pool.query(
      `UPDATE idempotency_record SET created_at = now() - interval '1 day'
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [scope.principalId, scope.key],
    );
    expect((await idem.claim(scope, 'fp')).kind).toBe('existing');
  });

  it('a shared-create key resolves to EXACTLY the seat it produced (pool_member.idempotency_key, R08)', async () => {
    const members = new PoolMembershipRepository();
    const db = drizzle(pool, { schema });
    const older = randomUUID();
    const newer = randomUUID();
    for (const id of [older, newer]) {
      await pool.query(
        `INSERT INTO shared_rides (ride_id, seat_count, max_seats, pool_state, pool_closed_at,
           detour_budget_m, origin_lat, origin_lng, dest_lat, dest_lng)
         VALUES ($1, 0, 3, 'open', now() + interval '1 minute', 1500, 26.1, 91.7, 26.2, 91.8)`,
        [id],
      );
    }
    try {
      // The passenger's older seat (pool now finished) under key k-old, the
      // live seat under k-new; another passenger joins the live pool first.
      const seat = (poolId: string, passenger: string, key: string | null) =>
        pool.query(
          `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng,
             quoted_fare_cents, idempotency_key)
           VALUES ($1, $2, 26.1, 91.7, 26.2, 91.8, 4200, $3)`,
          [poolId, passenger, key],
        );
      await seat(older, passengerId, 'k-old');
      await pool.query(`UPDATE shared_rides SET pool_state = 'completed' WHERE ride_id = $1`, [older]);
      await seat(newer, otherPassengerId, null);
      await seat(newer, passengerId, 'k-new');

      expect(await members.findByIdempotencyKey(db as never, passengerId, 'k-new')).toEqual({
        poolId: newer,
        poolState: 'open',
        opened: false,
        quotedFareCents: 4200,
      });
      expect(await members.findByIdempotencyKey(db as never, passengerId, 'k-old')).toEqual({
        poolId: older,
        poolState: 'completed',
        opened: true,
        quotedFareCents: 4200,
      });
      // No time heuristic: an unknown key, or another passenger's key, finds nothing.
      expect(await members.findByIdempotencyKey(db as never, passengerId, 'k-none')).toBeNull();
      expect(await members.findByIdempotencyKey(db as never, otherPassengerId, 'k-new')).toBeNull();
    } finally {
      await pool.query('DELETE FROM shared_rides WHERE ride_id = ANY($1)', [[older, newer]]);
    }
  });
});
