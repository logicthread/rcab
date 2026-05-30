import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as schema from '../../src/db/schema';
import { RidesRepository } from '../../src/modules/rides/rides.repository';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// RCAB-E4.S6 — the guarded forward solo lifecycle against a real Postgres. The
// transition uses SELECT … FOR UPDATE; here we assert the happy walk stamps
// each timestamp column and the three failure classifications never write.
describe.skipIf(skip)('RidesRepository.transition — solo lifecycle (real Postgres)', () => {
  let pool: Pool;
  let repo: RidesRepository;
  let passengerId: string;
  const driverId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    repo = new RidesRepository(drizzle(pool, { schema }) as never);
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

  // A fresh ride, claimed by `driverId` so its status is 'accepted'.
  async function newAcceptedRide(): Promise<string> {
    const { row } = await repo.create({
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: `idem-${randomUUID()}`,
    });
    const bound = await repo.claimSolo(row.id, driverId, new Date());
    expect(bound?.status).toBe('accepted');
    return row.id;
  }

  it('walks accepted → en_route → arrived → in_progress → completed, stamping each timestamp', async () => {
    const id = await newAcceptedRide();

    const r1 = await repo.transition(id, driverId, 'accepted', 'en_route');
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.row.status).toBe('en_route');
      expect(r1.row.enRouteAt).toBeInstanceOf(Date);
    }

    const r2 = await repo.transition(id, driverId, 'en_route', 'arrived');
    expect(r2.ok && r2.row.status).toBe('arrived');
    if (r2.ok) expect(r2.row.arrivedAt).toBeInstanceOf(Date);

    const r3 = await repo.transition(id, driverId, 'arrived', 'in_progress');
    expect(r3.ok && r3.row.status).toBe('in_progress');
    if (r3.ok) expect(r3.row.startedAt).toBeInstanceOf(Date);

    const r4 = await repo.transition(id, driverId, 'in_progress', 'completed');
    expect(r4.ok).toBe(true);
    if (r4.ok) {
      expect(r4.row.status).toBe('completed');
      expect(r4.row.completedAt).toBeInstanceOf(Date);
      // Earlier stamps are preserved across transitions.
      expect(r4.row.enRouteAt).toBeInstanceOf(Date);
      expect(r4.row.acceptedAt).toBeInstanceOf(Date);
    }
  });

  it('rejects an out-of-order transition (fromStatus mismatch) without writing', async () => {
    const id = await newAcceptedRide();
    // Attempt arrived → in_progress while the ride is still 'accepted'.
    const res = await repo.transition(id, driverId, 'arrived', 'in_progress');
    expect(res).toEqual({ ok: false, reason: 'invalid_transition' });
    const row = await repo.findById(id);
    expect(row?.status).toBe('accepted');
    expect(row?.startedAt).toBeNull();
  });

  it('rejects a transition from a driver who is not bound (not_owner)', async () => {
    const id = await newAcceptedRide();
    const res = await repo.transition(id, randomUUID(), 'accepted', 'en_route');
    expect(res).toEqual({ ok: false, reason: 'not_owner' });
    const row = await repo.findById(id);
    expect(row?.status).toBe('accepted');
    expect(row?.enRouteAt).toBeNull();
  });

  it('returns not_found for an unknown ride id', async () => {
    const res = await repo.transition(randomUUID(), driverId, 'accepted', 'en_route');
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });
});
