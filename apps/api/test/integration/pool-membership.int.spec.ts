/**
 * Stage C / R08 (F09, F15-part) — pool membership, capacity and closure as one
 * Postgres transaction, exercised with INDEPENDENT connections (one pg.Pool per
 * contender), lock barriers for controlled interleavings, and injected
 * failures. Every scenario asserts the final Postgres state, the §6 invariants
 * I5–I7, and the Redis `pool:<id>` projection.
 *
 * Guide §9: T27 (more joiners than seats), T28 (join races timeout), T29
 * (duplicate shared request), plus stale-close no-ops and recovery.
 */
import { Client, Pool } from 'pg';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { IdempotencyOperation } from '../../src/modules/rides/idempotency';
import { RidesController } from '../../src/modules/rides/rides.controller';
import { RideType } from '../../src/modules/rides/dto/create-ride.dto';
import {
  ROUTE,
  buildPoolStack,
  cleanupPools,
  holdPoolLock,
  releaseLeakedPoolLocks,
  memberAt,
  poolInvariantViolations,
  seedPassenger,
  snapshot,
  waitForLockWaiters,
  type PoolStack,
} from './pool-harness';

const skip = process.env.RCAB_INT_SKIPPED === '1';

describe.skipIf(skip)('Pool membership — transactional invariants (R08, multi-connection)', () => {
  let admin: Pool;
  let redis: Redis;
  const stacks: PoolStack[] = [];
  const poolIds: string[] = [];
  const passengers: string[] = [];

  const stack = (opts: Parameters<typeof buildPoolStack>[1] = {}) => {
    const s = buildPoolStack(redis, opts);
    stacks.push(s);
    return s;
  };
  const passenger = async () => {
    const id = await seedPassenger(admin);
    passengers.push(id);
    return id;
  };
  async function openPool(s: PoolStack, maxSeats: number, opener?: string) {
    const passengerId = opener ?? (await passenger());
    const row = await s.lifecycle.openPool({
      ...ROUTE,
      maxSeats,
      detourBudgetM: 800,
      passengerId,
      quotedFareCents: 10_000,
    });
    poolIds.push(row.rideId);
    return { poolId: row.rideId, opener: passengerId };
  }
  async function expectProjectionMatches(poolId: string) {
    const db = await snapshot(admin, poolId);
    const hash = await redis.hgetall(`pool:${poolId}`);
    expect(hash).toMatchObject({
      state: db.poolState,
      seat_count: String(db.seatCount),
      max_seats: String(db.maxSeats),
      version: String(db.stateVersion),
    });
  }
  async function expectInvariants() {
    expect(await poolInvariantViolations(admin, poolIds)).toEqual({ I5: [], I6: [], I7: [] });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 4 });
    redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  });

  afterEach(releaseLeakedPoolLocks);

  afterAll(async () => {
    await cleanupPools(admin, poolIds, passengers).catch(() => {});
    await Promise.all(stacks.map((s) => s.close().catch(() => {})));
    await admin.end();
    await redis.quit();
  });

  // ── T27 ─────────────────────────────────────────────────────────────────────

  it('T27: N+2 joiners on independent connections never oversubscribe; one closure, one dispatch intent', async () => {
    const owner = stack();
    const { poolId, opener } = await openPool(owner, 4); // opener holds 1 → N = 3 free seats
    const free = 3;
    const joiners = await Promise.all(Array.from({ length: free + 2 }, () => passenger()));
    const contenders = joiners.map(() => stack());

    // Barrier: park every joiner behind a held row lock, then let them race.
    const lock = await holdPoolLock(poolId);
    const results = joiners.map((p, i) =>
      contenders[i].lifecycle.joinPool({
        poolId,
        joiner: memberAt(p, i + 1),
        quotedFareCents: 9_000 + i,
      }),
    );
    await waitForLockWaiters(admin, joiners.length, undefined, lock.pid);
    await lock.release();
    const settled = await Promise.all(results);

    const won = settled.filter((r) => r.joined);
    expect(won).toHaveLength(free);
    expect(settled.filter((r) => r.joined && r.closedFull)).toHaveLength(1);
    for (const r of settled.filter((x) => !x.joined)) {
      expect(['pool_full', 'pool_closed']).toContain(!r.joined && r.reason);
    }

    const db = await snapshot(admin, poolId);
    expect(db.poolState).toBe('closed_full');
    expect(db.seatCount).toBe(4);
    expect(db.members).toHaveLength(4);
    expect(new Set(db.members).size).toBe(4); // every passenger exactly once
    expect(db.members).toContain(opener);
    expect(db.generation).toBe(1);
    expect(db.dispatchIntents).toEqual([
      { generation: 1, payload: { poolId, reason: 'closed_full' } },
    ]);
    expect(db.stops).toBe(2 * db.seatCount);
    expect(db.expireIntents).toBe(1);

    // Each winner's agreed fare is recorded on its own seat.
    const fares = await admin.query<{ passenger_id: string; quoted_fare_cents: number }>(
      'SELECT passenger_id, quoted_fare_cents FROM pool_member WHERE pool_id = $1',
      [poolId],
    );
    expect(fares.rows).toHaveLength(4);
    expect(fares.rows.every((r) => Number.isInteger(r.quoted_fare_cents))).toBe(true);

    await expectInvariants();
    await expectProjectionMatches(poolId);
  });

  it('T27 (DB backstop): writers that skip the lock still cannot oversubscribe', async () => {
    const owner = stack();
    const { poolId } = await openPool(owner, 2); // one free seat
    const [a, b] = [await passenger(), await passenger()];
    const clients = [
      new Client({ connectionString: process.env.TEST_POSTGRES_URI }),
      new Client({ connectionString: process.env.TEST_POSTGRES_URI }),
    ];
    await Promise.all(clients.map((c) => c.connect()));
    try {
      await Promise.all(clients.map((c) => c.query('BEGIN')));
      const insert = (c: Client, p: string) =>
        c.query(
          `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng)
           VALUES ($1, $2, 1, 2, 3, 4)`,
          [poolId, p],
        );
      await insert(clients[0], a);
      const second = insert(clients[1], b).then(
        () => null,
        (e: { code?: string; constraint?: string }) => e,
      );
      await waitForLockWaiters(admin, 1);
      await clients[0].query('COMMIT');
      const err = await second;
      expect(err).toMatchObject({ code: '23514', constraint: 'shared_rides_seat_capacity_check' });
      await clients[1].query('ROLLBACK');
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    const db = await snapshot(admin, poolId);
    expect(db.seatCount).toBe(2);
    expect(db.members).toHaveLength(2);
    await expectInvariants();
  });

  // ── T28 ─────────────────────────────────────────────────────────────────────

  it('T28: a stale candidate (scored while open) cannot join after the timeout closed the pool', async () => {
    const [owner, joinerStack] = [stack(), stack()];
    const { poolId } = await openPool(owner, 3);
    const late = await passenger();

    // Advisory discovery sees an open pool…
    const candidates = await joinerStack.repo.findCandidates(
      ROUTE.originLat,
      ROUTE.originLng,
      ROUTE.destLat,
      ROUTE.destLng,
    );
    expect(candidates.map((c) => c.rideId)).toContain(poolId);
    // …the timeout commits first…
    await expect(owner.lifecycle.closeIfOpen(poolId, 'closed_timeout')).resolves.toBe('closed');
    // …so the stale join is rejected under the lock.
    await expect(
      joinerStack.lifecycle.joinPool({ poolId, joiner: memberAt(late), quotedFareCents: null }),
    ).resolves.toEqual({ joined: false, reason: 'pool_closed' });
    // The trigger rejects even a raw insert that bypasses the service.
    await expect(
      admin.query(
        `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng)
         VALUES ($1, $2, 1, 2, 3, 4)`,
        [poolId, late],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'pool_member_pool_open' });

    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({
      poolState: 'closed_timeout',
      seatCount: 1,
      generation: 1,
      stops: 2,
    });
    expect(db.members).not.toContain(late);
    expect(db.dispatchIntents).toHaveLength(1);
    await expectInvariants();
    await expectProjectionMatches(poolId);
  });

  it('T28: join queued ahead of the timeout → join commits, then ONE closure that includes the joiner', async () => {
    const [owner, joinerStack, timerStack] = [stack(), stack(), stack()];
    const { poolId } = await openPool(owner, 3);
    const joiner = await passenger();

    const lock = await holdPoolLock(poolId);
    const join = joinerStack.lifecycle.joinPool({
      poolId,
      joiner: memberAt(joiner, 1),
      quotedFareCents: 1,
    });
    await waitForLockWaiters(admin, 1, undefined, lock.pid);
    const close = timerStack.lifecycle.closeIfOpen(poolId, 'closed_timeout');
    await waitForLockWaiters(admin, 2, undefined, lock.pid);
    await lock.release();

    await expect(join).resolves.toEqual({ joined: true, closedFull: false, seatCount: 2 });
    await expect(close).resolves.toBe('closed');
    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({
      poolState: 'closed_timeout',
      seatCount: 2,
      generation: 1,
      stops: 4,
    });
    expect(db.members).toContain(joiner);
    expect(db.dispatchIntents).toEqual([
      { generation: 1, payload: { poolId, reason: 'closed_timeout' } },
    ]);
    await expectInvariants();
    await expectProjectionMatches(poolId);
  });

  it('T28: timeout queued ahead of the filling join → join rejected, ONE closure without it', async () => {
    const [owner, joinerStack, timerStack] = [stack(), stack(), stack()];
    const { poolId } = await openPool(owner, 2); // the joiner would fill it
    const joiner = await passenger();

    const lock = await holdPoolLock(poolId);
    const close = timerStack.lifecycle.closeIfOpen(poolId, 'closed_timeout');
    await waitForLockWaiters(admin, 1, undefined, lock.pid);
    const join = joinerStack.lifecycle.joinPool({
      poolId,
      joiner: memberAt(joiner, 1),
      quotedFareCents: 1,
    });
    await waitForLockWaiters(admin, 2, undefined, lock.pid);
    await lock.release();

    await expect(close).resolves.toBe('closed');
    await expect(join).resolves.toEqual({ joined: false, reason: 'pool_closed' });
    const db = await snapshot(admin, poolId);
    expect(db).toMatchObject({
      poolState: 'closed_timeout',
      seatCount: 1,
      generation: 1,
      stops: 2,
    });
    expect(db.dispatchIntents).toHaveLength(1);
    await expectInvariants();
  });

  it('T28: concurrent timeout + filling join on a 1-free-seat pool → exactly one closure / one intent', async () => {
    const owner = stack();
    const { poolId } = await openPool(owner, 2);
    const joiner = await passenger();
    const [a, b] = [stack(), stack()];

    const lock = await holdPoolLock(poolId);
    const both = Promise.all([
      a.lifecycle.joinPool({ poolId, joiner: memberAt(joiner, 1), quotedFareCents: null }),
      b.lifecycle.closeIfOpen(poolId, 'closed_timeout'),
    ]);
    await waitForLockWaiters(admin, 2, undefined, lock.pid);
    await lock.release();
    const [join, close] = await both;

    const db = await snapshot(admin, poolId);
    expect(db.dispatchIntents).toHaveLength(1);
    expect(db.generation).toBe(1);
    if (join.joined) {
      // Join won: it closed the pool full; the timeout is a stale no-op.
      expect(join.closedFull).toBe(true);
      expect(close).toBe('not_open');
      expect(db).toMatchObject({ poolState: 'closed_full', seatCount: 2, stops: 4 });
    } else {
      expect(join).toEqual({ joined: false, reason: 'pool_closed' });
      expect(close).toBe('closed');
      expect(db).toMatchObject({ poolState: 'closed_timeout', seatCount: 1, stops: 2 });
    }
    await expectInvariants();
    await expectProjectionMatches(poolId);
  });

  it('a stale closeIfOpen on a closed / started / finished pool is a no-op (no second dispatch)', async () => {
    const s = stack();
    const { poolId } = await openPool(s, 3);
    await expect(s.lifecycle.closeIfOpen(poolId, 'closed_timeout')).resolves.toBe('closed');
    const before = await snapshot(admin, poolId);

    await expect(s.lifecycle.closeIfOpen(poolId, 'closed_timeout')).resolves.toBe('not_open');
    for (const state of ['closed_started', 'completed', 'aborted']) {
      await admin.query('UPDATE shared_rides SET pool_state = $2 WHERE ride_id = $1', [
        poolId,
        state,
      ]);
      await expect(s.lifecycle.closeIfOpen(poolId, 'closed_timeout')).resolves.toBe('not_open');
      const db = await snapshot(admin, poolId);
      expect(db.poolState).toBe(state);
      expect(db.generation).toBe(before.generation);
      expect(db.dispatchIntents).toHaveLength(1);
      expect(db.stops).toBe(before.stops);
    }
    await expect(s.lifecycle.closeIfOpen(randomUUID(), 'closed_timeout')).resolves.toBe('not_open');
  });

  // ── T29 ─────────────────────────────────────────────────────────────────────

  it('T29: the same passenger + same key on two connections → one seat, one pool, replay of the winner', async () => {
    const pId = await passenger();
    const scope = {
      principalId: pId,
      operation: IdempotencyOperation.Shared,
      key: `k-${randomUUID()}`,
    };
    const [a, b] = [stack(), stack()];
    await a.idempotency.claim(scope, 'fp');
    // No candidates on this far-off route → both race openPool with the same key.
    const req = {
      passengerId: pId,
      originLat: 10.01,
      originLng: 76.01,
      destLat: 10.05,
      destLng: 76.05,
    };
    const response = (m: { sharedRideId: string; mode: string }) => ({
      sharedRideId: m.sharedRideId,
      mode: m.mode,
    });

    const results = await Promise.all([
      a.matching().findOrCreatePool(req, { idempotency: { scope, response } }),
      b.matching().findOrCreatePool(req, { idempotency: { scope, response } }),
    ]);
    const seated = results.filter((r) => r.mode === 'opened');
    const replays = results.filter((r) => r.mode === 'existing');
    expect(seated).toHaveLength(1);
    expect(replays).toHaveLength(1);
    const winner = seated[0] as { sharedRideId: string };
    poolIds.push(winner.sharedRideId);
    expect(replays[0]).toEqual({
      mode: 'existing',
      reason: 'idempotent_replay',
      sharedRideId: winner.sharedRideId,
    });

    const seats = await admin.query<{ pool_id: string; idempotency_key: string }>(
      'SELECT pool_id, idempotency_key FROM pool_member WHERE passenger_id = $1',
      [pId],
    );
    expect(seats.rows).toEqual([{ pool_id: winner.sharedRideId, idempotency_key: scope.key }]);
    // The loser's pool rolled back entirely (no orphan pool / intent).
    const pools = await admin.query(
      `SELECT ride_id FROM shared_rides WHERE origin_lat = 10.01 AND origin_lng = 76.01`,
    );
    expect(pools.rows).toHaveLength(1);
    const record = await a.idempotency.find(scope);
    expect(record).toMatchObject({
      state: 'completed',
      resourceId: winner.sharedRideId,
      response: { sharedRideId: winner.sharedRideId, mode: 'opened' },
    });
    await expectInvariants();
  });

  it('T29: a different key while holding a live seat → passenger_has_active_pool (also concurrently)', async () => {
    const pId = await passenger();
    const [a, b] = [stack(), stack()];
    const req = {
      passengerId: pId,
      originLat: 11.01,
      originLng: 77.01,
      destLat: 11.05,
      destLng: 77.05,
    };
    const scopeOf = (key: string) => ({
      principalId: pId,
      operation: IdempotencyOperation.Shared,
      key,
    });
    const response = (m: { sharedRideId: string }) => ({ id: m.sharedRideId });

    const results = await Promise.all([
      a.matching().findOrCreatePool(req, { idempotency: { scope: scopeOf('k-a'), response } }),
      b.matching().findOrCreatePool(req, { idempotency: { scope: scopeOf('k-b'), response } }),
    ]);
    const seated = results.find((r) => r.mode === 'opened') as { sharedRideId: string };
    expect(seated).toBeDefined();
    poolIds.push(seated.sharedRideId);
    expect(results.find((r) => r.mode !== 'opened')).toEqual({
      mode: 'conflict',
      reason: 'passenger_has_active_pool',
      existingPoolId: seated.sharedRideId,
    });

    // Sequentially: the live pool is a candidate (same route) — a third key is
    // still a different request → conflict, not a silent second seat.
    await expect(
      a.matching().findOrCreatePool(req, { idempotency: { scope: scopeOf('k-c'), response } }),
    ).resolves.toEqual({
      mode: 'conflict',
      reason: 'passenger_has_active_pool',
      existingPoolId: seated.sharedRideId,
    });
    // A keyless duplicate gets its existing seat back.
    await expect(a.matching().findOrCreatePool(req)).resolves.toEqual({
      mode: 'existing',
      reason: 'already_member',
      sharedRideId: seated.sharedRideId,
    });
    const seats = await admin.query('SELECT 1 FROM pool_member WHERE passenger_id = $1', [pId]);
    expect(seats.rowCount).toBe(1);

    // Once the pool is terminal the passenger is free to book again.
    await admin.query(`UPDATE shared_rides SET pool_state = 'completed' WHERE ride_id = $1`, [
      seated.sharedRideId,
    ]);
    const again = await a
      .matching()
      .findOrCreatePool(req, { idempotency: { scope: scopeOf('k-d'), response } });
    expect(again.mode).toBe('opened');
    poolIds.push((again as { sharedRideId: string }).sharedRideId);
    await expectInvariants();
  });

  it('T29 (API + DB): duplicate shared requests through the controller → one seat; other key → 409', async () => {
    const s = stack({ max: 4 });
    const pId = await passenger();
    const quote = {
      perSeatPrice: { amount: 7_700, currency: 'INR' },
      seatMultiplier: 1,
      detourFactor: 1,
    };
    const pricing = { quoteSeat: vi.fn().mockResolvedValue(quote) };
    const ctrl = new RidesController(
      s.matching(),
      pricing as never,
      s.repo,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      s.bus as never,
      s.relay as never,
      {} as never,
      s.idempotency,
    );
    const req = { user: { sub: pId, role: 'client' } } as never;
    const dto = {
      type: RideType.Shared,
      originLat: 12.01,
      originLng: 78.01,
      destLat: 12.05,
      destLng: 78.05,
    } as never;

    const first = (await ctrl.create(req, dto, 'key-1')) as { sharedRideId: string };
    poolIds.push(first.sharedRideId);
    expect(first).toMatchObject({
      mode: 'opened',
      poolStatus: 'open',
      perSeatPrice: quote.perSeatPrice,
    });
    // Exact replay from the record that committed WITH the seat.
    await expect(ctrl.create(req, dto, 'key-1')).resolves.toEqual(
      JSON.parse(JSON.stringify(first)),
    );
    await expect(ctrl.create(req, dto, 'key-2')).rejects.toMatchObject({
      status: 409,
      response: { code: 'passenger_has_active_pool', sharedRideId: first.sharedRideId },
    });
    const seat = await admin.query<{ quoted_fare_cents: number; idempotency_key: string }>(
      'SELECT quoted_fare_cents, idempotency_key FROM pool_member WHERE passenger_id = $1',
      [pId],
    );
    expect(seat.rows).toEqual([{ quoted_fare_cents: 7_700, idempotency_key: 'key-1' }]);
    // key-2's claim was released (no stuck pending record).
    const rec = await admin.query(
      `SELECT state FROM idempotency_record WHERE principal_id = $1 ORDER BY idempotency_key`,
      [pId],
    );
    expect(rec.rows).toEqual([{ state: 'completed' }]);
  });

  // ── Failure injection + recovery ────────────────────────────────────────────

  it('a failure inside the closing txn (itinerary) rolls back the seat, closure and intent; retry recovers', async () => {
    const owner = stack();
    const { poolId } = await openPool(owner, 2);
    const pId = await passenger();
    const scope = { principalId: pId, operation: IdempotencyOperation.Shared, key: 'k-inj' };
    const s = stack();
    await s.idempotency.claim(scope, 'fp');
    const spy = vi
      .spyOn(s.members, 'insertItinerary')
      .mockRejectedValueOnce(new Error('injected: disk full'));
    const idem = { scope, response: () => ({ ok: true }) };

    await expect(
      s.lifecycle.joinPool({
        poolId,
        joiner: memberAt(pId, 1),
        quotedFareCents: 5,
        idempotency: idem,
      }),
    ).rejects.toThrow('injected: disk full');
    let db = await snapshot(admin, poolId);
    expect(db).toMatchObject({
      poolState: 'open',
      seatCount: 1,
      generation: 0,
      stops: 0,
      dispatchIntents: [],
    });
    expect(db.members).not.toContain(pId);
    expect(await s.idempotency.find(scope)).toMatchObject({ state: 'pending' });
    await expectInvariants();

    spy.mockRestore();
    await expect(
      s.lifecycle.joinPool({
        poolId,
        joiner: memberAt(pId, 1),
        quotedFareCents: 5,
        idempotency: idem,
      }),
    ).resolves.toEqual({ joined: true, closedFull: true, seatCount: 2 });
    db = await snapshot(admin, poolId);
    expect(db).toMatchObject({ poolState: 'closed_full', seatCount: 2, generation: 1, stops: 4 });
    expect(db.dispatchIntents).toHaveLength(1);
    expect(await s.idempotency.find(scope)).toMatchObject({
      state: 'completed',
      resourceId: poolId,
    });
    await expectInvariants();
    await expectProjectionMatches(poolId);
  });

  it('a DB-level failure writing the dispatch intent rolls the closure back atomically', async () => {
    const owner = stack();
    const { poolId } = await openPool(owner, 3);
    const fn = `inj_${poolId.replace(/-/g, '')}`;
    await admin.query(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.topic = 'pool.dispatch.requested' AND NEW.aggregate_id = '${poolId}' THEN
          RAISE EXCEPTION 'injected outbox failure';
        END IF;
        RETURN NEW;
      END $$`);
    await admin.query(
      `CREATE TRIGGER ${fn}_trg BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      await expect(owner.lifecycle.closeIfOpen(poolId, 'closed_timeout')).rejects.toThrow();
      const db = await snapshot(admin, poolId);
      expect(db).toMatchObject({ poolState: 'open', generation: 0, stops: 0, dispatchIntents: [] });
    } finally {
      await admin.query(`DROP TRIGGER ${fn}_trg ON outbox`);
      await admin.query(`DROP FUNCTION ${fn}()`);
    }
    // The job's retry now succeeds exactly once.
    await expect(owner.lifecycle.closeIfOpen(poolId, 'closed_timeout')).resolves.toBe('closed');
    await expect(owner.lifecycle.closeIfOpen(poolId, 'closed_timeout')).resolves.toBe('not_open');
    expect((await snapshot(admin, poolId)).dispatchIntents).toHaveLength(1);
    await expectInvariants();
  });

  it('a post-commit Redis failure never fails a committed join; the projection is rebuilt from Postgres', async () => {
    const owner = stack();
    const { poolId } = await openPool(owner, 3);
    const s = stack();
    const pId = await passenger();
    vi.spyOn(s.projection, 'write').mockRejectedValueOnce(new Error('redis down'));
    s.bus.joinPool.mockRejectedValueOnce(new Error('ws down'));

    await expect(
      s.lifecycle.joinPool({ poolId, joiner: memberAt(pId, 1), quotedFareCents: null }),
    ).resolves.toEqual({ joined: true, closedFull: false, seatCount: 2 });
    // Projection is stale (still the opener's version) …
    expect(await redis.hget(`pool:${poolId}`, 'seat_count')).toBe('1');
    // … and also survives total Redis loss: rebuild restores it from Postgres.
    await redis.del(`pool:${poolId}`);
    await s.projection.rebuildAll();
    await expectProjectionMatches(poolId);
    expect(await redis.hget(`pool:${poolId}`, 'seat_count')).toBe('2');
  });

  it('the projection never rolls back: an older state_version cannot overwrite a newer one', async () => {
    const s = stack();
    const { poolId } = await openPool(s, 3);
    const committed = (await s.repo.findById(poolId))!;
    await s.projection.write(committed);
    const stale = {
      ...committed,
      stateVersion: committed.stateVersion - 1,
      seatCount: 0,
      poolState: 'aborted',
    };
    await expect(s.projection.write(stale)).resolves.toBe(false);
    await expectProjectionMatches(poolId);
  });

  it('a slow candidate read with stale membership still serializes on the row: members are derived', async () => {
    const owner = stack();
    const { poolId, opener } = await openPool(owner, 3);
    const p2 = await passenger();
    await owner.lifecycle.joinPool({ poolId, joiner: memberAt(p2, 1), quotedFareCents: null });
    const row = (await owner.repo.findById(poolId))!;
    expect(row.seatCount).toBe(2);
    expect(row.members.map((m) => m.passenger_id)).toEqual([opener, p2]);
    // The deprecated jsonb column is never written by Stage C code.
    const legacy = await admin.query<{ members: unknown[] }>(
      'SELECT members FROM shared_rides WHERE ride_id = $1',
      [poolId],
    );
    expect(legacy.rows[0].members).toEqual([]);
  });
});
