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
});
