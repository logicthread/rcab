// Stage C schema (0014–0016): the durable invariants behind F05/F06/F08/F09.
// Two parts:
//   1. Invariants on the fully-migrated test DB, each exercised with real,
//      independent connections where contention matters.
//   2. Upgrade path (T36): a scratch database migrated to 0013, seeded with
//      legacy state (active trips, a double-assigned driver, an inconsistent
//      pool, an un-woken scheduled ride), then migrated through 0016.
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniquePhone } from '@rcab/test-fixtures';
import * as schema from '../../src/db/schema';
import { Constraint, pgConstraintViolation } from '../../src/db/constraints';
import { enqueueOutbox } from '../../src/modules/outbox/outbox.writer';
import { OutboxTopic } from '../../src/modules/outbox/outbox.types';

const skip = process.env.RCAB_INT_SKIPPED === '1';
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

interface PgError {
  code?: string;
  constraint?: string;
}

async function pgError(p: Promise<unknown>): Promise<PgError> {
  try {
    await p;
  } catch (err) {
    return err as PgError;
  }
  throw new Error('expected the statement to fail');
}

async function seedUser(c: Client, role: 'client' | 'driver'): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, $4)`,
    [id, `fb-${id}`, uniquePhone(), role],
  );
  if (role === 'driver') await c.query(`INSERT INTO driver (user_id) VALUES ($1)`, [id]);
  return id;
}

async function seedSoloRide(
  c: Client,
  passengerId: string,
  extra: { status?: string; driverId?: string | null; type?: string; scheduledFor?: Date } = {},
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO rides (passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, fare_cents,
                        status, type, scheduled_for, idempotency_key, driver_id, accepted_at,
                        idempotency_operation)
     VALUES ($1, 12.97, 77.59, 12.93, 77.62, 15000, $2, $3, $4, $5, $6,
             CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END,
             CASE WHEN $3 = 'scheduled' THEN 'ride.create.scheduled' ELSE 'ride.create.solo' END)
     RETURNING id`,
    [
      passengerId,
      extra.status ?? 'requested',
      extra.type ?? 'normal',
      extra.scheduledFor ?? null,
      `idem-${randomUUID()}`,
      extra.driverId ?? null,
    ],
  );
  return rows[0].id;
}

async function seedPool(
  c: Client,
  opts: { state?: string; maxSeats?: number; seatCount?: number; members?: unknown[]; claimedBy?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await c.query(
    `INSERT INTO shared_rides (ride_id, seat_count, max_seats, pool_state, origin_lat, origin_lng,
                               dest_lat, dest_lng, members, claimed_by_driver_id, claimed_at)
     VALUES ($1, $2, $3, $4, 12.97, 77.59, 12.93, 77.62, $5::jsonb, $6,
             CASE WHEN $6::uuid IS NULL THEN NULL ELSE now() END)`,
    [
      id,
      opts.seatCount ?? 0,
      opts.maxSeats ?? 3,
      opts.state ?? 'open',
      JSON.stringify(opts.members ?? []),
      opts.claimedBy ?? null,
    ],
  );
  return id;
}

function member(passengerId: string): Record<string, unknown> {
  return {
    passenger_id: passengerId,
    origin_lat: 12.97,
    origin_lng: 77.59,
    dest_lat: 12.93,
    dest_lng: 77.62,
    joined_at: new Date().toISOString(),
  };
}

async function addMember(c: Client, poolId: string, passengerId: string): Promise<void> {
  await c.query(
    `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng)
     VALUES ($1, $2, 12.97, 77.59, 12.93, 77.62)`,
    [poolId, passengerId],
  );
}

describe.skipIf(skip)('Stage C schema invariants (0014–0016)', () => {
  let c: Client;
  let c2: Client;

  beforeAll(async () => {
    c = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    c2 = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    await Promise.all([c.connect(), c2.connect()]);
  });

  afterAll(async () => {
    await Promise.all([c?.end(), c2?.end()]);
  });

  it('records 0014–0016 as applied', async () => {
    const { rows } = await c.query<{ name: string }>(
      `SELECT name FROM _rcab_migrations WHERE name >= '0014' ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      '0014_dispatch_offer_assignment.sql',
      '0015_outbox.sql',
      '0016_pool_membership.sql',
    ]);
  });

  describe('driver_active_assignment (F06)', () => {
    it('one driver cannot hold a solo ride and a shared ride at once', async () => {
      const driverId = await seedUser(c, 'driver');
      const passengerId = await seedUser(c, 'client');
      const rideId = await seedSoloRide(c, passengerId);
      const poolId = await seedPool(c, { state: 'closed_full' });

      await c.query(
        `INSERT INTO driver_active_assignment (driver_id, solo_ride_id, dispatch_generation)
         VALUES ($1, $2, 1)`,
        [driverId, rideId],
      );
      const err = await pgError(
        c.query(
          `INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation)
           VALUES ($1, $2, 1)`,
          [driverId, poolId],
        ),
      );
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('driver_active_assignment_pkey');
    });

    it('one trip cannot be assigned to two drivers', async () => {
      const [d1, d2] = [await seedUser(c, 'driver'), await seedUser(c, 'driver')];
      const poolId = await seedPool(c, { state: 'closed_full' });
      await c.query(
        `INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation)
         VALUES ($1, $2, 1)`,
        [d1, poolId],
      );
      const err = await pgError(
        c.query(
          `INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation)
           VALUES ($1, $2, 1)`,
          [d2, poolId],
        ),
      );
      expect(err.code).toBe('23505');
      expect(err.constraint).toBe('driver_active_assignment_shared_ride_id_key');
    });

    it('concurrent claims by one driver on two trips: exactly one commits', async () => {
      const driverId = await seedUser(c, 'driver');
      const passengerId = await seedUser(c, 'client');
      const rideId = await seedSoloRide(c, passengerId);
      const poolId = await seedPool(c, { state: 'closed_full' });

      await c.query('BEGIN');
      await c2.query('BEGIN');
      await c.query(
        `INSERT INTO driver_active_assignment (driver_id, solo_ride_id, dispatch_generation)
         VALUES ($1, $2, 1)`,
        [driverId, rideId],
      );
      const second = c2
        .query(
          `INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation)
           VALUES ($1, $2, 1)`,
          [driverId, poolId],
        )
        .then(
          () => null,
          (e: PgError) => e,
        );
      await c.query('COMMIT');
      const err = await second;
      await c2.query('ROLLBACK');
      expect(err?.code).toBe('23505');

      const { rows } = await c.query(
        `SELECT solo_ride_id FROM driver_active_assignment WHERE driver_id = $1`,
        [driverId],
      );
      expect(rows).toEqual([{ solo_ride_id: rideId }]);
    });

    it('requires exactly one trip reference', async () => {
      const driverId = await seedUser(c, 'driver');
      const err = await pgError(
        c.query(
          `INSERT INTO driver_active_assignment (driver_id, dispatch_generation) VALUES ($1, 1)`,
          [driverId],
        ),
      );
      expect(err.constraint).toBe('driver_active_assignment_one_trip_check');
    });
  });

  describe('dispatch_offer (F05)', () => {
    async function offer(driverId: string, rideId: string, generation = 1): Promise<string> {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO dispatch_offer (trip_kind, ride_id, driver_id, dispatch_generation, expires_at)
         VALUES ('solo', $1, $2, $3, now() + interval '12 seconds') RETURNING id`,
        [rideId, driverId, generation],
      );
      return rows[0].id;
    }

    it('a driver holds at most one live offer; a resolved one frees the slot', async () => {
      const driverId = await seedUser(c, 'driver');
      const passengerId = await seedUser(c, 'client');
      const r1 = await seedSoloRide(c, passengerId);
      const r2 = await seedSoloRide(c, passengerId);
      const first = await offer(driverId, r1);

      const err = await pgError(offer(driverId, r2));
      expect(err.constraint).toBe('dispatch_offer_one_live_per_driver_uq');

      await c.query(
        `UPDATE dispatch_offer SET state = 'expired', resolved_at = now() WHERE id = $1`,
        [first],
      );
      await expect(offer(driverId, r2)).resolves.toBeTypeOf('string');
    });

    it('a trip generation is offered to a driver once and accepted once', async () => {
      const [d1, d2] = [await seedUser(c, 'driver'), await seedUser(c, 'driver')];
      const passengerId = await seedUser(c, 'client');
      const rideId = await seedSoloRide(c, passengerId);
      const o1 = await offer(d1, rideId);
      await c.query(
        `UPDATE dispatch_offer SET state = 'declined', resolved_at = now() WHERE id = $1`,
        [o1],
      );
      const dup = await pgError(offer(d1, rideId));
      expect(dup.constraint).toBe('dispatch_offer_solo_driver_uq');

      // A new generation may re-offer the same driver.
      const o1g2 = await offer(d1, rideId, 2);
      const o2 = await offer(d2, rideId, 2);
      await c.query(
        `UPDATE dispatch_offer SET state = 'accepted', resolved_at = now() WHERE id = $1`,
        [o1g2],
      );
      const second = await pgError(
        c.query(`UPDATE dispatch_offer SET state = 'accepted', resolved_at = now() WHERE id = $1`, [
          o2,
        ]),
      );
      expect(second.constraint).toBe('dispatch_offer_solo_one_accept_uq');
    });

    it('rejects an offer whose trip reference does not match its kind', async () => {
      const driverId = await seedUser(c, 'driver');
      const passengerId = await seedUser(c, 'client');
      const rideId = await seedSoloRide(c, passengerId);
      const err = await pgError(
        c.query(
          `INSERT INTO dispatch_offer (trip_kind, ride_id, driver_id, dispatch_generation, expires_at)
           VALUES ('shared', $1, $2, 1, now() + interval '12 seconds')`,
          [rideId, driverId],
        ),
      );
      expect(err.constraint).toBe('dispatch_offer_trip_matches_kind_check');
    });

    it('rejects an offer to an unknown driver', async () => {
      const passengerId = await seedUser(c, 'client');
      const rideId = await seedSoloRide(c, passengerId);
      const err = await pgError(offer(randomUUID(), rideId));
      expect(err.code).toBe('23503');
    });
  });

  describe('outbox (F08)', () => {
    it('dedupe_key admits one row per intent', async () => {
      const rideId = randomUUID();
      const insert = (): Promise<unknown> =>
        c.query(
          `INSERT INTO outbox (topic, aggregate_type, aggregate_id, aggregate_generation, dedupe_key)
           VALUES ('ride.dispatch.requested', 'ride', $1, 1, $2)`,
          [rideId, `ride.dispatch.requested:${rideId}:g1`],
        );
      await insert();
      const err = await pgError(insert());
      expect(err.constraint).toBe('outbox_dedupe_key_uq');
    });

    it('rejects malformed topics and half-set leases', async () => {
      const bad = await pgError(
        c.query(
          `INSERT INTO outbox (topic, aggregate_type, aggregate_id, dedupe_key)
           VALUES ('Ride:Dispatch', 'ride', $1, $2)`,
          [randomUUID(), randomUUID()],
        ),
      );
      expect(bad.constraint).toBe('outbox_topic_format_check');
      const lease = await pgError(
        c.query(
          `INSERT INTO outbox (topic, aggregate_type, aggregate_id, dedupe_key, lease_token)
           VALUES ('ride.dispatch.requested', 'ride', $1, $2, gen_random_uuid())`,
          [randomUUID(), randomUUID()],
        ),
      );
      expect(lease.constraint).toBe('outbox_lease_pair_check');
    });
  });

  describe('shared Stage C helpers', () => {
    it('enqueueOutbox is idempotent on the dedupe key inside a transaction', async () => {
      const pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
      const db = drizzle(pool, { schema });
      const rideId = randomUUID();
      const message = {
        topic: OutboxTopic.RideDispatchRequested,
        aggregateType: 'ride' as const,
        aggregateId: rideId,
        generation: 1,
        payload: { rideId },
      };
      try {
        const results = await db.transaction(async (tx) => [
          await enqueueOutbox(tx, message),
          await enqueueOutbox(tx, message),
        ]);
        expect(results).toEqual([true, false]);
        const { rows } = await c.query(
          `SELECT dedupe_key, payload FROM outbox WHERE aggregate_id = $1`,
          [rideId],
        );
        expect(rows).toEqual([
          { dedupe_key: `ride.dispatch.requested:${rideId}:g1`, payload: { rideId } },
        ]);
      } finally {
        await pool.end();
      }
    });

    it('pgConstraintViolation reads the constraint through drizzle errors', async () => {
      const pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
      const db = drizzle(pool, { schema });
      const poolId = await seedPool(c, { state: 'closed_full' });
      const p = await seedUser(c, 'client');
      try {
        const err = await pgError(
          db.insert(schema.poolMember).values({
            poolId,
            passengerId: p,
            originLat: 1,
            originLng: 1,
            destLat: 1,
            destLng: 1,
          }),
        );
        expect(pgConstraintViolation(err)).toEqual({
          code: '23514',
          constraint: Constraint.PoolNotOpen,
        });
      } finally {
        await pool.end();
      }
    });
  });

  describe('pool_member (F09)', () => {
    it('seat_count is derived from membership and capped at max_seats', async () => {
      const poolId = await seedPool(c, { maxSeats: 2 });
      const [p1, p2, p3] = [
        await seedUser(c, 'client'),
        await seedUser(c, 'client'),
        await seedUser(c, 'client'),
      ];
      await addMember(c, poolId, p1);
      await addMember(c, poolId, p2);
      const err = await pgError(addMember(c, poolId, p3));
      expect(err.constraint).toBe('shared_rides_seat_capacity_check');

      const { rows } = await c.query(
        `SELECT seat_count, (SELECT count(*)::int FROM pool_member WHERE pool_id = $1) AS members
           FROM shared_rides WHERE ride_id = $1`,
        [poolId],
      );
      expect(rows[0]).toEqual({ seat_count: 2, members: 2 });
    });

    it('oversubscribed concurrent joiners on independent connections: capacity holds', async () => {
      const poolId = await seedPool(c, { maxSeats: 1 });
      const [p1, p2] = [await seedUser(c, 'client'), await seedUser(c, 'client')];
      await c.query('BEGIN');
      await c2.query('BEGIN');
      await addMember(c, poolId, p1);
      const second = addMember(c2, poolId, p2).then(
        () => null,
        (e: PgError) => e,
      );
      await c.query('COMMIT');
      const err = await second;
      await c2.query('ROLLBACK');
      // The loser blocked on the pool row lock, then failed the capacity CHECK
      // against the winner's committed seat_count.
      expect(err?.constraint).toBe('shared_rides_seat_capacity_check');
      const { rows } = await c.query(
        `SELECT seat_count FROM shared_rides WHERE ride_id = $1`,
        [poolId],
      );
      expect(rows[0].seat_count).toBe(1);
    });

    it('a passenger is in a pool once and in one non-terminal pool at a time', async () => {
      const [poolA, poolB] = [await seedPool(c), await seedPool(c)];
      const p = await seedUser(c, 'client');
      await addMember(c, poolA, p);
      const dup = await pgError(addMember(c, poolA, p));
      expect(dup.constraint).toBe('pool_member_pkey');
      const other = await pgError(addMember(c, poolB, p));
      expect(other.constraint).toBe('pool_member_one_active_pool_uq');

      // A terminal pool releases the passenger.
      await c.query(`UPDATE shared_rides SET pool_state = 'aborted' WHERE ride_id = $1`, [poolA]);
      await addMember(c, poolB, p);
      const { rows } = await c.query(
        `SELECT pool_id, active, left_at IS NOT NULL AS left FROM pool_member
          WHERE passenger_id = $1 ORDER BY active`,
        [p],
      );
      expect(rows).toEqual([
        { pool_id: poolA, active: false, left: true },
        { pool_id: poolB, active: true, left: false },
      ]);
    });

    it('a closed pool rejects new members', async () => {
      const poolId = await seedPool(c, { state: 'closed_timeout' });
      const p = await seedUser(c, 'client');
      const err = await pgError(addMember(c, poolId, p));
      expect(err.code).toBe('23514');
      expect(err.constraint).toBe('pool_member_pool_open');
    });

    it('state_version increments on every pool update; cascade delete is clean', async () => {
      const poolId = await seedPool(c);
      const p = await seedUser(c, 'client');
      await addMember(c, poolId, p);
      await c.query(`UPDATE shared_rides SET pool_state = 'closed_full' WHERE ride_id = $1`, [
        poolId,
      ]);
      const { rows } = await c.query(
        `SELECT state_version::int AS v FROM shared_rides WHERE ride_id = $1`,
        [poolId],
      );
      expect(rows[0].v).toBe(2);
      await c.query(`DELETE FROM shared_rides WHERE ride_id = $1`, [poolId]);
      const left = await c.query(`SELECT 1 FROM pool_member WHERE pool_id = $1`, [poolId]);
      expect(left.rowCount).toBe(0);
    });
  });
});

describe.skipIf(skip)('Stage C upgrade path from 0013 (T36)', () => {
  const dbName = `stagec_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Client;
  let c: Client;

  async function applyMigrations(predicate: (file: string) => boolean): Promise<void> {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files.filter(predicate)) {
      await c.query(await readFile(join(MIGRATIONS_DIR, file), 'utf-8'));
      await c.query('INSERT INTO _rcab_migrations (name) VALUES ($1)', [file]);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.TEST_POSTGRES_URI });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.TEST_POSTGRES_URI ?? '');
    url.pathname = `/${dbName}`;
    c = new Client({ connectionString: url.toString() });
    await c.connect();
    await c.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await c.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await c.query(
      `CREATE TABLE _rcab_migrations (id serial PRIMARY KEY, name text NOT NULL UNIQUE,
                                      ran_at timestamptz NOT NULL DEFAULT now())`,
    );
    await applyMigrations((f) => f < '0014');
  });

  afterAll(async () => {
    await c?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  it('backfills guards, membership, seat counts and wakes; inventories conflicts', async () => {
    // Legacy state, as the pre-Stage-C code could leave it.
    const okDriver = await seedUser(c, 'driver');
    const doubleDriver = await seedUser(c, 'driver');
    const ghostDriver = randomUUID(); // never registered as a driver
    const [p1, p2, p3] = [
      await seedUser(c, 'client'),
      await seedUser(c, 'client'),
      await seedUser(c, 'client'),
    ];
    const ghostPassenger = randomUUID();

    const okRide = await seedSoloRide(c, p1, { status: 'en_route', driverId: okDriver });
    const doubleRide = await seedSoloRide(c, p1, { status: 'accepted', driverId: doubleDriver });
    const ghostRide = await seedSoloRide(c, p2, { status: 'accepted', driverId: ghostDriver });
    const doneRide = await seedSoloRide(c, p2, { status: 'completed', driverId: okDriver });
    const scheduled = await seedSoloRide(c, p3, {
      type: 'scheduled',
      scheduledFor: new Date(Date.now() + 3_600_000),
    });

    // F09 repro shape: three members, seat_count 2; p1 listed twice.
    const skewedPool = await seedPool(c, {
      state: 'closed_full',
      maxSeats: 3,
      seatCount: 2,
      members: [member(p1), member(p2), member(p1), member(ghostPassenger), { passenger_id: 'x' }],
      claimedBy: doubleDriver,
    });
    // p2 is also in an older open pool → two non-terminal pools.
    const olderPool = await seedPool(c, { state: 'open', seatCount: 1, members: [member(p2)] });
    await c.query(
      `UPDATE shared_rides SET members = jsonb_set(members, '{0,joined_at}', to_jsonb($2::text))
        WHERE ride_id = $1`,
      [olderPool, new Date(Date.now() - 60_000).toISOString()],
    );
    const overPool = await seedPool(c, {
      state: 'completed',
      maxSeats: 1,
      seatCount: 1,
      members: [member(p3), member(p1)],
    });

    await applyMigrations((f) => f >= '0014');

    // Guards: only the unambiguous, known-driver trip is guarded.
    const guards = await c.query(
      `SELECT driver_id, solo_ride_id, shared_ride_id, dispatch_generation
         FROM driver_active_assignment ORDER BY driver_id`,
    );
    expect(guards.rows).toEqual([
      { driver_id: okDriver, solo_ride_id: okRide, shared_ride_id: null, dispatch_generation: 1 },
    ]);
    void doneRide;

    const conflicts = await c.query<{ migration: string; kind: string; subject: Record<string, string> }>(
      `SELECT migration, kind, subject FROM migration_conflict ORDER BY migration, kind`,
    );
    const kinds = conflicts.rows.map((r) => `${r.migration.slice(0, 4)}:${r.kind}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        '0014:assignment_unknown_driver',
        '0014:driver_multiple_active_trips',
        '0016:pool_member_malformed',
        '0016:pool_member_unknown_passenger',
        '0016:pool_member_duplicate_in_pool',
        '0016:passenger_multiple_active_pools',
        '0016:pool_over_capacity',
        '0016:pool_seat_count_mismatch',
      ]),
    );
    const unknownDriver = conflicts.rows.find((r) => r.kind === 'assignment_unknown_driver');
    expect(unknownDriver?.subject).toEqual({ trip_kind: 'solo', trip_id: ghostRide });
    const multi = conflicts.rows.find((r) => r.kind === 'driver_multiple_active_trips');
    expect(multi?.subject).toEqual({ driver_id: doubleDriver });
    void doubleRide;

    // Membership is the authority for seat_count; capacity is never exceeded.
    const pools = await c.query(
      `SELECT ride_id, seat_count, max_seats,
              (SELECT count(*)::int FROM pool_member m WHERE m.pool_id = s.ride_id) AS members,
              dispatch_generation
         FROM shared_rides s WHERE ride_id = ANY($1) ORDER BY ride_id`,
      [[skewedPool, olderPool, overPool]],
    );
    for (const row of pools.rows) {
      expect(row.seat_count).toBe(row.members);
      expect(row.seat_count).toBeLessThanOrEqual(row.max_seats);
    }
    const skewed = pools.rows.find((r) => r.ride_id === skewedPool);
    expect(skewed).toMatchObject({ seat_count: 2, members: 2, dispatch_generation: 1 });
    const over = pools.rows.find((r) => r.ride_id === overPool);
    expect(over).toMatchObject({ seat_count: 2, max_seats: 2 });

    // p2: newest non-terminal pool keeps the active seat.
    const p2Seats = await c.query(
      `SELECT pool_id, active FROM pool_member WHERE passenger_id = $1 ORDER BY active DESC`,
      [p2],
    );
    expect(p2Seats.rows).toEqual([
      { pool_id: skewedPool, active: true },
      { pool_id: olderPool, active: false },
    ]);
    // Terminal pool members are inactive.
    const overMembers = await c.query(
      `SELECT bool_or(active) AS any_active FROM pool_member WHERE pool_id = $1`,
      [overPool],
    );
    expect(overMembers.rows[0].any_active).toBe(false);

    // Un-woken scheduled ride: generation 0 + a re-armed wake intent.
    const wake = await c.query(
      `SELECT r.dispatch_generation, o.topic, o.aggregate_generation, o.dedupe_key, o.processed_at
         FROM rides r JOIN outbox o ON o.aggregate_id = r.id
        WHERE r.id = $1`,
      [scheduled],
    );
    expect(wake.rows).toEqual([
      {
        dispatch_generation: 0,
        topic: 'ride.wake.schedule',
        aggregate_generation: 1,
        dedupe_key: `ride.wake.schedule:${scheduled}:g1`,
        processed_at: null,
      },
    ]);
  });
});
