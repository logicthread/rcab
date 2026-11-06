import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { uniquePhone } from '@rcab/test-fixtures';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/db/schema';
import { RidesRepository } from '../../src/modules/rides/rides.repository';
import { OutboxRepository } from '../../src/modules/outbox/outbox.repository';
import { DispatchReconciler } from '../../src/modules/outbox/dispatch-reconciler.service';
import { rearmScheduledRide } from '../../src/modules/scheduled/scheduled-retry';
import { hardFailJobId, wave2JobId } from '../../src/modules/outbox/outbox.jobs';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function redisConn() {
  const u = new URL(process.env.TEST_REDIS_URL!);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null as null };
}

/**
 * RCAB-E8.S8: a scheduled ride that never got a driver is RETRIED (new
 * generation, fresh window, no cap) instead of expiring. Real Postgres + Redis.
 */
describe.skipIf(skip)('scheduled ride retry (Postgres + BullMQ)', () => {
  const prefix = `t-${randomUUID().slice(0, 8)}`;
  const config = { get: vi.fn().mockReturnValue(undefined) };
  let pg: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ridesRepo: RidesRepository;
  let dispatchQ: Queue;
  let scheduledQ: Queue;
  let matchingQ: Queue;
  let reconciler: DispatchReconciler;
  const queues: Queue[] = [];
  const clientIds: string[] = [];
  const driverIds: string[] = [];

  const mkQueue = (name: string): Queue => {
    const q = new Queue(name, { connection: redisConn(), prefix });
    queues.push(q);
    return q;
  };
  async function newClient(): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1,$2,$3,'client')`,
      [id, `fb-sr-${id}`, uniquePhone()],
    );
    clientIds.push(id);
    return id;
  }
  async function newDriver(): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1,$2,$3,'driver')`,
      [id, `fb-sr-${id}`, uniquePhone()],
    );
    await pg.query(`INSERT INTO driver (user_id) VALUES ($1)`, [id]);
    driverIds.push(id);
    return id;
  }
  /** A scheduled ride already woken at `generation`, last touched `ageS` seconds ago. */
  async function wokenRide(generation = 1, ageS = 300, type: 'scheduled' | 'normal' = 'scheduled') {
    const passenger = await newClient();
    const { row } = await ridesRepo.create({
      passengerId: passenger,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: `idem-${randomUUID()}`,
      ...(type === 'scheduled'
        ? { type: 'scheduled' as const, scheduledFor: new Date(Date.now() + 3_600_000) }
        : {}),
    });
    await pg.query(
      `UPDATE rides SET dispatch_generation = $2, updated_at = now() - ($3::int * interval '1 second') WHERE id = $1`,
      [row.id, generation, ageS],
    );
    return row;
  }
  async function offer(rideId: string, generation: number, offeredAgoS: number, live = false) {
    const driver = await newDriver();
    await pg.query(
      `INSERT INTO dispatch_offer (trip_kind, ride_id, driver_id, dispatch_generation, wave_number, offered_at, expires_at)
       VALUES ('solo', $1, $2, $3, 1, now() - ($4::int * interval '1 second'),
               now() - ($4::int * interval '1 second') + ($5::int * interval '1 second'))`,
      [rideId, driver, generation, offeredAgoS, live ? offeredAgoS + 60 : 12],
    );
    return driver;
  }
  const ride = async (id: string) =>
    (await pg.query(`SELECT status, dispatch_generation FROM rides WHERE id = $1`, [id])).rows[0];
  /** Retry intents only (the create-time wake / first dispatch intents are excluded). */
  const intents = async (id: string) =>
    (
      await pg.query(
        `SELECT topic, aggregate_generation, processed_at FROM outbox WHERE aggregate_id = $1 AND topic = 'ride.dispatch.requested' AND aggregate_generation >= 2
         ORDER BY aggregate_generation`,
        [id],
      )
    ).rows;

  beforeAll(() => {
    pg = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 6 });
    db = drizzle(pg, { schema });
    ridesRepo = new RidesRepository(db as never);
    dispatchQ = mkQueue('dispatch');
    scheduledQ = mkQueue('scheduled-dispatch');
    matchingQ = mkQueue('matching');
    reconciler = new DispatchReconciler(
      db as never,
      new OutboxRepository(db as never),
      dispatchQ as never,
      scheduledQ as never,
      matchingQ as never,
      config as never,
    );
  });

  afterAll(async () => {
    await pg
      .query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM rides WHERE passenger_id = ANY($1))', [clientIds])
      .catch(() => undefined);
    await pg.query('DELETE FROM dispatch_offer WHERE driver_id = ANY($1)', [driverIds]).catch(() => undefined);
    await pg.query('DELETE FROM rides WHERE passenger_id = ANY($1)', [clientIds]).catch(() => undefined);
    await pg.query('DELETE FROM app_user WHERE id = ANY($1)', [[...clientIds, ...driverIds]]).catch(() => undefined);
    for (const q of queues) await q.obliterate({ force: true }).catch(() => undefined);
    await Promise.allSettled(queues.map((q) => q.close()));
    await pg.end().catch(() => undefined);
  });

  describe('rearmScheduledRide', () => {
    it('bumps the generation, revokes live offers and writes the new generation intent atomically; ride stays requested', async () => {
      const r = await wokenRide(1, 0);
      const driver = await offer(r.id, 1, 5, true);

      const out = await rearmScheduledRide(db as never, r.id, 1);
      expect(out).toMatchObject({
        previousGeneration: 1,
        generation: 2,
        retryCount: 1,
        firstRetry: true,
        passengerId: r.passengerId,
      });
      expect(out!.revokedOffers.map((o) => o.driverId)).toEqual([driver]);
      expect(await ride(r.id)).toEqual({ status: 'requested', dispatch_generation: 2 });
      const live = await pg.query(`SELECT 1 FROM dispatch_offer WHERE ride_id = $1 AND state = 'offered'`, [r.id]);
      expect(live.rowCount).toBe(0);
      expect(await intents(r.id)).toMatchObject([
        { topic: 'ride.dispatch.requested', aggregate_generation: 2, processed_at: null },
      ]);
    });

    it('is repeatable with no cap: every closed window yields the next generation, only the first is "first"', async () => {
      const r = await wokenRide(1, 0);
      const seen: Array<[number, boolean]> = [];
      for (let g = 1; g <= 6; g++) {
        const out = await rearmScheduledRide(db as never, r.id, g);
        seen.push([out!.generation, out!.firstRetry]);
      }
      expect(seen).toEqual([
        [2, true],
        [3, false],
        [4, false],
        [5, false],
        [6, false],
        [7, false],
      ]);
      expect((await intents(r.id)).map((i) => i.aggregate_generation)).toEqual([2, 3, 4, 5, 6, 7]);
    });

    it('a duplicate timer for the same window re-arms once (generation guard)', async () => {
      const r = await wokenRide(1, 0);
      const results = await Promise.all([
        rearmScheduledRide(db as never, r.id, 1),
        rearmScheduledRide(db as never, r.id, 1),
        rearmScheduledRide(db as never, r.id, 1),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await ride(r.id)).dispatch_generation).toBe(2);
      expect(await intents(r.id)).toHaveLength(1);
    });

    it('a legacy job without a generation means "current"', async () => {
      const r = await wokenRide(3, 0);
      const out = await rearmScheduledRide(db as never, r.id);
      expect(out?.generation).toBe(4);
    });

    it.each([
      ['a normal ride', () => wokenRide(1, 0, 'normal')],
      ['an un-woken scheduled ride (generation 0)', () => wokenRide(0, 0)],
      [
        'a cancelled ride',
        async () => {
          const r = await wokenRide(1, 0);
          await pg.query(`UPDATE rides SET status = 'cancelled' WHERE id = $1`, [r.id]);
          return r;
        },
      ],
      [
        'an accepted ride',
        async () => {
          const r = await wokenRide(1, 0);
          const d = await newDriver();
          await pg.query(`UPDATE rides SET status = 'accepted', driver_id = $2 WHERE id = $1`, [r.id, d]);
          return r;
        },
      ],
    ])('does nothing for %s', async (_n, make) => {
      const r = await make();
      const before = await ride(r.id);
      expect(await rearmScheduledRide(db as never, r.id, before.dispatch_generation)).toBeNull();
      expect(await ride(r.id)).toEqual(before);
      expect(await intents(r.id)).toHaveLength(0);
    });

    it('waits for a concurrent cancel (row lock) and then re-arms nothing', async () => {
      const r = await wokenRide(1, 0);
      const holder = await pg.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM rides WHERE id = $1 FOR UPDATE`, [r.id]);
        const pending = rearmScheduledRide(db as never, r.id, 1);
        await new Promise((res) => setTimeout(res, 150));
        await holder.query(`UPDATE rides SET status = 'cancelled' WHERE id = $1`, [r.id]);
        await holder.query('COMMIT');
        expect(await pending).toBeNull();
      } finally {
        holder.release();
      }
      expect((await ride(r.id)).status).toBe('cancelled');
      expect(await intents(r.id)).toHaveLength(0);
    });
  });

  describe('reconciler', () => {
    it('a scheduled ride past its 4-minute window with no timer is retried under a new generation (not expired)', async () => {
      const r = await wokenRide(1, 300);
      await offer(r.id, 1, 250); // wave 1 offered 250 s ago > 240 s window
      const report = await reconciler.reconcile();
      expect(report.scheduledRetried).toBeGreaterThanOrEqual(1);
      expect(await ride(r.id)).toEqual({ status: 'requested', dispatch_generation: 2 });
      expect(await intents(r.id)).toMatchObject([{ topic: 'ride.dispatch.requested', aggregate_generation: 2 }]);
    });

    it('keeps retrying, one generation per closed window, until someone accepts or cancels (no cap)', async () => {
      const r = await wokenRide(1, 300);
      for (let expected = 2; expected <= 5; expected++) {
        await reconciler.reconcile();
        expect((await ride(r.id)).dispatch_generation).toBe(expected);
        // let the new window lapse unanswered
        await pg.query(`UPDATE rides SET updated_at = now() - interval '300 seconds' WHERE id = $1`, [r.id]);
      }
      expect((await ride(r.id)).status).toBe('requested');
    });

    it('inside the window the 60 s normal timing is NOT applied: offers 100 s old restore a ~140 s hard-fail and a ~20 s wave-2', async () => {
      const r = await wokenRide(1, 100);
      await offer(r.id, 1, 100);
      const report = await reconciler.reconcile();
      expect(report.timersRestored).toBe(2);
      expect((await ride(r.id)).dispatch_generation).toBe(1);
      const hard = (await dispatchQ.getJob(hardFailJobId(r.id, 1)))!;
      const wave2 = (await dispatchQ.getJob(wave2JobId(r.id, 1)))!;
      expect(Math.abs((hard.opts.delay ?? 0) - 140_000)).toBeLessThan(3_000);
      expect(Math.abs((wave2.opts.delay ?? 0) - 20_000)).toBeLessThan(3_000);
    });

    it('a live hard-fail timer is trusted: the window is closed by the timer, not the reconciler', async () => {
      const r = await wokenRide(1, 300);
      await offer(r.id, 1, 300);
      await dispatchQ.add('dispatch:hard-fail', { rideId: r.id, kind: 'solo', generation: 1 }, { jobId: hardFailJobId(r.id, 1), delay: 30_000 });
      await reconciler.reconcile();
      expect((await ride(r.id)).dispatch_generation).toBe(1);
      expect(await intents(r.id)).toHaveLength(0);
    });

    it('a NORMAL ride in the same state is never retried by the scheduled rule', async () => {
      const r = await wokenRide(1, 300, 'normal');
      await offer(r.id, 1, 300);
      const report = await reconciler.reconcile();
      expect(report.scheduledRetried).toBe(0);
      expect((await ride(r.id)).dispatch_generation).toBe(1);
      // the normal path restores the (already due) hard-fail timer instead
      expect(await dispatchQ.getJob(hardFailJobId(r.id, 1))).toBeDefined();
    });

    it('a cancelled scheduled ride is left alone', async () => {
      const r = await wokenRide(1, 300);
      await pg.query(`UPDATE rides SET status = 'cancelled' WHERE id = $1`, [r.id]);
      await reconciler.reconcile();
      expect((await ride(r.id)).dispatch_generation).toBe(1);
    });
  });
});
