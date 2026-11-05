// Stage C slice A (R06; F05 / F06): authoritative offers + one driver
// assignment guard across solo and shared trips, against real Postgres + Redis
// + BullMQ. Contention uses INDEPENDENT pg Pools (one DispatchService per pool)
// and, where the interleaving matters, a third connection that holds a row
// lock until every contender is provably queued behind it (pg_stat_activity).
// Every scenario ends by asserting the Postgres state, the Redis projection and
// the contract §6 invariants I1–I4.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import {
  HARD_FAIL_JOB,
  hardFailJobId,
  waveTwoJobId,
  type HardFailJob,
} from '../../src/modules/dispatch/dispatch.service';
import { clearCurrentRide } from '../../src/modules/dispatch/driver-assignment.projection';
import type { SoloRideOfferPayload } from '../../src/modules/dispatch/dispatch.types';
import { RideStateMachine } from '../../src/modules/rides/ride-state-machine.service';
import { RideLifecycleService } from '../../src/modules/ride-lifecycle/ride-lifecycle.service';
import {
  assignmentInvariantViolations,
  backdateOffer,
  buildDispatch,
  guardsFor,
  insertOffer,
  makeBus,
  markOnline,
  offerState,
  seedClient,
  seedClosedPool,
  seedDriver,
  seedSoloRide,
  type Bus,
  type DispatchHarness,
} from './support/dispatch-fixtures';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function redisConn(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

/** Distinct, far-apart coordinates per scenario so geo candidates never leak across tests. */
let spotSeq = 0;
function spot(): { lat: number; lng: number } {
  spotSeq += 1;
  return { lat: -40 + spotSeq * 0.5, lng: 120 + spotSeq * 0.5 };
}

describe.skipIf(skip)('Stage C slice A — offers + assignment guard (multi-connection)', () => {
  let poolA: Pool;
  let poolB: Pool;
  let poolC: Pool;
  let redis: Redis;
  let queue: Queue;
  let busA: Bus;
  let busB: Bus;
  let A: DispatchHarness;
  let B: DispatchHarness;
  const rideIds: string[] = [];
  const poolIds: string[] = [];

  beforeAll(async () => {
    const uri = process.env.TEST_POSTGRES_URI!;
    poolA = new Pool({ connectionString: uri, max: 4 });
    poolB = new Pool({ connectionString: uri, max: 4 });
    poolC = new Pool({ connectionString: uri, max: 4 });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    queue = new Queue(`dispatch-slice-a-${randomUUID().slice(0, 8)}`, {
      connection: redisConn(process.env.TEST_REDIS_URL!),
    });
    busA = makeBus();
    busB = makeBus();
    A = buildDispatch(poolA, redis, queue, busA);
    B = buildDispatch(poolB, redis, queue, busB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const bus of [busA, busB]) {
      for (const fn of Object.values(bus)) fn.mockClear();
      bus.toDriver.mockImplementation(() => undefined);
    }
  });

  afterAll(async () => {
    // Every scenario's trips must satisfy I1–I4 once the dust settles.
    expect(await assignmentInvariantViolations(poolC, { rideIds, poolIds })).toEqual({});
    await queue?.obliterate({ force: true }).catch(() => {});
    await queue?.close().catch(() => {});
    await Promise.all([poolA?.end(), poolB?.end(), poolC?.end()]);
    await redis?.quit();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function soloRide(opts: { generation?: number } = {}) {
    const passenger = await seedClient(poolC);
    const at = spot();
    const rideId = await seedSoloRide(poolC, passenger, { ...opts, ...at });
    rideIds.push(rideId);
    return { rideId, passenger, at };
  }

  async function closedPool(opts: Parameters<typeof seedClosedPool>[1] = {}) {
    const at = spot();
    const p = await seedClosedPool(poolC, { ...at, ...opts });
    poolIds.push(p.poolId);
    return { ...p, at };
  }

  async function onlineDriver(at?: { lat: number; lng: number }, opts = {}) {
    const d = await seedDriver(poolC, opts);
    await markOnline(redis, d);
    if (at) await redis.geoadd('active_drivers', at.lng + 0.0005, at.lat + 0.0005, d);
    return d;
  }

  /** Hold `sql` (a FOR UPDATE) on its own connection until released. */
  async function holdLock(sql: string, params: unknown[]) {
    const c = await poolC.connect();
    await c.query('BEGIN');
    await c.query(sql, params);
    return {
      client: c,
      async commit() {
        await c.query('COMMIT');
        c.release();
      },
      async rollback() {
        await c.query('ROLLBACK');
        c.release();
      },
    };
  }

  /** Wait until at least `n` backends are blocked on a lock (contenders queued). */
  async function lockWaiters(n: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await poolC.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`expected ${n} lock waiters`);
  }

  async function rideRow(rideId: string) {
    const { rows } = await poolC.query<{ status: string; driver_id: string | null }>(
      'SELECT status, driver_id FROM rides WHERE id = $1',
      [rideId],
    );
    return rows[0];
  }

  async function poolRow(poolId: string) {
    const { rows } = await poolC.query<{ pool_state: string; claimed_by_driver_id: string | null }>(
      'SELECT pool_state, claimed_by_driver_id FROM shared_rides WHERE ride_id = $1',
      [poolId],
    );
    return rows[0];
  }

  const currentRide = (driverId: string) => redis.hget(`driver:state:${driverId}`, 'current_ride_id');

  // ── offer creation ─────────────────────────────────────────────────────────

  describe('wave offers (candidate filter + driver reservation)', () => {
    it('offers only eligible drivers, persists the offer, arms generation-scoped timers', async () => {
      const { rideId, at } = await soloRide();
      const eligible = await onlineDriver(at);
      const noVehicle = await onlineDriver(at, { vehicle: false });
      const suspended = await onlineDriver(at, { status: 'suspended' });
      const busy = await onlineDriver(at);
      const other = await soloRide();
      expect(await A.rides.claimSolo(other.rideId, busy)).not.toBeNull();
      await redis.geoadd('active_drivers', at.lng, at.lat, 'not-a-uuid');

      const ride = (await A.rides.findById(rideId))!;
      await A.dispatch.runSoloWave(ride, 1, 1);

      const offered = busA.toDriver.mock.calls.filter((c) => c[1] === 'ride_offer');
      expect(offered.map((c) => c[0])).toEqual([eligible]);
      const payload = offered[0][2] as SoloRideOfferPayload;
      expect(payload.rideId).toBe(rideId);
      expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());

      const { rows } = await poolC.query(
        `SELECT driver_id, state, dispatch_generation FROM dispatch_offer WHERE ride_id = $1`,
        [rideId],
      );
      expect(rows).toEqual([{ driver_id: eligible, state: 'offered', dispatch_generation: 1 }]);
      expect(await queue.getJob(waveTwoJobId(rideId, 1))).toBeDefined();
      expect(await queue.getJob(hardFailJobId(rideId, 1))).toBeDefined();

      // Re-running the same wave (job redelivery) offers nobody twice.
      busA.toDriver.mockClear();
      await A.dispatch.runSoloWave(ride, 1, 1);
      expect(busA.toDriver).not.toHaveBeenCalled();
      const again = await poolC.query('SELECT 1 FROM dispatch_offer WHERE ride_id = $1', [rideId]);
      expect(again.rowCount).toBe(1);

      for (const d of [eligible, noVehicle, suspended, busy, 'not-a-uuid']) {
        await redis.zrem('active_drivers', d);
      }
    });

    it('reserves the DRIVER: one live offer at a time, across trips and connections', async () => {
      const r1 = await soloRide();
      const r2 = await soloRide();
      const d = await seedDriver(poolC);
      const trip1 = { kind: 'solo' as const, rideId: r1.rideId };
      const trip2 = { kind: 'solo' as const, rideId: r2.rideId };

      const [o1, o2] = await Promise.all([
        A.offers.createOffer(A.db, { trip: trip1, driverId: d, generation: 1, waveNumber: 1, ttlMs: 12_000 }),
        B.offers.createOffer(B.db, { trip: trip2, driverId: d, generation: 1, waveNumber: 1, ttlMs: 12_000 }),
      ]);
      expect([o1, o2].filter(Boolean)).toHaveLength(1);
      const live = await poolC.query(
        `SELECT 1 FROM dispatch_offer WHERE driver_id = $1 AND state = 'offered'`,
        [d],
      );
      expect(live.rowCount).toBe(1);

      // Declining frees the slot; a lapsed offer is expired on the next write.
      const held = (o1 ?? o2)!;
      expect(await A.dispatch.declineOffer({ offerId: held.offerId, driverId: d })).toBe('declined');
      const o3 = await A.offers.createOffer(A.db, {
        trip: o1 ? trip2 : trip1, driverId: d, generation: 1, waveNumber: 1, ttlMs: 12_000,
      });
      expect(o3).not.toBeNull();
      await backdateOffer(poolC, o3!.offerId);
      const r3 = await soloRide();
      const o4 = await A.offers.createOffer(A.db, {
        trip: { kind: 'solo', rideId: r3.rideId }, driverId: d, generation: 1, waveNumber: 1, ttlMs: 12_000,
      });
      expect(o4).not.toBeNull();
      expect(await offerState(poolC, o3!.offerId)).toBe('expired');
    });

    it('never offers a trip generation that is no longer current', async () => {
      const { rideId } = await soloRide({ generation: 2 });
      const d = await seedDriver(poolC);
      const stale = await A.offers.createOffer(A.db, {
        trip: { kind: 'solo', rideId }, driverId: d, generation: 1, waveNumber: 1, ttlMs: 12_000,
      });
      expect(stale).toBeNull();
      await poolC.query(`UPDATE rides SET status = 'cancelled' WHERE id = $1`, [rideId]);
      const cancelled = await A.offers.createOffer(A.db, {
        trip: { kind: 'solo', rideId }, driverId: d, generation: 2, waveNumber: 1, ttlMs: 12_000,
      });
      expect(cancelled).toBeNull();
    });

    it('a pool wave offers its persisted itinerary with passengerCount = seat_count', async () => {
      const { poolId, at } = await closedPool({ members: 2 });
      const d = await onlineDriver(at, { seats: 2 });
      const tooSmall = await onlineDriver(at, { seats: 1 });
      const pool = (await A.shared.findById(poolId))!;
      await A.dispatch.runPoolWave(pool, 1, 1);

      const offered = busA.toDriver.mock.calls.filter((c) => c[1] === 'ride_offer');
      expect(offered.map((c) => c[0])).toEqual([d]);
      expect(offered[0][2]).toMatchObject({ sharedRideId: poolId, passengerCount: 2 });
      expect((offered[0][2] as { stops: unknown[] }).stops).toHaveLength(4);
      await redis.zrem('active_drivers', d, tooSmall);
    });
  });

  // ── T18: authorization ─────────────────────────────────────────────────────

  describe('T18 — only the live offer, of this driver, of the current generation assigns', () => {
    it('forged, wrong-driver, expired, declined, revoked and old-generation offers never assign', async () => {
      const owner = await seedDriver(poolC);
      const intruder = await seedDriver(poolC);
      const touched: string[] = [];
      const fresh = async () => {
        const r = await soloRide();
        touched.push(r.rideId);
        return { ...r, trip: { kind: 'solo' as const, rideId: r.rideId } };
      };

      // Forged id / malformed id.
      expect(await A.dispatch.acceptOffer({ offerId: randomUUID(), driverId: owner })).toEqual({
        ok: false,
        reason: 'offer_not_found',
      });
      expect(await A.dispatch.acceptOffer({ offerId: 'nope', driverId: owner })).toEqual({
        ok: false,
        reason: 'offer_not_found',
      });

      // Wrong driver: same answer as forged (no existence leak), for accept and decline.
      const r1 = await fresh();
      const live = await insertOffer(poolC, { trip: r1.trip, driverId: owner });
      expect(await A.dispatch.acceptOffer({ offerId: live, driverId: intruder })).toEqual({
        ok: false,
        reason: 'offer_not_found',
      });
      expect(await A.dispatch.declineOffer({ offerId: live, driverId: intruder })).toBe('not_found');

      // Expired on the DB clock (lapsed but never swept): resolved + committed.
      await backdateOffer(poolC, live);
      expect(await A.dispatch.acceptOffer({ offerId: live, driverId: owner })).toEqual({
        ok: false,
        reason: 'offer_expired',
      });
      expect(await offerState(poolC, live)).toBe('expired');

      // Declined.
      const r2 = await fresh();
      const declined = await insertOffer(poolC, { trip: r2.trip, driverId: owner });
      expect(await A.dispatch.declineOffer({ offerId: declined, driverId: owner })).toBe('declined');
      expect(await A.dispatch.declineOffer({ offerId: declined, driverId: owner })).toBe('not_live');
      expect(await A.dispatch.acceptOffer({ offerId: declined, driverId: owner })).toEqual({
        ok: false,
        reason: 'offer_declined',
      });

      // Old generation: the ride was re-dispatched on generation 2.
      const r3 = await fresh();
      const old = await insertOffer(poolC, { trip: r3.trip, driverId: owner, generation: 1 });
      await poolC.query(`UPDATE rides SET dispatch_generation = 2 WHERE id = $1`, [r3.rideId]);
      expect(await A.dispatch.acceptOffer({ offerId: old, driverId: owner })).toEqual({
        ok: false,
        reason: 'offer_stale',
      });
      expect(await offerState(poolC, old)).toBe('revoked');

      // Revoked by a client cancel (in the cancel transaction).
      const r4 = await fresh();
      const revoked = await insertOffer(poolC, { trip: r4.trip, driverId: owner });
      const cancel = await A.rides.cancel({
        rideId: r4.rideId,
        actor: 'client',
        actorId: r4.passenger,
        isNoShow: false,
        reason: null,
        noShowWaitMs: 0,
      });
      expect(cancel.ok && cancel.revokedOffers).toEqual([{ offerId: revoked, driverId: owner }]);
      expect(await A.dispatch.acceptOffer({ offerId: revoked, driverId: owner })).toEqual({
        ok: false,
        reason: 'offer_revoked',
      });

      expect(await guardsFor(poolC, { driverId: owner })).toEqual([]);
      expect(await guardsFor(poolC, { driverId: intruder })).toEqual([]);
      for (const id of touched) expect((await rideRow(id)).driver_id).toBeNull();
      // The refused accepts were still answered over the legacy event too.
      expect(busA.toDriver).toHaveBeenCalledWith(
        owner,
        'ride_offer_revoked',
        expect.objectContaining({ offerId: revoked, reason: 'unavailable' }),
      );
    });

    it('rejects an ineligible account or an undersized vehicle at the decision', async () => {
      const { rideId } = await soloRide();
      const d = await seedDriver(poolC);
      const offerId = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });
      await poolC.query(`UPDATE app_user SET status = 'suspended' WHERE id = $1`, [d]);
      expect(await A.dispatch.acceptOffer({ offerId, driverId: d })).toEqual({
        ok: false,
        reason: 'driver_ineligible',
      });

      const { poolId } = await closedPool({ members: 3, maxSeats: 3 });
      const small = await seedDriver(poolC, { seats: 2 });
      const poolOffer = await insertOffer(poolC, {
        trip: { kind: 'shared', sharedRideId: poolId },
        driverId: small,
      });
      expect(await A.dispatch.acceptOffer({ offerId: poolOffer, driverId: small })).toEqual({
        ok: false,
        reason: 'vehicle_capacity',
      });
      expect(await guardsFor(poolC, { poolId })).toEqual([]);
      expect((await poolRow(poolId)).claimed_by_driver_id).toBeNull();
    });
  });

  // ── T19: two drivers, one trip ─────────────────────────────────────────────

  describe('T19 — two drivers accept one trip on two connections', () => {
    for (const kind of ['solo', 'shared'] as const) {
      it(`exactly one ${kind} winner; the loser gets trip_taken`, async () => {
        let trip;
        let lockSql: string;
        if (kind === 'solo') {
          const { rideId } = await soloRide();
          trip = { kind, rideId } as const;
          lockSql = 'SELECT 1 FROM rides WHERE id = $1 FOR UPDATE';
        } else {
          const { poolId } = await closedPool({ members: 2 });
          trip = { kind, sharedRideId: poolId } as const;
          lockSql = 'SELECT 1 FROM shared_rides WHERE ride_id = $1 FOR UPDATE';
        }
        const id = trip.kind === 'solo' ? trip.rideId : trip.sharedRideId;
        const d1 = await onlineDriver();
        const d2 = await onlineDriver();
        const o1 = await insertOffer(poolC, { trip, driverId: d1 });
        const o2 = await insertOffer(poolC, { trip, driverId: d2 });

        // Both contenders queue behind a held trip lock, then race for it.
        const hold = await holdLock(lockSql, [id]);
        const pa = A.dispatch.acceptOffer({ offerId: o1, driverId: d1 });
        const pb = B.dispatch.acceptOffer({ offerId: o2, driverId: d2 });
        await lockWaiters(2);
        await hold.commit();
        const [a, b] = await Promise.all([pa, pb]);

        const results = [a, b];
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        const loser = results.find((r) => !r.ok);
        expect(loser).toEqual({ ok: false, reason: 'trip_taken' });
        const winner = a.ok ? d1 : d2;
        const loserId = a.ok ? d2 : d1;

        const guards = await guardsFor(poolC, trip.kind === 'solo' ? { rideId: id } : { poolId: id });
        expect(guards).toHaveLength(1);
        expect(guards[0].driver_id).toBe(winner);
        if (trip.kind === 'solo') {
          expect(await rideRow(id)).toEqual({ status: 'accepted', driver_id: winner });
        } else {
          expect((await poolRow(id)).claimed_by_driver_id).toBe(winner);
        }
        expect(await offerState(poolC, a.ok ? o1 : o2)).toBe('accepted');
        expect(await offerState(poolC, a.ok ? o2 : o1)).toBe('revoked');
        // Redis projection follows the committed winner only.
        expect(await currentRide(winner)).toBe(id);
        expect(await currentRide(loserId)).toBeNull();
        const winnerBus = a.ok ? busA : busB;
        expect(winnerBus.toDriver).toHaveBeenCalledWith(
          winner,
          'ride_offer_accepted',
          expect.objectContaining({ rideId: id }),
        );
      });
    }
  });

  // ── T20: one driver, two trips (solo vs shared) ────────────────────────────

  describe('T20 — one driver, a solo and a shared trip at once', () => {
    it('a pool claim committing first leaves the solo accept driver_busy (held interleaving)', async () => {
      const { rideId } = await soloRide();
      const { poolId } = await closedPool({ members: 1 });
      const d = await onlineDriver();
      const soloOffer = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });

      // A concurrent pool claim for the same driver, mid-transaction.
      const hold = await holdLock('SELECT 1 FROM shared_rides WHERE ride_id = $1 FOR UPDATE', [poolId]);
      await hold.client.query(
        `INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation)
         VALUES ($1, $2, 1)`,
        [d, poolId],
      );
      await hold.client.query(
        `UPDATE shared_rides SET claimed_by_driver_id = $1, claimed_at = now() WHERE ride_id = $2`,
        [d, poolId],
      );
      const accept = A.dispatch.acceptOffer({ offerId: soloOffer, driverId: d });
      await lockWaiters(1); // the accept is blocked on the guard's primary key
      await hold.commit();

      expect(await accept).toEqual({ ok: false, reason: 'driver_busy' });
      expect(await guardsFor(poolC, { driverId: d })).toEqual([
        { driver_id: d, solo_ride_id: null, shared_ride_id: poolId },
      ]);
      expect(await rideRow(rideId)).toEqual({ status: 'requested', driver_id: null });
      expect(await offerState(poolC, soloOffer)).toBe('offered');
    });

    it('the same interleaving rolled back lets the solo accept win', async () => {
      const { rideId } = await soloRide();
      const { poolId } = await closedPool({ members: 1 });
      const d = await onlineDriver();
      const soloOffer = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });
      const hold = await holdLock('SELECT 1 FROM shared_rides WHERE ride_id = $1 FOR UPDATE', [poolId]);
      await hold.client.query(
        `INSERT INTO driver_active_assignment (driver_id, shared_ride_id, dispatch_generation)
         VALUES ($1, $2, 1)`,
        [d, poolId],
      );
      const accept = A.dispatch.acceptOffer({ offerId: soloOffer, driverId: d });
      await lockWaiters(1);
      await hold.rollback();

      expect(await accept).toMatchObject({ ok: true, replay: false });
      expect(await guardsFor(poolC, { driverId: d })).toEqual([
        { driver_id: d, solo_ride_id: rideId, shared_ride_id: null },
      ]);
      expect(await currentRide(d)).toBe(rideId);
    });

    it('shared accept vs direct solo claim on independent connections: one active trip', async () => {
      for (let i = 0; i < 5; i++) {
        const { rideId } = await soloRide();
        const { poolId } = await closedPool({ members: 1 });
        const d = await onlineDriver();
        const poolOffer = await insertOffer(poolC, {
          trip: { kind: 'shared', sharedRideId: poolId },
          driverId: d,
        });

        const [shared, solo] = await Promise.all([
          A.dispatch.acceptOffer({ offerId: poolOffer, driverId: d }),
          B.rides.claimSolo(rideId, d),
        ]);

        const guards = await guardsFor(poolC, { driverId: d });
        expect(guards).toHaveLength(1);
        if (shared.ok) {
          expect(solo).toBeNull();
          expect(guards[0].shared_ride_id).toBe(poolId);
          expect(await rideRow(rideId)).toEqual({ status: 'requested', driver_id: null });
        } else {
          expect(shared).toEqual({ ok: false, reason: 'driver_busy' });
          expect(solo?.driverId).toBe(d);
          expect(guards[0].solo_ride_id).toBe(rideId);
          expect((await poolRow(poolId)).claimed_by_driver_id).toBeNull();
        }
      }
    });
  });

  // ── T21: accept vs cancel / hard-fail ──────────────────────────────────────

  describe('T21 — accept races cancellation and the no-driver timeout', () => {
    it('accept vs client cancel: the ride ends cancelled with no surviving guard', async () => {
      const outcomes = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const { rideId, passenger } = await soloRide();
        const d = await onlineDriver();
        const offerId = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });

        const [accept, cancel] = await Promise.all([
          A.dispatch.acceptOffer({ offerId, driverId: d }),
          B.rides.cancel({
            rideId, actor: 'client', actorId: passenger, isNoShow: false, reason: null, noShowWaitMs: 0,
          }),
        ]);

        expect(cancel.ok).toBe(true);
        expect((await rideRow(rideId)).status).toBe('cancelled');
        expect(await guardsFor(poolC, { rideId })).toEqual([]);
        expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
        if (accept.ok) {
          outcomes.add('accepted-then-cancelled');
          expect(await offerState(poolC, offerId)).toBe('accepted');
        } else {
          outcomes.add('cancelled-first');
          expect(accept).toEqual({ ok: false, reason: 'offer_revoked' });
          expect(await offerState(poolC, offerId)).toBe('revoked');
        }
      }
      expect(outcomes.size).toBeGreaterThanOrEqual(1);
    });

    it('accept vs solo hard-fail: accepted with a guard, or no_driver with none', async () => {
      for (let i = 0; i < 6; i++) {
        const { rideId } = await soloRide();
        const d = await onlineDriver();
        const offerId = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });
        const job = { data: { rideId, kind: 'solo', generation: 1 } } as Job<HardFailJob>;

        const [accept] = await Promise.all([
          A.dispatch.acceptOffer({ offerId, driverId: d }),
          B.dispatch.handleHardFail(job),
        ]);
        const ride = await rideRow(rideId);
        if (accept.ok) {
          expect(ride).toEqual({ status: 'accepted', driver_id: d });
          expect(await guardsFor(poolC, { rideId })).toHaveLength(1);
        } else {
          expect(accept).toEqual({ ok: false, reason: 'offer_revoked' });
          expect(ride).toEqual({ status: 'no_driver', driver_id: null });
          expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
        }
      }
    });

    it('accept vs pool hard-fail: claimed with a guard, or aborted with members released', async () => {
      for (let i = 0; i < 4; i++) {
        const { poolId } = await closedPool({ members: 2 });
        const d = await onlineDriver();
        const offerId = await insertOffer(poolC, {
          trip: { kind: 'shared', sharedRideId: poolId },
          driverId: d,
        });
        const job = { data: { rideId: poolId, kind: 'pool', generation: 1 } } as Job<HardFailJob>;
        const [accept] = await Promise.all([
          A.dispatch.acceptOffer({ offerId, driverId: d }),
          B.dispatch.handleHardFail(job),
        ]);
        const pool = await poolRow(poolId);
        const members = await poolC.query<{ active: boolean }>(
          'SELECT active FROM pool_member WHERE pool_id = $1',
          [poolId],
        );
        if (accept.ok) {
          expect(pool).toEqual({ pool_state: 'closed_full', claimed_by_driver_id: d });
          expect(members.rows.every((m) => m.active)).toBe(true);
        } else {
          expect(pool).toEqual({ pool_state: 'aborted', claimed_by_driver_id: null });
          expect(members.rows.every((m) => !m.active)).toBe(true);
          expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
        }
      }
    });

    it('a stale (old-generation) or legacy hard-fail job never fails a re-dispatched ride', async () => {
      const { rideId } = await soloRide({ generation: 2 });
      await B.dispatch.handleHardFail({ data: { rideId, kind: 'solo', generation: 1 } } as Job<HardFailJob>);
      expect((await rideRow(rideId)).status).toBe('requested');
      // A legacy job (no generation) means "current" and does fail it.
      await B.dispatch.handleHardFail({ data: { rideId, kind: 'solo' } } as Job<HardFailJob>);
      expect((await rideRow(rideId)).status).toBe('no_driver');
      expect(HARD_FAIL_JOB).toBe('dispatch:hard-fail');
    });
  });

  // ── T22 + failure injection ────────────────────────────────────────────────

  describe('T22 — no false success for an unusable or half-written assignment', () => {
    it('a shared accept without a persisted itinerary is itinerary_missing and leaves no guard', async () => {
      const { poolId } = await closedPool({ members: 2, withStops: false });
      const d = await seedDriver(poolC);
      const offerId = await insertOffer(poolC, {
        trip: { kind: 'shared', sharedRideId: poolId },
        driverId: d,
      });
      expect(await A.dispatch.acceptOffer({ offerId, driverId: d })).toEqual({
        ok: false,
        reason: 'itinerary_missing',
      });
      expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
      expect((await poolRow(poolId)).claimed_by_driver_id).toBeNull();
      expect(await offerState(poolC, offerId)).toBe('offered');
    });

    it('a failure after the guard insert rolls the whole assignment back', async () => {
      const { rideId } = await soloRide();
      const d = await onlineDriver();
      const offerId = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });
      vi.spyOn(A.assignments, 'claimSoloRow').mockRejectedValueOnce(new Error('injected'));

      await expect(A.dispatch.acceptOffer({ offerId, driverId: d })).rejects.toThrow('injected');
      expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
      expect(await rideRow(rideId)).toEqual({ status: 'requested', driver_id: null });
      expect(await offerState(poolC, offerId)).toBe('offered');
      expect(await currentRide(d)).toBeNull();

      // The same command retried afterwards succeeds normally.
      expect(await A.dispatch.acceptOffer({ offerId, driverId: d })).toMatchObject({ ok: true });
    });

    it('post-commit delivery / projection failures never turn the winner into a loser', async () => {
      const { rideId } = await soloRide();
      const d = await onlineDriver();
      const other = await onlineDriver();
      const offerId = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });
      await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: other });
      vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('redis down'));
      busA.toDriver.mockImplementation(() => {
        throw new Error('socket down');
      });

      expect(await A.dispatch.acceptOffer({ offerId, driverId: d })).toMatchObject({
        ok: true,
        replay: false,
      });
      expect(await rideRow(rideId)).toEqual({ status: 'accepted', driver_id: d });
      expect(await currentRide(d)).toBeNull(); // projection write was lost…

      vi.restoreAllMocks();
      await A.projection.reconcile(); // …and is rebuilt from Postgres.
      expect(await currentRide(d)).toBe(rideId);
    });
  });

  // ── replay / release ───────────────────────────────────────────────────────

  describe('replay and release', () => {
    it('a repeated accept replays the committed result; after completion it is never re-created', async () => {
      const { rideId } = await soloRide();
      const d = await onlineDriver();
      const offerId = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });

      expect(await A.dispatch.acceptOffer({ offerId, driverId: d })).toEqual({
        ok: true,
        trip: { kind: 'solo', rideId },
        generation: 1,
        replay: false,
      });
      // Replay is recognised before expiry: even a lapsed accepted offer replays.
      await backdateOffer(poolC, offerId);
      expect(await B.dispatch.acceptOffer({ offerId, driverId: d })).toMatchObject({
        ok: true,
        replay: true,
      });

      for (const [from, to] of [
        ['accepted', 'en_route'],
        ['en_route', 'arrived'],
        ['arrived', 'in_progress'],
        ['in_progress', 'completed'],
      ]) {
        expect((await A.rides.transition(rideId, d, from, to)).ok).toBe(true);
      }
      expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
      expect(await A.dispatch.acceptOffer({ offerId, driverId: d })).toEqual({
        ok: false,
        reason: 'trip_not_claimable',
      });
      expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
    });

    it('completing trip X never clears the guard or projection of trip Y', async () => {
      const x = await soloRide();
      const y = await soloRide();
      const d = await onlineDriver();
      const sm = new RideStateMachine(
        A.rides,
        busA as never,
        { emit: vi.fn() } as never,
        { get: vi.fn().mockReturnValue(undefined) } as never,
        redis,
      );

      const ox = await insertOffer(poolC, { trip: { kind: 'solo', rideId: x.rideId }, driverId: d });
      expect((await A.dispatch.acceptOffer({ offerId: ox, driverId: d })).ok).toBe(true);
      for (const e of ['start_en_route', 'mark_arrived', 'start_ride', 'end_ride']) {
        expect((await sm.apply(x.rideId, d, e)).ok).toBe(true);
      }
      expect(await currentRide(d)).toBeNull();

      const oy = await insertOffer(poolC, { trip: { kind: 'solo', rideId: y.rideId }, driverId: d });
      expect((await A.dispatch.acceptOffer({ offerId: oy, driverId: d })).ok).toBe(true);
      expect(await currentRide(d)).toBe(y.rideId);

      // A late / duplicate completion of X: no transition, no clear.
      expect(await sm.apply(x.rideId, d, 'end_ride')).toEqual({
        ok: false,
        reason: 'invalid_transition',
      });
      // A stale post-commit clear for X (arriving after Y was projected).
      expect(await clearCurrentRide(redis, d, x.rideId)).toBe(false);
      expect(await A.assignments.release(A.db, { driverId: d, trip: { kind: 'solo', rideId: x.rideId } })).toBe(false);

      expect(await currentRide(d)).toBe(y.rideId);
      expect(await guardsFor(poolC, { driverId: d })).toEqual([
        { driver_id: d, solo_ride_id: y.rideId, shared_ride_id: null },
      ]);
    });

    it('shared: final stop completes the pool, releases the guard, and blocks a later accept', async () => {
      const { poolId } = await closedPool({ members: 1 });
      const d = await onlineDriver();
      const offerId = await insertOffer(poolC, {
        trip: { kind: 'shared', sharedRideId: poolId },
        driverId: d,
      });
      expect((await A.dispatch.acceptOffer({ offerId, driverId: d })).ok).toBe(true);
      expect(await currentRide(d)).toBe(poolId);

      const lifecycle = new RideLifecycleService(A.stops, A.assignments, busA as never, redis, A.db);
      const first = await lifecycle.confirmStop({ rideId: poolId, driverId: d, sequenceIndex: 0, type: 'pickup' });
      expect(first).toMatchObject({ ok: true, rideCompleted: false });
      const last = await lifecycle.confirmStop({ rideId: poolId, driverId: d, sequenceIndex: 1, type: 'dropoff' });
      expect(last).toMatchObject({ ok: true, rideCompleted: true, duplicate: false });

      expect(await poolRow(poolId)).toEqual({ pool_state: 'completed', claimed_by_driver_id: d });
      expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
      expect(await currentRide(d)).toBeNull();
      expect(await A.dispatch.acceptOffer({ offerId, driverId: d })).toEqual({
        ok: false,
        reason: 'trip_not_claimable',
      });
      expect(await guardsFor(poolC, { driverId: d })).toEqual([]);
    });
  });

  // ── Redis is a projection ──────────────────────────────────────────────────

  describe('reconcile (Redis loss / drift)', () => {
    it('rebuilds current_ride_id from the guard, clears orphans, expires lapsed offers', async () => {
      const { rideId } = await soloRide();
      const d = await onlineDriver();
      const offerId = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d });
      expect((await A.dispatch.acceptOffer({ offerId, driverId: d })).ok).toBe(true);

      const orphan = await onlineDriver();
      await redis.hset(`driver:state:${orphan}`, 'current_ride_id', randomUUID());
      await redis.hdel(`driver:state:${d}`, 'current_ride_id'); // lost projection

      const r2 = await soloRide();
      const lapsedDriver = await seedDriver(poolC);
      const lapsed = await insertOffer(poolC, { trip: { kind: 'solo', rideId: r2.rideId }, driverId: lapsedDriver });
      await backdateOffer(poolC, lapsed);

      const res = await A.projection.reconcile();
      expect(res.projected).toBeGreaterThanOrEqual(1);
      expect(res.cleared).toBeGreaterThanOrEqual(1);
      expect(await currentRide(d)).toBe(rideId);
      expect(await currentRide(orphan)).toBeNull();
      expect(await offerState(poolC, lapsed)).toBe('expired');

      // The projection never creates a presence hash for an offline driver.
      await redis.del(`driver:state:${d}`);
      await A.projection.reconcile();
      expect(await redis.exists(`driver:state:${d}`)).toBe(0);
    });

    it('Redis loss cannot permit a double assignment: Postgres alone decides', async () => {
      const { rideId } = await soloRide();
      const d1 = await onlineDriver();
      const d2 = await onlineDriver();
      const o1 = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d1 });
      const o2 = await insertOffer(poolC, { trip: { kind: 'solo', rideId }, driverId: d2 });
      expect((await A.dispatch.acceptOffer({ offerId: o1, driverId: d1 })).ok).toBe(true);
      await redis.del(`driver:state:${d1}`, `driver:state:${d2}`);
      expect(await B.dispatch.acceptOffer({ offerId: o2, driverId: d2 })).toEqual({
        ok: false,
        reason: 'trip_taken',
      });
      expect(await guardsFor(poolC, { rideId })).toHaveLength(1);
    });
  });
});
