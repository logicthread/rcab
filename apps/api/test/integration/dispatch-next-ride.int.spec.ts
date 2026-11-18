// Next-ride queue (migration 0020): a driver on an in-progress ride who is within the
// busy-driver ETA window may accept ONE more solo ride. It waits in
// driver_queued_assignment and becomes the active trip in the transaction that ends the
// current one. Real Postgres + Redis + BullMQ.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rearmNormalRide } from '../../src/modules/dispatch/normal-rounds';
import {
  buildDispatch,
  insertOffer,
  makeBus,
  markOnline,
  seedClient,
  seedDriver,
  seedSoloRide,
  type DispatchHarness,
} from './support/dispatch-fixtures';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function redisConn(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

describe.skipIf(skip)('next-ride queue', () => {
  let pg: Pool;
  let redis: Redis;
  let queue: Queue;
  let etaS = 300;
  let H: DispatchHarness;

  beforeAll(async () => {
    pg = new Pool({ connectionString: process.env.TEST_POSTGRES_URI!, max: 4 });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(`dispatch-next-${randomUUID().slice(0, 8)}`, {
      connection: redisConn(process.env.TEST_REDIS_URL!),
    });
    H = buildDispatch(pg, redis, queue, makeBus(), {
      one: async () => ({ distanceM: 1000, durationS: etaS }),
    });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close().catch(() => {});
    await pg?.end();
    await redis?.quit();
  });

  /** Driver D busy on an in_progress ride A, plus a requested ride B with a live offer to D. */
  async function scenario() {
    const driver = await seedDriver(pg);
    await markOnline(redis, driver);
    const a = await seedSoloRide(pg, await seedClient(pg));
    const b = await seedSoloRide(pg, await seedClient(pg));
    await pg.query(`UPDATE rides SET status='in_progress', driver_id=$2 WHERE id=$1`, [a, driver]);
    await pg.query(
      `INSERT INTO driver_active_assignment (driver_id, solo_ride_id, dispatch_generation) VALUES ($1,$2,1)`,
      [driver, a],
    );
    const offerId = await insertOffer(pg, { trip: { kind: 'solo', rideId: b }, driverId: driver });
    return { driver, a, b, offerId };
  }

  it('accepts as the NEXT ride near the end of the current one, then promotes it on completion', async () => {
    etaS = 300; // 5 min from the drop-off: inside the 10 min window
    const { driver, a, b, offerId } = await scenario();

    const res = await H.dispatch.acceptOffer({ offerId, driverId: driver });
    expect(res).toMatchObject({ ok: true, queued: true });

    const ride = await pg.query(`SELECT status, driver_id FROM rides WHERE id=$1`, [b]);
    expect(ride.rows[0]).toMatchObject({ status: 'accepted', driver_id: driver });
    const active = await pg.query(`SELECT solo_ride_id FROM driver_active_assignment WHERE driver_id=$1`, [driver]);
    expect(active.rows.map((r) => r.solo_ride_id)).toEqual([a]); // still on A
    const queued = await pg.query(`SELECT solo_ride_id FROM driver_queued_assignment WHERE driver_id=$1`, [driver]);
    expect(queued.rows.map((r) => r.solo_ride_id)).toEqual([b]);

    // The queued ride is not the driver's to advance yet.
    expect(await H.rides.transition(b, driver, 'accepted', 'en_route')).toEqual({ ok: false, reason: 'invalid_transition' });

    // A completes → B becomes the active trip in the same transaction.
    const done = await H.rides.transition(a, driver, 'in_progress', 'completed');
    expect(done).toMatchObject({ ok: true, promotedRideId: b });
    const after = await pg.query(`SELECT solo_ride_id FROM driver_active_assignment WHERE driver_id=$1`, [driver]);
    expect(after.rows.map((r) => r.solo_ride_id)).toEqual([b]);
    const left = await pg.query(`SELECT 1 FROM driver_queued_assignment WHERE driver_id=$1`, [driver]);
    expect(left.rowCount).toBe(0);
    expect(await H.rides.transition(b, driver, 'accepted', 'en_route')).toMatchObject({ ok: true });
  });

  it('refuses while the driver is still more than 10 minutes from the end of the ride', async () => {
    etaS = 40 * 60;
    const { driver, offerId } = await scenario();
    expect(await H.dispatch.acceptOffer({ offerId, driverId: driver })).toEqual({ ok: false, reason: 'driver_busy' });
  });

  it('a queued ride cancelled by its passenger leaves the queue and the driver finishes alone', async () => {
    etaS = 120;
    const { driver, a, b, offerId } = await scenario();
    expect(await H.dispatch.acceptOffer({ offerId, driverId: driver })).toMatchObject({ ok: true, queued: true });

    const passenger = (await pg.query(`SELECT passenger_id FROM rides WHERE id=$1`, [b])).rows[0].passenger_id;
    const cancelled = await H.rides.cancel({
      rideId: b,
      actor: 'client',
      actorId: passenger,
      isNoShow: false,
      reason: null,
      noShowWaitMs: 300_000,
    });
    expect(cancelled).toMatchObject({ ok: true, dequeuedDriverId: driver });
    expect((await pg.query(`SELECT 1 FROM driver_queued_assignment WHERE driver_id=$1`, [driver])).rowCount).toBe(0);

    const done = await H.rides.transition(a, driver, 'in_progress', 'completed');
    expect(done).toMatchObject({ ok: true });
    expect((done as { promotedRideId?: string }).promotedRideId).toBeUndefined();
    expect((await pg.query(`SELECT 1 FROM driver_active_assignment WHERE driver_id=$1`, [driver])).rowCount).toBe(0);
  });

  it('matching rounds: an empty round restarts matching under the next generation until the last one', async () => {
    const ride = await seedSoloRide(pg, await seedClient(pg), { generation: 1 });
    const offer = await insertOffer(pg, { trip: { kind: 'solo', rideId: ride }, driverId: await seedDriver(pg) });

    const r2 = await rearmNormalRide(H.db, ride, 1, 3);
    expect(r2).toMatchObject({ previousGeneration: 1, generation: 2 });
    expect(r2?.revokedOffers.map((o) => o.offerId)).toEqual([offer]);
    const g = await pg.query(`SELECT status, dispatch_generation FROM rides WHERE id=$1`, [ride]);
    expect(g.rows[0]).toMatchObject({ status: 'requested', dispatch_generation: 2 });
    const intent = await pg.query(
      `SELECT aggregate_generation FROM outbox WHERE topic='ride.dispatch.requested' AND aggregate_id=$1 ORDER BY aggregate_generation`,
      [ride],
    );
    expect(intent.rows.map((r) => r.aggregate_generation)).toContain(2);

    // A stale hard-fail for the old generation does nothing; round 2 -> 3 works; round 3 is the last.
    expect(await rearmNormalRide(H.db, ride, 1, 3)).toBeNull();
    expect(await rearmNormalRide(H.db, ride, 2, 3)).toMatchObject({ generation: 3 });
    expect(await rearmNormalRide(H.db, ride, 3, 3)).toBeNull();
  });
});
