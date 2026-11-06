import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue, Worker, type Job } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { uniquePhone } from '@rcab/test-fixtures';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as schema from '../../src/db/schema';
import { RidesRepository, type RideRow } from '../../src/modules/rides/rides.repository';
import {
  SharedRideRepository,
  type SharedRideRow,
} from '../../src/modules/matching/shared-ride.repository';
import { OutboxRepository } from '../../src/modules/outbox/outbox.repository';
import { OutboxRelay } from '../../src/modules/outbox/outbox.relay';
import { DispatchReconciler } from '../../src/modules/outbox/dispatch-reconciler.service';
import { enqueueOutbox } from '../../src/modules/outbox/outbox.writer';
import { OutboxTopic } from '../../src/modules/outbox/outbox.types';
import {
  ScheduledDispatchService,
  SCHEDULED_WAKE_JOB,
} from '../../src/modules/scheduled/scheduled.service';
import {
  DispatchStartService,
  type WaveRunner,
} from '../../src/modules/dispatch/dispatch-start.service';
import { DispatchProcessor } from '../../src/modules/dispatch/dispatch.processor';
import { ScheduledDispatchProcessor } from '../../src/modules/scheduled/scheduled.processor';
import {
  DISPATCH_START_JOB,
  dispatchStartJobId,
  hardFailJobId,
  legacyHardFailJobId,
  poolExpireJobId,
  scheduledWakeJobId,
  wave2JobId,
} from '../../src/modules/outbox/outbox.jobs';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function redisConn() {
  const u = new URL(process.env.TEST_REDIS_URL!);
  return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null as null };
}

/** Records what the (slice A) wave runner was asked to do; can block or fail. */
class FakeRunner implements WaveRunner {
  solo: Array<{ rideId: string; wave: number; generation: number }> = [];
  pool: Array<{ poolId: string; wave: number; generation: number }> = [];
  gate: Promise<void> | null = null;
  failTimes = 0;
  /** Runs after the "business commit" of a wave and before it returns. */
  afterCommit: (() => Promise<void>) | null = null;
  async runSoloWave(ride: RideRow, wave: 1 | 2, generation: number): Promise<void> {
    this.solo.push({ rideId: ride.id, wave, generation });
    if (this.gate) await this.gate;
    if (this.afterCommit) await this.afterCommit();
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error('wave failed after commit');
    }
  }
  async runPoolWave(pool: SharedRideRow, wave: 1 | 2, generation: number): Promise<void> {
    this.pool.push({ poolId: pool.rideId, wave, generation });
    if (this.gate) await this.gate;
  }
}

/** Resolve once `n` parties have arrived (a controlled interleaving point). */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return async () => {
    if (++arrived >= n) release();
    await all;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('condition not reached in time');
}

describe.skipIf(skip)('outbox + durable dispatch (Postgres + Redis + BullMQ, independent connections)', () => {
  const prefix = `t-${randomUUID().slice(0, 8)}`;
  const config = { get: vi.fn().mockReturnValue(undefined) };
  const pools: Pool[] = [];
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  let redis: Redis;
  let pg: Pool; // the "app" connection pool
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let ridesRepo: RidesRepository;
  let sharedRepo: SharedRideRepository;
  let outbox: OutboxRepository;
  let dispatchQ: Queue;
  let scheduledQ: Queue;
  let matchingQ: Queue;
  let scheduled: ScheduledDispatchService;
  let relay: OutboxRelay;
  let runner: FakeRunner;
  let start: DispatchStartService;
  let processor: DispatchProcessor;
  let reconciler: DispatchReconciler;
  const clientIds: string[] = [];
  const driverIds: string[] = [];
  const dispatchService = { handleWaveTimeout: vi.fn(), handleHardFail: vi.fn() };

  const newPool = (): Pool => {
    const p = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 4 });
    pools.push(p);
    return p;
  };
  const mkQueue = (name: string): Queue => {
    const q = new Queue(name, { connection: redisConn(), prefix });
    queues.push(q);
    return q;
  };

  async function newClient(): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1,$2,$3,'client')`,
      [id, `fb-ob-${id}`, uniquePhone()],
    );
    clientIds.push(id);
    return id;
  }
  async function newDriver(): Promise<string> {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO app_user (id, firebase_uid, phone_e164, role) VALUES ($1,$2,$3,'driver')`,
      [id, `fb-ob-${id}`, uniquePhone()],
    );
    await pg.query(`INSERT INTO driver (user_id) VALUES ($1)`, [id]);
    driverIds.push(id);
    return id;
  }
  async function newRide(
    passengerId: string,
    o: { scheduled?: Date; key?: string } = {},
  ): Promise<{ row: RideRow; created: boolean }> {
    return ridesRepo.create({
      passengerId,
      originLat: 26.1445,
      originLng: 91.7362,
      destLat: 26.1758,
      destLng: 91.7898,
      fareCents: 18500,
      idempotencyKey: o.key ?? `idem-${randomUUID()}`,
      ...(o.scheduled ? { type: 'scheduled', scheduledFor: o.scheduled } : {}),
    });
  }
  const outboxRows = async (aggregateId: string) =>
    (
      await pg.query(
        `SELECT topic, aggregate_generation, attempts, processed_at, failed_at, last_error,
                lease_token, payload FROM outbox WHERE aggregate_id = $1 ORDER BY created_at`,
        [aggregateId],
      )
    ).rows;
  const rideRow = async (id: string) =>
    (await pg.query(`SELECT status, dispatch_generation FROM rides WHERE id = $1`, [id])).rows[0];
  /** Make a ride/pool look older than the reconciler's grace window. */
  const age = async (table: 'rides' | 'shared_rides', col: 'id' | 'ride_id', id: string) =>
    pg.query(`UPDATE ${table} SET updated_at = now() - interval '5 minutes' WHERE ${col} = $1`, [id]);
  const makeDue = (aggregateId: string) =>
    pg.query(
      `UPDATE outbox SET available_at = now() - interval '1 second', leased_until = NULL, lease_token = NULL
        WHERE aggregate_id = $1 AND processed_at IS NULL AND failed_at IS NULL`,
      [aggregateId],
    );
  const expireLease = (aggregateId: string) =>
    pg.query(
      `UPDATE outbox SET leased_until = now() - interval '1 second' WHERE aggregate_id = $1 AND lease_token IS NOT NULL`,
      [aggregateId],
    );

  beforeAll(async () => {
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    pg = newPool();
    db = drizzle(pg, { schema });
    ridesRepo = new RidesRepository(db as never);
    sharedRepo = new SharedRideRepository(db as never);
    outbox = new OutboxRepository(db as never);
    dispatchQ = mkQueue('dispatch');
    scheduledQ = mkQueue('scheduled-dispatch');
    matchingQ = mkQueue('matching');
    scheduled = new ScheduledDispatchService(scheduledQ as never, config as never);
    relay = new OutboxRelay(outbox, scheduled, dispatchQ as never, matchingQ as never);
    runner = new FakeRunner();
    start = new DispatchStartService(ridesRepo, sharedRepo, runner, db as never);
    processor = new DispatchProcessor(dispatchService as never, start);
    reconciler = new DispatchReconciler(
      db as never,
      outbox,
      dispatchQ as never,
      scheduledQ as never,
      matchingQ as never,
      config as never,
    );
  });

  afterAll(async () => {
    await Promise.allSettled(workers.map((w) => w.close(true)));
    await pg
      .query('DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM rides WHERE passenger_id = ANY($1))', [
        clientIds,
      ])
      .catch(() => undefined);
    await pg.query('DELETE FROM dispatch_offer WHERE driver_id = ANY($1)', [driverIds]).catch(() => undefined);
    await pg.query('DELETE FROM rides WHERE passenger_id = ANY($1)', [clientIds]).catch(() => undefined);
    await pg.query('DELETE FROM app_user WHERE id = ANY($1)', [[...clientIds, ...driverIds]]).catch(() => undefined);
    await pg.query(`DELETE FROM outbox WHERE topic LIKE 'ob.%' OR dedupe_key LIKE 'ob.%'`).catch(() => undefined);
    for (const q of queues) await q.obliterate({ force: true }).catch(() => undefined);
    await Promise.allSettled(queues.map((q) => q.close()));
    await redis.quit().catch(() => undefined);
    await Promise.allSettled(pools.map((p) => p.end()));
  });

  beforeEach(async () => {
    // Clean slate: the relay drains oldest-first across ALL pending rows, so
    // intents left over from earlier tests (or other specs) must not be
    // mistaken for, or compete with, the row under test.
    await pg.query(`UPDATE outbox SET processed_at = now(), lease_token = NULL, leased_until = NULL
                     WHERE processed_at IS NULL AND failed_at IS NULL`);
    runner.solo = [];
    runner.pool = [];
    runner.gate = null;
    runner.failTimes = 0;
    runner.afterCommit = null;
    dispatchService.handleWaveTimeout.mockReset();
    dispatchService.handleHardFail.mockReset();
  });

  // ── creation is atomic with its work intent ──────────────────────────────

  describe('ride creation writes the work intent in the same transaction (F08)', () => {
    it('normal ride: generation 1 + one ride.dispatch.requested row; scheduled ride: generation 0 + ride.wake.schedule g1', async () => {
      const p = await newClient();
      const { row: normal, created } = await newRide(p);
      expect(created).toBe(true);
      expect((await rideRow(normal.id)).dispatch_generation).toBe(1);
      expect(await outboxRows(normal.id)).toMatchObject([
        { topic: 'ride.dispatch.requested', aggregate_generation: 1, processed_at: null },
      ]);

      const when = new Date(Date.now() + 2 * 3600_000);
      const { row: sched } = await newRide(p, { scheduled: when });
      expect((await rideRow(sched.id)).dispatch_generation).toBe(0);
      const rows = await outboxRows(sched.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ topic: 'ride.wake.schedule', aggregate_generation: 1 });
      expect(rows[0].payload).toEqual({ scheduledFor: when.toISOString() });
    });

    it('a failing outbox insert rolls the ride back; the retry creates both (T23: failure before commit)', async () => {
      const p = await newClient();
      const key = `idem-${randomUUID()}`;
      await pg.query(`
        CREATE OR REPLACE FUNCTION ob_test_fail() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected outbox failure'; END $$ LANGUAGE plpgsql`);
      await pg.query(`CREATE TRIGGER ob_test_fail_trg BEFORE INSERT ON outbox
                      FOR EACH ROW EXECUTE FUNCTION ob_test_fail()`);
      try {
        await expect(newRide(p, { key })).rejects.toThrow();
      } finally {
        await pg.query(`DROP TRIGGER ob_test_fail_trg ON outbox`);
        await pg.query(`DROP FUNCTION ob_test_fail()`);
      }
      // Neither the ride nor an intent survived: no booking without its work.
      expect(
        (await pg.query(`SELECT 1 FROM rides WHERE passenger_id = $1 AND idempotency_key = $2`, [p, key])).rows,
      ).toHaveLength(0);

      const retry = await newRide(p, { key });
      expect(retry.created).toBe(true);
      expect(await outboxRows(retry.row.id)).toHaveLength(1);
    });

    it('a replay returns the original ride and writes no second intent', async () => {
      const p = await newClient();
      const key = `idem-${randomUUID()}`;
      const first = await newRide(p, { key });
      const replay = await newRide(p, { key });
      expect(replay.created).toBe(false);
      expect(replay.row.id).toBe(first.row.id);
      expect(await outboxRows(first.row.id)).toHaveLength(1);
    });

    it('concurrent identical creates on independent connections produce one ride and one intent', async () => {
      const p = await newClient();
      const key = `idem-${randomUUID()}`;
      const a = new RidesRepository(drizzle(newPool(), { schema }) as never);
      const b = new RidesRepository(drizzle(newPool(), { schema }) as never);
      const go = barrier(2);
      const params = {
        passengerId: p,
        originLat: 26.1,
        originLng: 91.7,
        destLat: 26.2,
        destLng: 91.8,
        fareCents: 100,
        idempotencyKey: key,
      };
      const [ra, rb] = await Promise.all([
        go().then(() => a.create(params)),
        go().then(() => b.create(params)),
      ]);
      expect(ra.row.id).toBe(rb.row.id);
      expect([ra.created, rb.created].filter(Boolean)).toHaveLength(1);
      expect(await outboxRows(ra.row.id)).toHaveLength(1);
    });
  });

  // ── the relay ─────────────────────────────────────────────────────────────

  describe('relay: lease / publish / ack', () => {
    it('publishes a ride.dispatch.requested row as a deterministic dispatch-start job and acks it', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      await relay.drainOnce();

      const job = await dispatchQ.getJob(dispatchStartJobId(row.id, 1));
      expect(job?.name).toBe(DISPATCH_START_JOB);
      expect(job?.data).toEqual({ kind: 'solo', tripId: row.id, generation: 1 });
      expect(job?.id).not.toContain(':');
      const [ob] = await outboxRows(row.id);
      expect(ob.processed_at).not.toBeNull();
      expect(ob.attempts).toBe(1);
      expect(ob.lease_token).toBeNull();
    });

    it('a crash after commit but before publish loses nothing: a fresh relay publishes the row (T23)', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      // "Process died": no relay ever ran for this row. A brand-new relay on
      // its own connection pool (a restart) picks it up.
      const restarted = new OutboxRelay(
        new OutboxRepository(drizzle(newPool(), { schema }) as never),
        scheduled,
        dispatchQ as never,
        matchingQ as never,
      );
      await restarted.drainOnce();
      expect(await dispatchQ.getJob(dispatchStartJobId(row.id, 1))).toBeDefined();
      expect((await outboxRows(row.id))[0].processed_at).not.toBeNull();
    });

    it('two relays on separate connections drain concurrently: every row published exactly once', async () => {
      const ids = Array.from({ length: 70 }, () => randomUUID());
      for (const id of ids) {
        await enqueueOutbox(db as never, {
          topic: OutboxTopic.RideDispatchRequested,
          aggregateType: 'ride',
          aggregateId: id,
          generation: 1,
          payload: { rideId: id },
        });
      }
      const adds = new Map<string, number>();
      const counting = (q: Queue): Queue =>
        new Proxy(q, {
          get(t, prop, r) {
            if (prop === 'add') {
              return async (name: string, data: unknown, opts: { jobId: string }) => {
                adds.set(opts.jobId, (adds.get(opts.jobId) ?? 0) + 1);
                return t.add(name, data as never, opts as never);
              };
            }
            return Reflect.get(t, prop, r);
          },
        });
      const go = barrier(2); // shared: both relays reach the lease together
      const mk = () => {
        const repo = new OutboxRepository(drizzle(newPool(), { schema }) as never);
        const realLease = repo.lease.bind(repo);
        repo.lease = async (limit, ms) => {
          await go(); // both relays reach the lease statement together
          return realLease(limit, ms);
        };
        return new OutboxRelay(repo, scheduled, counting(dispatchQ) as never, matchingQ as never);
      };
      const [r1, r2] = [mk(), mk()];
      const [x, y] = await Promise.all([r1.drainOnce(), r2.drainOnce()]);
      // Disjoint leases: the first pass handled at most one batch each, together
      // at least the 70 rows once the stragglers are drained.
      expect(x.published + y.published).toBeGreaterThan(0);
      await r1.drainOnce();
      await r1.drainOnce();

      for (const id of ids) expect(adds.get(dispatchStartJobId(id, 1))).toBe(1);
      const { rows } = await pg.query(
        `SELECT count(*)::int AS n, max(attempts) AS maxa, count(*) FILTER (WHERE processed_at IS NULL)::int AS open
           FROM outbox WHERE aggregate_id = ANY($1)`,
        [ids],
      );
      expect(rows[0]).toMatchObject({ n: 70, maxa: 1, open: 0 });
    });

    it('lease fencing: a stalled relay cannot ack or fail a row another relay took over', async () => {
      const id = randomUUID();
      await enqueueOutbox(db as never, {
        topic: OutboxTopic.RideDispatchRequested,
        aggregateType: 'ride',
        aggregateId: id,
        generation: 1,
        payload: { rideId: id },
      });
      const repoA = new OutboxRepository(drizzle(newPool(), { schema }) as never);
      const repoB = new OutboxRepository(drizzle(newPool(), { schema }) as never);

      const [leasedA] = (await repoA.lease(10, 30_000)).filter((r) => r.aggregateId === id);
      expect(leasedA).toBeDefined();
      // B cannot lease it while A's lease is live...
      expect((await repoB.lease(10, 30_000)).filter((r) => r.aggregateId === id)).toHaveLength(0);
      // ...but can once it expired (A stalled in a slow publish).
      await expireLease(id);
      const [leasedB] = (await repoB.lease(10, 30_000)).filter((r) => r.aggregateId === id);
      expect(leasedB).toBeDefined();
      expect(leasedB.leaseToken).not.toBe(leasedA.leaseToken);

      // A wakes up: both of its settlement paths are fenced out.
      expect(await repoA.ack(leasedA.id, leasedA.leaseToken)).toBe(false);
      expect(await repoA.fail(leasedA.id, leasedA.leaseToken, 'late')).toBe('lost_lease');
      expect((await outboxRows(id))[0]).toMatchObject({ processed_at: null, attempts: 2 });

      expect(await repoB.ack(leasedB.id, leasedB.leaseToken)).toBe(true);
      expect((await outboxRows(id))[0].processed_at).not.toBeNull();
    });

    it('a failed publish backs off and is retried; attempts are counted (T23: failure before publish)', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      const flaky = vi.spyOn(dispatchQ, 'add').mockRejectedValueOnce(new Error('redis down'));
      try {
        const r = await relay.drainOnce();
        expect(r.failed).toBeGreaterThanOrEqual(1);
      } finally {
        flaky.mockRestore();
      }
      let [ob] = await outboxRows(row.id);
      expect(ob).toMatchObject({ processed_at: null, failed_at: null, attempts: 1 });
      expect(ob.last_error).toContain('redis down');
      // Backed off: not immediately due again.
      expect((await relay.drainOnce()).published).toBe(0);

      await makeDue(row.id);
      await relay.drainOnce();
      [ob] = await outboxRows(row.id);
      expect(ob.processed_at).not.toBeNull();
      expect(ob.attempts).toBe(2);
      expect(await dispatchQ.getJob(dispatchStartJobId(row.id, 1))).toBeDefined();
    });

    it('publish succeeds but the ack is lost: the row is re-published, deduplicated to ONE job (T23: before ack)', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      const ack = vi.spyOn(outbox, 'ack').mockRejectedValueOnce(new Error('connection reset'));
      try {
        await relay.drainOnce();
      } finally {
        ack.mockRestore();
      }
      expect((await outboxRows(row.id))[0].processed_at).toBeNull(); // still leased, unacked
      expect(await dispatchQ.getJob(dispatchStartJobId(row.id, 1))).toBeDefined();

      await expireLease(row.id);
      await relay.drainOnce(); // publishes again; BullMQ dedups on the jobId
      expect((await outboxRows(row.id))[0].processed_at).not.toBeNull();
      const same = (await dispatchQ.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])).filter(
        (j) => j.id === dispatchStartJobId(row.id, 1),
      );
      expect(same).toHaveLength(1);
    });

    it('an unknown topic is exhausted at once with last_error=unknown_topic and never retried in a loop', async () => {
      const id = randomUUID();
      await pg.query(
        `INSERT INTO outbox (topic, aggregate_type, aggregate_id, aggregate_generation, payload, dedupe_key)
         VALUES ('ob.unknown_thing', 'ride', $1, 1, '{}', $2)`,
        [id, `ob.unknown_thing:${id}:g1`],
      );
      await relay.drainOnce();
      const [ob] = await outboxRows(id);
      expect(ob).toMatchObject({ attempts: 1, last_error: 'unknown_topic' });
      expect(ob.failed_at).not.toBeNull();
      await relay.drainOnce();
      expect((await outboxRows(id))[0].attempts).toBe(1);
    });

    it('rows exhaust at max_attempts; rearm makes them publishable again (reconciler / operator)', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      await pg.query(`UPDATE outbox SET max_attempts = 2 WHERE aggregate_id = $1`, [row.id]);
      const boom = vi.spyOn(dispatchQ, 'add').mockRejectedValue(new Error('queue gone'));
      try {
        await relay.drainOnce();
        await makeDue(row.id);
        await relay.drainOnce();
      } finally {
        boom.mockRestore();
      }
      let [ob] = await outboxRows(row.id);
      expect(ob.failed_at).not.toBeNull();
      expect(ob.attempts).toBe(2);
      expect((await outbox.stats()).exhausted).toBeGreaterThanOrEqual(1);
      await relay.drainOnce();
      expect((await outboxRows(row.id))[0].attempts).toBe(2); // exhausted rows are not retried

      expect(await outbox.rearm({ topic: OutboxTopic.RideDispatchRequested, aggregateId: row.id, generation: 1 })).toBe(true);
      await relay.drainOnce();
      [ob] = await outboxRows(row.id);
      expect(ob.processed_at).not.toBeNull();
      expect(ob.failed_at).toBeNull();
      expect(await dispatchQ.getJob(dispatchStartJobId(row.id, 1))).toBeDefined();
    });

    it('rearm leaves a pending row alone and reports false only when no row exists', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      const rearm = (id: string, g = 1) =>
        outbox.rearm({ topic: OutboxTopic.RideDispatchRequested, aggregateId: id, generation: g });
      expect(await rearm(row.id)).toBe(true); // pending
      expect((await outboxRows(row.id))[0].attempts).toBe(0);
      expect(await rearm(row.id, 9)).toBe(false);
      expect(await rearm(randomUUID())).toBe(false);
    });

    it('kick() drains promptly without waiting for the poll', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      delete process.env.RCAB_DISABLE_OUTBOX_RELAY;
      try {
        relay.kick();
        relay.kick(); // debounced
        await until(async () => (await outboxRows(row.id))[0].processed_at !== null);
      } finally {
        process.env.RCAB_DISABLE_OUTBOX_RELAY = '1';
      }
    });

    it('publishes ride.wake.schedule as a delayed colon-free wake and pool.expire.schedule to the matching queue', async () => {
      const p = await newClient();
      const when = new Date(Date.now() + 2 * 3600_000);
      const { row } = await newRide(p, { scheduled: when });
      const poolId = randomUUID();
      await enqueueOutbox(db as never, {
        topic: OutboxTopic.PoolExpireSchedule,
        aggregateType: 'shared_ride',
        aggregateId: poolId,
        generation: 0,
        payload: { expireAt: new Date(Date.now() + 60_000).toISOString() },
      });
      await relay.drainOnce();

      const wake = await scheduledQ.getJob(scheduledWakeJobId(row.id, 1));
      expect(wake?.name).toBe(SCHEDULED_WAKE_JOB);
      expect(wake?.data).toEqual({ rideId: row.id, generation: 1 });
      expect(await wake!.getState()).toBe('delayed');
      expect(Math.abs((wake!.opts.delay ?? 0) - (2 * 3600_000 - 600_000))).toBeLessThan(5_000);

      const expire = await matchingQ.getJob(poolExpireJobId(poolId));
      expect(expire?.name).toBe('pool:expire');
      expect(expire?.data).toEqual({ rideId: poolId });
    });
  });

  // ── workers: a job completes only when the dispatch work did (T24) ───────

  describe('dispatch worker semantics', () => {
    function runWorker(name: string, fn: (job: Job) => Promise<void>): Worker {
      const w = new Worker(name, fn, { connection: redisConn(), prefix, autorun: true });
      workers.push(w);
      return w;
    }

    it('the BullMQ job stays active until wave 1 finished, then completes (completion covers the work)', async () => {
      await dispatchQ.obliterate({ force: true }); // no leftover jobs ahead of ours
      const p = await newClient();
      const { row } = await newRide(p);
      let release!: () => void;
      runner.gate = new Promise<void>((r) => (release = r));
      const w = runWorker('dispatch', (job) => processor.process(job));
      try {
        await relay.drainOnce();
        const id = dispatchStartJobId(row.id, 1);
        await until(async () => (await dispatchQ.getJob(id))?.getState().then((s) => s === 'active') ?? false);
        await sleep(150);
        expect(await (await dispatchQ.getJob(id))!.getState()).toBe('active'); // not completed early
        expect(runner.solo).toEqual([{ rideId: row.id, wave: 1, generation: 1 }]);
        release();
        await until(async () => (await (await dispatchQ.getJob(id))?.getState()) === 'completed');
      } finally {
        release();
        await w.close(true);
      }
    });

    it('a worker failure after the wave committed is retried by BullMQ, and the retry completes (T24)', async () => {
      await dispatchQ.obliterate({ force: true });
      const p = await newClient();
      const { row } = await newRide(p);
      let committed = 0;
      runner.afterCommit = async () => {
        committed++; // the wave's Postgres commit happened, then the worker "dies"
      };
      runner.failTimes = 1;
      const w = runWorker('dispatch', (job) => processor.process(job));
      try {
        await relay.drainOnce();
        const id = dispatchStartJobId(row.id, 1);
        await until(async () => (await (await dispatchQ.getJob(id))?.getState()) === 'completed', 15_000);
        const job = (await dispatchQ.getJob(id))!;
        expect(job.attemptsStarted).toBe(2);
        expect(runner.solo).toHaveLength(2); // redelivery re-ran the (idempotent) wave
        expect(committed).toBe(2);
      } finally {
        await w.close(true);
      }
    });

    it('a job for an old generation or a ride that moved on is a successful no-op', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      await pg.query(`UPDATE rides SET dispatch_generation = 2 WHERE id = $1`, [row.id]);
      expect(await start.startSolo(row.id, 1)).toBe('stale');
      expect(runner.solo).toHaveLength(0);

      await pg.query(`UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'client' WHERE id = $1`, [row.id]);
      expect(await start.startSolo(row.id, 2)).toBe('stale');
      expect(await start.startSolo(randomUUID(), 1)).toBe('stale');
      expect(runner.solo).toHaveLength(0);

      // Through the processor too: returns normally (no throw, no retry).
      await expect(
        processor.process({ name: DISPATCH_START_JOB, data: { kind: 'solo', tripId: row.id, generation: 1 } } as Job),
      ).resolves.toBeUndefined();
    });

    it('startPool dispatches only an unclaimed closed pool at the current generation', async () => {
      const mk = async (state: string, gen: number, claimedBy: string | null = null) => {
        const id = randomUUID();
        await pg.query(
          `INSERT INTO shared_rides (ride_id, pool_state, dispatch_generation, claimed_by_driver_id,
             origin_lat, origin_lng, dest_lat, dest_lng) VALUES ($1,$2,$3,$4,22.5,88.3,22.6,88.4)`,
          [id, state, gen, claimedBy],
        );
        return id;
      };
      const driver = await newDriver();
      const ok = await mk('closed_full', 1);
      expect(await start.startPool(ok, 1)).toBe('started');
      expect(runner.pool).toEqual([{ poolId: ok, wave: 1, generation: 1 }]);

      expect(await start.startPool(await mk('closed_full', 2), 1)).toBe('stale'); // old generation
      expect(await start.startPool(await mk('open', 1), 1)).toBe('stale');
      expect(await start.startPool(await mk('aborted', 1), 1)).toBe('stale');
      expect(await start.startPool(await mk('closed_timeout', 1, driver), 1)).toBe('stale'); // claimed
      expect(runner.pool).toHaveLength(1);
      await pg.query(`DELETE FROM shared_rides WHERE ride_id IN (SELECT ride_id FROM shared_rides WHERE origin_lat = 22.5 AND origin_lng = 88.3)`);
    });
  });

  // ── scheduled wake (T26, T17, T25) ───────────────────────────────────────

  describe('scheduled wake', () => {
    async function newScheduled(p: string) {
      return (await newRide(p, { scheduled: new Date(Date.now() + 3 * 3600_000) })).row;
    }

    it('wake moves the ride to generation 1 and returns only after wave 1 ran; redelivery is idempotent', async () => {
      const p = await newClient();
      const ride = await newScheduled(p);
      expect(await start.wakeScheduled(ride.id, 1)).toBe('started');
      expect((await rideRow(ride.id)).dispatch_generation).toBe(1);
      expect(runner.solo).toEqual([{ rideId: ride.id, wave: 1, generation: 1 }]);

      expect(await start.wakeScheduled(ride.id, 1)).toBe('started'); // redelivery
      expect((await rideRow(ride.id)).dispatch_generation).toBe(1);
      expect(runner.solo).toHaveLength(2);
    });

    it('a wake failure propagates (the job retries) and leaves the ride woken for the retry', async () => {
      const p = await newClient();
      const ride = await newScheduled(p);
      runner.failTimes = 1;
      const proc = new ScheduledDispatchProcessor(start);
      const job = { name: SCHEDULED_WAKE_JOB, data: { rideId: ride.id, generation: 1 } } as Job;
      await expect(proc.process(job)).rejects.toThrow('wave failed after commit');
      expect((await rideRow(ride.id)).dispatch_generation).toBe(1);
      await proc.process(job); // BullMQ retry
      expect(runner.solo).toHaveLength(2);
    });

    it('cancel holds the ride lock while the wake runs: the wake sees the cancel and dispatches nothing (T26)', async () => {
      const p = await newClient();
      const ride = await newScheduled(p);
      const cancelConn = await newPool().connect();
      try {
        await cancelConn.query('BEGIN');
        await cancelConn.query('SELECT id FROM rides WHERE id = $1 FOR UPDATE', [ride.id]);
        await cancelConn.query(
          `UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'client' WHERE id = $1`,
          [ride.id],
        );
        // The worker's wake blocks on the row lock from its own connection.
        const wake = start.wakeScheduled(ride.id, 1);
        await sleep(200);
        let settled = false;
        void wake.finally(() => (settled = true));
        await sleep(100);
        expect(settled).toBe(false);
        await cancelConn.query('COMMIT');
        expect(await wake).toBe('stale');
      } finally {
        cancelConn.release();
      }
      expect(runner.solo).toHaveLength(0);
      expect(await rideRow(ride.id)).toMatchObject({ status: 'cancelled', dispatch_generation: 0 });
    });

    it('the wake commits first, then cancel wins: a late duplicate worker dispatches nothing after the cancel (T26)', async () => {
      const p = await newClient();
      const ride = await newScheduled(p);
      expect(await start.wakeScheduled(ride.id, 1)).toBe('started');
      expect(runner.solo).toHaveLength(1);

      await pg.query(`UPDATE rides SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'client' WHERE id = $1`, [ride.id]);
      expect(await start.wakeScheduled(ride.id, 1)).toBe('stale'); // late worker
      expect(await start.startSolo(ride.id, 1)).toBe('stale');
      expect(runner.solo).toHaveLength(1); // nothing after the cancel
      expect((await rideRow(ride.id)).status).toBe('cancelled');
    });

    it('a wake for a superseded generation or a non-scheduled ride is a no-op', async () => {
      const p = await newClient();
      const ride = await newScheduled(p);
      await pg.query(`UPDATE rides SET dispatch_generation = 3 WHERE id = $1`, [ride.id]);
      expect(await start.wakeScheduled(ride.id, 1)).toBe('stale');
      const { row: normal } = await newRide(p);
      expect(await start.wakeScheduled(normal.id, 1)).toBe('stale');
      expect(runner.solo).toHaveLength(0);
    });

    it('Redis loses every queue: reconcile rebuilds the wake jobs and ownership is retained (T25)', async () => {
      const p = await newClient();
      const rides = [await newScheduled(p), await newScheduled(p)];
      await relay.drainOnce();
      for (const r of rides) expect(await scheduledQ.getJob(scheduledWakeJobId(r.id, 1))).toBeDefined();

      // Redis restarts empty (only this spec's keyspace).
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      for (const r of rides) expect(await scheduledQ.getJob(scheduledWakeJobId(r.id, 1))).toBeUndefined();

      const report = await reconciler.reconcile();
      expect(report.wakeRearmed).toBeGreaterThanOrEqual(2);
      await relay.drainOnce();

      for (const r of rides) {
        const job = await scheduledQ.getJob(scheduledWakeJobId(r.id, 1));
        expect(job?.data).toEqual({ rideId: r.id, generation: 1 });
        expect(await job!.getState()).toBe('delayed');
        expect(await outboxRows(r.id)).toHaveLength(1); // same intent re-armed, not duplicated
        const own = await pg.query(`SELECT passenger_id, status FROM rides WHERE id = $1`, [r.id]);
        expect(own.rows[0]).toMatchObject({ passenger_id: p, status: 'requested' });
      }
    });

    it('with Redis cleared, replaying the committed scheduled booking still returns the ride and a wake intent exists (T17)', async () => {
      const p = await newClient();
      const key = `idem-${randomUUID()}`;
      const when = new Date(Date.now() + 3 * 3600_000);
      const first = await newRide(p, { scheduled: when, key });
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.del(`idem:${p}:ride.create.scheduled:${key}`).catch(() => undefined);

      const replay = await newRide(p, { scheduled: when, key });
      expect(replay.created).toBe(false);
      expect(replay.row.id).toBe(first.row.id);
      const rows = await outboxRows(first.row.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].topic).toBe('ride.wake.schedule');

      await reconciler.reconcile();
      await relay.drainOnce();
      expect(await scheduledQ.getJob(scheduledWakeJobId(first.row.id, 1))).toBeDefined();
    });
  });

  // ── reconciler: solo + pools ──────────────────────────────────────────────

  describe('reconciler repairs lost in-flight dispatch', () => {
    it('a requested ride with no start job, timers or offers is re-armed and re-published', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      await relay.drainOnce();
      // Lose the job (Redis flushed) after the outbox row was acked.
      await (await dispatchQ.getJob(dispatchStartJobId(row.id, 1)))!.remove();
      await age('rides', 'id', row.id);

      const report = await reconciler.reconcile();
      expect(report.dispatchRearmed).toBeGreaterThanOrEqual(1);
      await relay.drainOnce();
      const job = await dispatchQ.getJob(dispatchStartJobId(row.id, 1));
      expect(job).toBeDefined();
      expect(await outboxRows(row.id)).toHaveLength(1);
    });

    it('a recent ride (inside the grace window) and a live start job are left alone', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      await relay.drainOnce();
      const before = await reconciler.reconcile(); // fresh: grace
      await age('rides', 'id', row.id);
      const after = await reconciler.reconcile(); // aged, but the start job is live
      expect(after.dispatchRearmed).toBe(before.dispatchRearmed);
      expect((await outboxRows(row.id))[0].attempts).toBe(1);
    });

    it('an exhausted (failed) start job is removed and replaced by a fresh publish', async () => {
      await dispatchQ.obliterate({ force: true });
      const p = await newClient();
      const { row } = await newRide(p);
      const id = dispatchStartJobId(row.id, 1);
      // Real worker that fails the job for good (attempts exhausted).
      await dispatchQ.add(DISPATCH_START_JOB, { kind: 'solo', tripId: row.id, generation: 1 }, { jobId: id, attempts: 1 });
      const w = new Worker(
        'dispatch',
        async () => {
          throw new Error('poison');
        },
        { connection: redisConn(), prefix },
      );
      try {
        await until(async () => (await (await dispatchQ.getJob(id))?.getState()) === 'failed');
      } finally {
        await w.close(true);
      }
      await relay.drainOnce();
      await age('rides', 'id', row.id);

      await reconciler.reconcile();
      await relay.drainOnce();
      const fresh = (await dispatchQ.getJob(id))!;
      expect(await fresh.getState()).not.toBe('failed');
    });

    it('offers exist but the timers vanished: hard-fail and wave-2 are restored with the remaining delay', async () => {
      const p = await newClient();
      const driver = await newDriver();
      const { row } = await newRide(p);
      await pg.query(`UPDATE rides SET dispatch_generation = 1 WHERE id = $1`, [row.id]);
      await pg.query(
        `INSERT INTO dispatch_offer (trip_kind, ride_id, driver_id, dispatch_generation, wave_number, offered_at, expires_at)
         VALUES ('solo', $1, $2, 1, 1, now() - interval '10 seconds', now() + interval '2 seconds')`,
        [row.id, driver],
      );
      await age('rides', 'id', row.id);
      await relay.drainOnce();
      // Wave 1 ran (offers exist) and the start job completed; the timers are gone.
      await (await dispatchQ.getJob(dispatchStartJobId(row.id, 1)))?.remove();

      const report = await reconciler.reconcile();
      expect(report.timersRestored).toBe(2);
      const hard = (await dispatchQ.getJob(hardFailJobId(row.id, 1)))!;
      const wave2 = (await dispatchQ.getJob(wave2JobId(row.id, 1)))!;
      expect(hard.name).toBe('dispatch:hard-fail');
      expect(hard.data).toEqual({ rideId: row.id, kind: 'solo', generation: 1 });
      // offered 10 s ago: ~50 s of the 60 s hard-fail window and ~20 s of the 30 s wave-1 window remain.
      expect(Math.abs((hard.opts.delay ?? 0) - 50_000)).toBeLessThan(3_000);
      expect(wave2.data).toEqual({ rideId: row.id, waveNumber: 2, kind: 'solo', generation: 1 });
      expect(Math.abs((wave2.opts.delay ?? 0) - 20_000)).toBeLessThan(3_000);
      // Offers existed, so no second dispatch start was queued.
      expect(await dispatchQ.getJob(dispatchStartJobId(row.id, 1))).toBeUndefined();
    });

    it('a ride whose hard-fail timer still exists under the legacy colon id is untouched', async () => {
      const p = await newClient();
      const { row } = await newRide(p);
      await relay.drainOnce();
      await (await dispatchQ.getJob(dispatchStartJobId(row.id, 1)))!.remove();
      await dispatchQ.add('dispatch:hard-fail', { rideId: row.id, kind: 'solo' }, { jobId: legacyHardFailJobId(row.id), delay: 60_000 });
      await age('rides', 'id', row.id);

      await reconciler.reconcile();
      await relay.drainOnce();
      expect(await dispatchQ.getJob(dispatchStartJobId(row.id, 1))).toBeUndefined();
    });

    it('an open pool without its expiry job gets the intent re-armed (planned close time as expireAt)', async () => {
      const poolId = randomUUID();
      await pg.query(
        `INSERT INTO shared_rides (ride_id, pool_state, pool_closed_at, origin_lat, origin_lng, dest_lat, dest_lng, updated_at)
         VALUES ($1,'open', now() + interval '30 seconds', 22.7, 88.3, 22.8, 88.4, now() - interval '5 minutes')`,
        [poolId],
      );
      const report = await reconciler.reconcile();
      expect(report.poolExpireRearmed).toBeGreaterThanOrEqual(1);
      const [ob] = await outboxRows(poolId);
      expect(ob).toMatchObject({ topic: 'pool.expire.schedule', aggregate_generation: 0 });
      await relay.drainOnce();
      const job = (await matchingQ.getJob(poolExpireJobId(poolId)))!;
      expect(job.data).toEqual({ rideId: poolId });
      expect(Math.abs((job.opts.delay ?? 0) - 30_000)).toBeLessThan(5_000);
      await pg.query(`DELETE FROM outbox WHERE aggregate_id = $1`, [poolId]);
      await pg.query(`DELETE FROM shared_rides WHERE ride_id = $1`, [poolId]);
    });

    it('a closed unclaimed pool with no dispatch in flight gets pool.dispatch.requested re-armed', async () => {
      const poolId = randomUUID();
      await pg.query(
        `INSERT INTO shared_rides (ride_id, pool_state, dispatch_generation, origin_lat, origin_lng, dest_lat, dest_lng, updated_at)
         VALUES ($1,'closed_full', 1, 22.9, 88.3, 23.0, 88.4, now() - interval '5 minutes')`,
        [poolId],
      );
      const report = await reconciler.reconcile();
      expect(report.dispatchRearmed).toBeGreaterThanOrEqual(1);
      expect((await outboxRows(poolId))[0]).toMatchObject({ topic: 'pool.dispatch.requested', aggregate_generation: 1 });
      await relay.drainOnce();
      const job = (await dispatchQ.getJob(dispatchStartJobId(poolId, 1)))!;
      expect(job.data).toEqual({ kind: 'pool', tripId: poolId, generation: 1 });
      await pg.query(`DELETE FROM outbox WHERE aggregate_id = $1`, [poolId]);
      await pg.query(`DELETE FROM shared_rides WHERE ride_id = $1`, [poolId]);
    });

    it('reports outbox backlog stats', async () => {
      const report = await reconciler.reconcile();
      expect(report.outboxPending).toBeGreaterThanOrEqual(0);
      expect(typeof report.outboxExhausted).toBe('number');
    });
  });
});
