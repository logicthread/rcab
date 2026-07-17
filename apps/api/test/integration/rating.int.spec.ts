import { uniquePhone } from '@rcab/test-fixtures';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as schema from '../../src/db/schema';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import { RatingRepository } from '../../src/modules/rating/rating.repository';
import { RatingService } from '../../src/modules/rating/rating.service';

const skip = process.env.RCAB_INT_SKIPPED === '1';

// RCAB-E4.S9 — two-sided rating capture against a real Postgres. Walks a solo
// ride to `completed` via the real RidesRepository, then exercises RatingService
// end-to-end: both directions persist, a duplicate is refused by the UNIQUE key,
// a non-completed ride is rejected, and the stars CHECK is a DB backstop.
describe.skipIf(skip)('RatingService.rate — two-sided capture (real Postgres)', () => {
  let pool: Pool;
  let ridesRepo: RidesRepository;
  let ratingRepo: RatingRepository;
  let service: RatingService;
  let passengerId: string;
  const driverId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
    const db = drizzle(pool, { schema }) as never;
    ridesRepo = new RidesRepository(db);
    ratingRepo = new RatingRepository(db);
    service = new RatingService(ridesRepo, ratingRepo);

    // rides.passenger_id references app_user — seed a client to satisfy the FK.
    passengerId = randomUUID();
    const phone = uniquePhone();
    await pool.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1, $2, $3, 'client')`,
      [passengerId, `fb-${passengerId}`, phone],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM ratings WHERE rater_id = $1 OR subject_id = $1', [passengerId]);
    await pool.query('DELETE FROM rides WHERE passenger_id = $1', [passengerId]);
    await pool.query('DELETE FROM app_user WHERE id = $1', [passengerId]);
    await pool.end();
  });

  // Create a ride and walk it accepted → … → completed via the real repository.
  async function completedRide(): Promise<string> {
    const { row } = await ridesRepo.create({
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: `idem-${randomUUID()}`,
    });
    await ridesRepo.claimSolo(row.id, driverId, new Date());
    await ridesRepo.transition(row.id, driverId, 'accepted', 'en_route');
    await ridesRepo.transition(row.id, driverId, 'en_route', 'arrived');
    await ridesRepo.transition(row.id, driverId, 'arrived', 'in_progress');
    await ridesRepo.transition(row.id, driverId, 'in_progress', 'completed');
    return row.id;
  }

  it('persists both directions: client→driver and driver→client', async () => {
    const rideId = await completedRide();

    const byClient = await service.rate({ rideId, raterId: passengerId, stars: 5, text: 'smooth' });
    expect(byClient.ok).toBe(true);
    if (byClient.ok) {
      expect(byClient.rating.subjectId).toBe(driverId);
      expect(byClient.rating.stars).toBe(5);
    }

    const byDriver = await service.rate({ rideId, raterId: driverId, stars: 4, text: null });
    expect(byDriver.ok).toBe(true);
    if (byDriver.ok) expect(byDriver.rating.subjectId).toBe(passengerId);

    const rows = await pool.query('SELECT * FROM ratings WHERE ride_id = $1', [rideId]);
    expect(rows.rowCount).toBe(2);
  });

  it('refuses a duplicate rating in the same direction without overwriting', async () => {
    const rideId = await completedRide();

    const first = await service.rate({ rideId, raterId: passengerId, stars: 5, text: null });
    expect(first.ok).toBe(true);

    const dup = await service.rate({ rideId, raterId: passengerId, stars: 2, text: 'changed' });
    expect(dup).toEqual({ ok: false, reason: 'already_rated' });

    const rows = await pool.query(
      'SELECT stars FROM ratings WHERE ride_id = $1 AND rater_id = $2',
      [rideId, passengerId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].stars).toBe(5);
  });

  it('rejects rating a ride that is not completed', async () => {
    const { row } = await ridesRepo.create({
      passengerId,
      originLat: 26.1,
      originLng: 91.7,
      destLat: 26.2,
      destLng: 91.8,
      fareCents: 12000,
      idempotencyKey: `idem-${randomUUID()}`,
    });
    // Still 'requested'.
    const res = await service.rate({ rideId: row.id, raterId: passengerId, stars: 5, text: null });
    expect(res).toEqual({ ok: false, reason: 'not_completed' });
  });

  it('rejects a non-party rater', async () => {
    const rideId = await completedRide();
    const res = await service.rate({ rideId, raterId: randomUUID(), stars: 5, text: null });
    expect(res).toEqual({ ok: false, reason: 'not_a_party' });
  });

  it('returns not_found for an unknown ride', async () => {
    const res = await service.rate({
      rideId: randomUUID(),
      raterId: passengerId,
      stars: 5,
      text: null,
    });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
  });

  it('enforces the stars 1..5 CHECK at the DB (defensive backstop)', async () => {
    const rideId = await completedRide();
    await expect(
      ratingRepo.insert({
        rideId,
        raterId: passengerId,
        subjectId: driverId,
        stars: 9,
        text: null,
      }),
    ).rejects.toThrow();
  });
});
