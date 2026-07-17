import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as schema from '../../src/db/schema';
import { RidesRepository } from '../../src/modules/rides/rides.repository';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('RidesRepository — idempotency (real Postgres)', () => {
  let pool: Pool;
  let repo: RidesRepository;
  let passengerId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    const db = drizzle(pool, { schema });
    repo = new RidesRepository(db as never);
    // rides.passenger_id references app_user — seed a client to satisfy the FK.
    passengerId = randomUUID();
    const phone = `+91${Math.floor(Math.random() * 1e10)
      .toString()
      .padStart(10, '0')}`;
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
      [passengerId, `fb-${passengerId}`, phone],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM rides WHERE passenger_id = $1', [passengerId]);
    await pool.query('DELETE FROM app_user WHERE id = $1', [passengerId]);
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
    const driverId = randomUUID();
    await repo.claimSolo(row.id, driverId, new Date()); // → accepted, both parties bound

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
});
