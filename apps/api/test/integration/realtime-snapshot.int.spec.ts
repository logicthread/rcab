// R09 / F10 (T30, T31-server, T32-server): authorized subscription + Postgres
// snapshot recovery through the REAL gateway handlers, and the explicit shared
// offer protocol (assigned / lost) through the DI-wired DispatchService —
// against the booted AppModule with real Postgres + Redis. Sockets are
// stand-ins recording joins / emits (the api package ships no Socket.IO
// client); every decision under test is made by the real handlers and SQL.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Pool } from 'pg';
import Redis from 'ioredis';
import type { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/infra/db/drizzle.module';
import { REDIS } from '../../src/infra/redis/redis.module';
import { FirebaseAdminService } from '../../src/infra/firebase/firebase-admin.service';
import { GoogleVerifierService } from '../../src/infra/google/google-verifier.service';
import { RealtimeGateway } from '../../src/modules/realtime/realtime.gateway';
import { RealtimeBus } from '../../src/modules/realtime/realtime.bus';
import { RealtimeSnapshotService } from '../../src/modules/realtime/realtime-snapshot.service';
import type {
  DriverAssignmentSnapshot,
  PoolSnapshot,
  RideSnapshot,
} from '../../src/modules/realtime/realtime.protocol';
import { DispatchService } from '../../src/modules/dispatch/dispatch.service';
import { RideLifecycleService } from '../../src/modules/ride-lifecycle/ride-lifecycle.service';
import {
  insertOffer,
  seedClient,
  seedClosedPool,
  seedDriver,
  seedSoloRide,
} from './support/dispatch-fixtures';

const skip = process.env.RCAB_INT_SKIPPED === '1';

let moduleRef: TestingModule;
let app: INestApplication;
let pool: Pool;
let redis: Redis;

beforeAll(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URI });
  redis = new Redis(process.env.TEST_REDIS_URL!);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(REDIS)
    .useValue(redis)
    .overrideProvider(FirebaseAdminService)
    .useValue({ verifyIdToken: vi.fn() })
    .overrideProvider(GoogleVerifierService)
    .useValue({ verifyIdToken: vi.fn() })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeSocket {
  socket: Socket;
  rooms: Set<string>;
  emitted: Array<[string, unknown]>;
}

function fakeSocket(userId: string, role: 'driver' | 'client' = 'client'): FakeSocket {
  const rooms = new Set<string>();
  const emitted: Array<[string, unknown]> = [];
  const socket = {
    data: { userId, role },
    emit: vi.fn((event: string, payload: unknown) => {
      emitted.push([event, payload]);
      return true;
    }),
    join: vi.fn(async (r: string | string[]) => {
      for (const x of Array.isArray(r) ? r : [r]) rooms.add(x);
    }),
    leave: vi.fn(async (r: string) => {
      rooms.delete(r);
    }),
    disconnect: vi.fn(),
    handshake: { auth: {}, headers: {} },
  } as unknown as Socket;
  return { socket, rooms, emitted };
}

/** Spy every bus delivery without needing a live Socket.IO server. */
function spyBus() {
  const bus = moduleRef.get(RealtimeBus);
  return {
    toDriver: vi.spyOn(bus, 'toDriver').mockImplementation(() => undefined),
    toPool: vi.spyOn(bus, 'toPool').mockImplementation(() => undefined),
    toRide: vi.spyOn(bus, 'toRide').mockImplementation(() => undefined),
    toUser: vi.spyOn(bus, 'toUser').mockImplementation(() => undefined),
  };
}

async function confirmAllStops(poolId: string, driverId: string): Promise<void> {
  const lifecycle = moduleRef.get(RideLifecycleService);
  const { rows } = await pool.query<{ sequence_index: number; type: 'pickup' | 'dropoff' }>(
    'SELECT sequence_index, type FROM ride_stops WHERE ride_id = $1 ORDER BY sequence_index',
    [poolId],
  );
  for (const r of rows) {
    const res = await lifecycle.confirmStop({
      rideId: poolId,
      driverId,
      sequenceIndex: r.sequence_index,
      type: r.type,
    });
    expect(res.ok).toBe(true);
  }
}

describe.skipIf(skip)('pool:subscribe — authorized, snapshot-first (T30)', () => {
  it('an uninvited user cannot subscribe: no room, no snapshot, no existence leak', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const { poolId } = await seedClosedPool(pool, { members: 2 });
    const stranger = fakeSocket(await seedClient(pool));

    const ack = await gateway.handlePoolSubscribe({ sharedRideId: poolId }, stranger.socket);
    expect(ack).toEqual({ ok: false, reason: 'not_found' });
    // Same answer for a pool that does not exist at all.
    expect(
      await gateway.handlePoolSubscribe({ sharedRideId: randomUUID() }, stranger.socket),
    ).toEqual({ ok: false, reason: 'not_found' });
    expect(stranger.rooms.size).toBe(0);
    expect(stranger.emitted).toEqual([]);
  });

  it('a first-time member socket (no create-time join) gets rooms + the committed snapshot', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const { poolId, passengers } = await seedClosedPool(pool, { members: 2 });
    const me = fakeSocket(passengers[0]);

    const ack = await gateway.handlePoolSubscribe({ sharedRideId: poolId }, me.socket);
    expect(ack.ok).toBe(true);
    expect([...me.rooms].sort()).toEqual([`pool:${poolId}`, `ride:${poolId}`].sort());
    const snap = (ack as { snapshot: PoolSnapshot }).snapshot;
    const { rows } = await pool.query<{ state_version: string }>(
      'SELECT state_version FROM shared_rides WHERE ride_id = $1',
      [poolId],
    );
    expect(snap).toMatchObject({
      sharedRideId: poolId,
      version: Number(rows[0].state_version),
      poolStatus: 'closed_full',
      seatCount: 2,
      terminal: false,
      driverId: null,
    });
    expect(me.emitted).toEqual([['pool:snapshot', snap]]);
  });

  it("the member's fare comes from agreed_fare_cents (post-0017 members have no legacy quoted fare)", async () => {
    const snapshots = moduleRef.get(RealtimeSnapshotService);
    const { poolId, passengers } = await seedClosedPool(pool, { members: 2 });
    const { rows } = await pool.query<{ agreed: number | null; quoted: number | null }>(
      `SELECT agreed_fare_cents AS agreed, quoted_fare_cents AS quoted
         FROM pool_member WHERE pool_id = $1 AND passenger_id = $2`,
      [poolId, passengers[0]],
    );
    expect(rows[0].agreed).not.toBeNull();
    expect(rows[0].quoted).toBeNull();
    const snap = (await snapshots.poolSnapshot(poolId, passengers[0]))!;
    expect(snap.me.quotedFareCents).toBe(rows[0].agreed);
  });

  it("a member's snapshot never exposes co-passengers' identity or coordinates", async () => {
    const snapshots = moduleRef.get(RealtimeSnapshotService);
    const { poolId, passengers } = await seedClosedPool(pool, { members: 3, maxSeats: 3 });
    const snap = (await snapshots.poolSnapshot(poolId, passengers[1]))!;

    expect(snap.itinerary).toHaveLength(6);
    const mine = snap.itinerary.filter((s) => s.mine);
    const theirs = snap.itinerary.filter((s) => !s.mine);
    expect(mine).toHaveLength(2);
    for (const s of mine) expect(typeof s.lat).toBe('number');
    for (const s of theirs) {
      expect(s).not.toHaveProperty('lat');
      expect(s).not.toHaveProperty('lng');
      expect(s).not.toHaveProperty('passengerId');
    }
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(passengers[0]);
    expect(serialized).not.toContain(passengers[2]);
  });

  it('a reconnect after a missed claim + completion restores the terminal state from Postgres', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const dispatch = moduleRef.get(DispatchService);
    spyBus();
    const { poolId, passengers } = await seedClosedPool(pool, { members: 2 });
    const first = fakeSocket(passengers[0]);
    const before = (
      (await gateway.handlePoolSubscribe({ sharedRideId: poolId }, first.socket)) as {
        snapshot: PoolSnapshot;
      }
    ).snapshot;

    // While the passenger is offline: a driver wins the pool and drives it to the end.
    const driverId = await seedDriver(pool);
    const offerId = await insertOffer(pool, {
      trip: { kind: 'shared', sharedRideId: poolId },
      driverId,
    });
    expect(await dispatch.acceptOffer({ offerId, driverId })).toMatchObject({ ok: true });
    await confirmAllStops(poolId, driverId);

    // Fresh socket (new connection id, no rooms): the snapshot is the truth.
    const again = fakeSocket(passengers[0]);
    const ack = await gateway.handlePoolSubscribe({ sharedRideId: poolId }, again.socket);
    const after = (ack as { snapshot: PoolSnapshot }).snapshot;
    expect(after).toMatchObject({
      poolStatus: 'completed',
      terminal: true,
      driverId,
      me: { active: false },
    });
    expect(after.completedAt).not.toBeNull();
    expect(after.itinerary.every((s) => s.confirmed)).toBe(true);
    expect(after.vehicle).toMatchObject({ type: 'cab_sedan' });
    // Strictly newer than anything delivered before the gap → client applies it.
    expect(after.version).toBeGreaterThan(before.version);
  });

  it('every committed join bumps the pool version (so stale pool:update deliveries are droppable)', async () => {
    const snapshots = moduleRef.get(RealtimeSnapshotService);
    const poolId = randomUUID();
    await pool.query(
      `INSERT INTO shared_rides (ride_id, max_seats, pool_state, origin_lat, origin_lng,
                                 dest_lat, dest_lng, members)
       VALUES ($1, 3, 'open', 22.57, 88.36, 22.58, 88.37, '[]'::jsonb)`,
      [poolId],
    );
    const versions: number[] = [];
    for (let i = 0; i < 2; i++) {
      const p = await seedClient(pool);
      await pool.query(
        `INSERT INTO pool_member (pool_id, passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, agreed_fare_cents)
         VALUES ($1, $2, 22.57, 88.36, 22.58, 88.37, 10000)`,
        [poolId, p],
      );
      const u = (await snapshots.poolUpdate(poolId))!;
      expect(u.seatCount).toBe(i + 1);
      versions.push(u.version);
    }
    expect(versions[1]).toBeGreaterThan(versions[0]);
  });
});

describe.skipIf(skip)('ride:subscribe — solo snapshot', () => {
  it('passenger and bound driver only; the snapshot version is the status rank', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const dispatch = moduleRef.get(DispatchService);
    const bus = spyBus();
    const passenger = await seedClient(pool);
    const rideId = await seedSoloRide(pool, passenger);

    const stranger = fakeSocket(await seedClient(pool));
    expect(await gateway.handleRideSubscribe({ rideId }, stranger.socket)).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(stranger.rooms.size).toBe(0);

    const me = fakeSocket(passenger);
    const requested = (
      (await gateway.handleRideSubscribe({ rideId }, me.socket)) as { snapshot: RideSnapshot }
    ).snapshot;
    expect(me.rooms.has(`ride:${rideId}`)).toBe(true);
    expect(requested).toMatchObject({
      rideId,
      status: 'requested',
      terminal: false,
      driverId: null,
    });

    const driverId = await seedDriver(pool);
    const offerId = await insertOffer(pool, { trip: { kind: 'solo', rideId }, driverId });
    expect(await dispatch.acceptOffer({ offerId, driverId })).toMatchObject({ ok: true });
    // The incremental event carries the same version scheme as the snapshot.
    const accepted = bus.toRide.mock.calls.find(([, e]) => e === 'ride_state_changed');
    expect(accepted?.[2]).toMatchObject({ state: 'accepted' });
    const evVersion = (accepted?.[2] as { version: number }).version;

    const snap = (
      (await gateway.handleRideSubscribe({ rideId }, fakeSocket(passenger).socket)) as {
        snapshot: RideSnapshot;
      }
    ).snapshot;
    expect(snap).toMatchObject({ status: 'accepted', driverId });
    expect(snap.version).toBe(evVersion);
    expect(snap.version).toBeGreaterThan(requested.version);
    // The bound driver may follow the ride too.
    expect(
      await gateway.handleRideSubscribe({ rideId }, fakeSocket(driverId, 'driver').socket),
    ).toMatchObject({ ok: true });
  });
});

describe.skipIf(skip)('ride:subscribe — scheduled searching snapshot (RCAB-E8.S13)', () => {
  it('carries retryUntil = scheduled_for + the policy cutoff while searching, null for a normal ride and after no_driver', async () => {
    const gateway = moduleRef.get(RealtimeGateway);
    const passenger = await seedClient(pool);
    const snapshotOf = async (rideId: string) =>
      (
        (await gateway.handleRideSubscribe({ rideId }, fakeSocket(passenger).socket)) as {
          snapshot: RideSnapshot;
        }
      ).snapshot;

    const normal = await seedSoloRide(pool, passenger);
    expect((await snapshotOf(normal)).retryUntil).toBeNull();

    const rideId = await seedSoloRide(pool, passenger);
    const pickup = new Date(Date.now() + 5 * 60_000);
    await pool.query(`UPDATE rides SET type = 'scheduled', scheduled_for = $2 WHERE id = $1`, [rideId, pickup]);
    expect((await snapshotOf(rideId)).retryUntil).toBe(new Date(pickup.getTime() + 30 * 60_000).toISOString());

    // not woken yet (generation 0): nothing is searching, so no cutoff is shown
    await pool.query(`UPDATE rides SET dispatch_generation = 0 WHERE id = $1`, [rideId]);
    expect((await snapshotOf(rideId)).retryUntil).toBeNull();

    await pool.query(`UPDATE rides SET dispatch_generation = 2, status = 'no_driver' WHERE id = $1`, [rideId]);
    expect(await snapshotOf(rideId)).toMatchObject({ status: 'no_driver', terminal: true, retryUntil: null });
  });
});

describe.skipIf(skip)(
  'shared offer protocol + driver assignment snapshot (T31 server side)',
  () => {
    it('winner: explicit `assigned` with itinerary; loser: `lost`; members: versioned claim', async () => {
      const dispatch = moduleRef.get(DispatchService);
      const bus = spyBus();
      const { poolId } = await seedClosedPool(pool, { members: 2 });
      const winner = await seedDriver(pool);
      const loser = await seedDriver(pool);
      const trip = { kind: 'shared', sharedRideId: poolId } as const;
      const winOffer = await insertOffer(pool, { trip, driverId: winner });
      const loseOffer = await insertOffer(pool, { trip, driverId: loser });

      expect(await dispatch.acceptOffer({ offerId: winOffer, driverId: winner })).toMatchObject({
        ok: true,
        replay: false,
      });

      const outcomeTo = (d: string) =>
        bus.toDriver.mock.calls
          .filter(([to, e]) => to === d && e === 'ride_offer_outcome')
          .map(([, , p]) => p as Record<string, unknown>);
      const [assigned] = outcomeTo(winner);
      expect(assigned).toMatchObject({
        offerId: winOffer,
        outcome: 'assigned',
        tripKind: 'shared',
        tripId: poolId,
        generation: 1,
        assignment: { tripKind: 'shared', sharedRideId: poolId, offerId: winOffer },
      });
      const stops = (assigned.assignment as { stops: unknown[] }).stops;
      expect(stops).toHaveLength(4);
      expect(outcomeTo(loser)).toEqual([
        {
          offerId: loseOffer,
          outcome: 'lost',
          tripKind: 'shared',
          tripId: poolId,
          reason: 'taken',
        },
      ]);
      // The winner is never told its own offer was revoked.
      expect(
        bus.toDriver.mock.calls.some(([to, e]) => to === winner && e === 'ride_offer_revoked'),
      ).toBe(false);
      const update = bus.toPool.mock.calls.find(([id, e]) => id === poolId && e === 'pool:update');
      expect(update?.[2]).toMatchObject({
        sharedRideId: poolId,
        driverId: winner,
        terminal: false,
      });

      // The loser's late accept is answered `lost` too (ack + event agree).
      expect(await dispatch.acceptOffer({ offerId: loseOffer, driverId: loser })).toEqual({
        ok: false,
        reason: 'trip_taken',
      });
      expect(outcomeTo(loser).at(-1)).toMatchObject({ outcome: 'lost', reason: 'trip_taken' });
    });

    it('driver reconnect / driver:sync restores the active assignment; completion clears it', async () => {
      const gateway = moduleRef.get(RealtimeGateway);
      const dispatch = moduleRef.get(DispatchService);
      spyBus();
      const { poolId } = await seedClosedPool(pool, { members: 2 });
      const driverId = await seedDriver(pool);
      const offerId = await insertOffer(pool, {
        trip: { kind: 'shared', sharedRideId: poolId },
        driverId,
      });

      // Before the accept: nothing to restore.
      const idle = fakeSocket(driverId, 'driver');
      expect(await gateway.handleDriverSync(idle.socket)).toEqual({ driverId, assignment: null });

      await dispatch.acceptOffer({ offerId, driverId });
      // Pickup #0 confirmed, then the app is killed and cold-starts.
      const lifecycle = moduleRef.get(RideLifecycleService);
      await lifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 0, type: 'pickup' });

      const cold = fakeSocket(driverId, 'driver');
      const snap = (await gateway.handleDriverSync(cold.socket)) as DriverAssignmentSnapshot;
      expect(snap.assignment).toMatchObject({
        tripKind: 'shared',
        sharedRideId: poolId,
        offerId,
        generation: 1,
        poolStatus: 'closed_started',
      });
      const restored = (snap.assignment as { stops: Array<{ confirmed: boolean }> }).stops;
      expect(restored.map((s) => s.confirmed)).toEqual([true, false, false, false]);
      expect(cold.emitted).toEqual([['driver:assignment', snap]]);

      // A wrong-driver socket sees only its own (empty) assignment.
      const other = await seedDriver(pool);
      expect(await gateway.handleDriverSync(fakeSocket(other, 'driver').socket)).toEqual({
        driverId: other,
        assignment: null,
      });

      // Finish the trip: the guard is released and the snapshot says so.
      const { rows } = await pool.query<{ sequence_index: number; type: 'pickup' | 'dropoff' }>(
        `SELECT sequence_index, type FROM ride_stops
        WHERE ride_id = $1 AND confirmed_at IS NULL ORDER BY sequence_index`,
        [poolId],
      );
      for (const r of rows) {
        await lifecycle.confirmStop({
          rideId: poolId,
          driverId,
          sequenceIndex: r.sequence_index,
          type: r.type,
        });
      }
      expect(await gateway.handleDriverSync(fakeSocket(driverId, 'driver').socket)).toEqual({
        driverId,
        assignment: null,
      });
    });
  },
);
