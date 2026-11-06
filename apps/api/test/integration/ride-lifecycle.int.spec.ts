import { Pool } from 'pg';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DISPATCH_QUEUE } from '../../src/modules/dispatch/dispatch.service';
import type { SharedRideOfferPayload } from '../../src/modules/dispatch/dispatch.types';
import { RealtimeSnapshotService } from '../../src/modules/realtime/realtime-snapshot.service';
import { RideLifecycleService } from '../../src/modules/ride-lifecycle/ride-lifecycle.service';
import {
  buildDispatch,
  guardsFor,
  insertOffer,
  makeBus,
  markOnline,
  seedClosedPool,
  seedDriver,
  type Bus,
  type DispatchHarness,
} from './support/dispatch-fixtures';

const skip = process.env.RCAB_INT_SKIPPED === '1';

function parseRedis(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

describe.skipIf(skip)(
  'RideLifecycleService — integration (full pool → 2 pickups + 2 drops → completed)',
  () => {
    let pg: Pool;
    let redis: Redis;
    let dispatchQueue: Queue;
    let bus: Bus;
    let h: DispatchHarness;
    let rideLifecycle: RideLifecycleService;

    beforeAll(async () => {
      pg = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 4 });
      redis = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: null });
      dispatchQueue = new Queue(`${DISPATCH_QUEUE}-lifecycle-${randomUUID().slice(0, 8)}`, {
        connection: parseRedis(process.env.TEST_REDIS_URL!),
      });
      bus = makeBus();
      h = buildDispatch(pg, redis, dispatchQueue, bus);
      rideLifecycle = new RideLifecycleService(
        h.stops,
        h.assignments,
        bus as never,
        redis,
        h.db,
        h.poolProjection,
        new RealtimeSnapshotService(h.db, bus as never),
      );
    });

    afterAll(async () => {
      await dispatchQueue?.obliterate({ force: true }).catch(() => {});
      await dispatchQueue?.close().catch(() => {});
      await pg.end();
      await redis.quit();
    });

    /** A dispatched pool claimed by a fresh driver through the real offer accept. */
    async function claimedPool(members: number) {
      const { poolId } = await seedClosedPool(pg, { members, lat: 22.5727, lng: 88.364 });
      const driverId = await seedDriver(pg);
      await markOnline(redis, driverId);
      const offerId = await insertOffer(pg, {
        trip: { kind: 'shared', sharedRideId: poolId },
        driverId,
      });
      const accepted = await h.dispatch.acceptOffer({ offerId, driverId });
      expect(accepted).toMatchObject({ ok: true, replay: false });
      return { poolId, driverId };
    }

    async function poolState(poolId: string) {
      const { rows } = await pg.query<{ pool_state: string; completed_at: Date | null }>(
        'SELECT pool_state, completed_at FROM shared_rides WHERE ride_id = $1',
        [poolId],
      );
      return rows[0];
    }

    it('full lifecycle: pool dispatch → accept → 2 pickups + 2 drops → pool_state=completed', async () => {
      // 1. A closed pool with two members and its persisted itinerary.
      const { poolId } = await seedClosedPool(pg, { members: 2, lat: 22.5727, lng: 88.364 });
      const driverId = await seedDriver(pg);
      await markOnline(redis, driverId);
      await redis.geoadd('active_drivers', 88.3641, 22.5728, driverId);

      // 2. Wave 1 offers it to the nearby eligible driver.
      const pool = (await h.shared.findById(poolId))!;
      await h.dispatch.runPoolWave(pool, 1, 1);
      const offer = bus.toDriver.mock.calls.find(
        (c) => c[0] === driverId && c[1] === 'ride_offer',
      )?.[2] as SharedRideOfferPayload;
      expect(offer.sharedRideId).toBe(poolId);
      expect(offer.stops).toHaveLength(4);

      // 3. Driver accepts → assignment guard + claim + projection.
      const accepted = await h.dispatch.acceptOffer({ offerId: offer.offerId, driverId });
      expect(accepted).toEqual({
        ok: true,
        trip: { kind: 'shared', sharedRideId: poolId },
        generation: 1,
        replay: false,
      });
      expect(await guardsFor(pg, { poolId })).toHaveLength(1);
      expect(await redis.hget(`driver:state:${driverId}`, 'current_ride_id')).toBe(poolId);

      // 4. Pickup #0 — pool transitions to closed_started.
      let r = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 0, type: 'pickup' });
      expect(r.ok).toBe(true);
      expect((await poolState(poolId)).pool_state).toBe('closed_started');

      // 5–6. Pickup #1, dropoff #2.
      r = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 1, type: 'pickup' });
      expect(r.ok).toBe(true);
      r = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 2, type: 'dropoff' });
      expect(r).toMatchObject({ ok: true, pendingAfter: 1, rideCompleted: false });

      // 7. Final dropoff #3 — ride completes and the driver is released.
      r = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 3, type: 'dropoff' });
      expect(r).toMatchObject({ ok: true, pendingAfter: 0, rideCompleted: true, duplicate: false });

      const final = await poolState(poolId);
      expect(final.pool_state).toBe('completed');
      expect(final.completed_at).toBeInstanceOf(Date);
      expect(await guardsFor(pg, { driverId })).toEqual([]);
      expect(await redis.hget(`driver:state:${driverId}`, 'current_ride_id')).toBeNull();
      expect(bus.toRide).toHaveBeenCalledWith(
        poolId,
        'ride:completed',
        expect.objectContaining({ rideId: poolId }),
      );

      const stops = await pg.query<{ confirmed_at: Date | null }>(
        'SELECT confirmed_at FROM ride_stops WHERE ride_id = $1 ORDER BY sequence_index',
        [poolId],
      );
      expect(stops.rows).toHaveLength(4);
      for (const s of stops.rows) expect(s.confirmed_at).toBeInstanceOf(Date);

      await redis.zrem('active_drivers', driverId);
    });

    it('every confirmed stop bumps the pool version; closed_started and completed reach the pool room with increasing versions', async () => {
      const { poolId, driverId } = await claimedPool(2);
      const poolUpdates = () =>
        bus.toPool.mock.calls
          .filter((c) => c[0] === poolId && c[1] === 'pool:update')
          .map((c) => c[2] as { version: number; poolStatus: string });
      const before = poolUpdates().length;
      const echoVersions: number[] = [];
      for (const [i, type] of (['pickup', 'pickup', 'dropoff', 'dropoff'] as const).entries()) {
        bus.toDriver.mockClear();
        const r = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: i, type });
        expect(r.ok).toBe(true);
        const echo = bus.toDriver.mock.calls.find((c) => c[0] === driverId && /^stop:/.test(c[1]))![2] as {
          version: number;
        };
        echoVersions.push(echo.version);
      }
      const { rows } = await pg.query<{ state_version: string }>(
        'SELECT state_version FROM shared_rides WHERE ride_id = $1',
        [poolId],
      );
      // Strictly increasing per stop, ending at (or below, when the trigger also bumped for the
      // state change) the committed version.
      for (let i = 1; i < echoVersions.length; i++) {
        expect(echoVersions[i]).toBeGreaterThan(echoVersions[i - 1]);
      }
      expect(echoVersions[3]).toBeLessThanOrEqual(Number(rows[0].state_version));

      const fresh = poolUpdates().slice(before);
      expect(fresh).toHaveLength(4);
      const versions = fresh.map((u) => u.version);
      for (let i = 1; i < versions.length; i++) expect(versions[i]).toBeGreaterThan(versions[i - 1]);
      expect(fresh.map((u) => u.poolStatus)).toContain('closed_started');
      expect(fresh[3]).toMatchObject({ poolStatus: 'completed', version: Number(rows[0].state_version) });
    });

    it('a duplicate stop confirmation returns the authoritative state (T32)', async () => {
      const { poolId, driverId } = await claimedPool(1);
      await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 0, type: 'pickup' });
      const again = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 0, type: 'pickup' });
      expect(again).toMatchObject({ ok: true, duplicate: true, pendingAfter: 1, rideCompleted: false });

      await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 1, type: 'dropoff' });
      // The final stop's confirmation is lost and re-sent after completion.
      const late = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 1, type: 'dropoff' });
      expect(late).toMatchObject({ ok: true, duplicate: true, pendingAfter: 0, rideCompleted: true });
      expect((await poolState(poolId)).pool_state).toBe('completed');
      expect(await guardsFor(pg, { driverId })).toEqual([]);
    });

    it('concurrent confirmations of the final stop complete the pool exactly once', async () => {
      const { poolId, driverId } = await claimedPool(1);
      const pgB = new Pool({ connectionString: process.env.TEST_POSTGRES_URI, max: 2 });
      try {
        const hB = buildDispatch(pgB, redis, dispatchQueue, makeBus());
        const otherLifecycle = new RideLifecycleService(hB.stops, hB.assignments, makeBus() as never, redis, hB.db, hB.poolProjection);
        await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 0, type: 'pickup' });
        const input = { rideId: poolId, driverId, sequenceIndex: 1, type: 'dropoff' } as const;
        const [a, b] = await Promise.all([
          rideLifecycle.confirmStop(input),
          otherLifecycle.confirmStop(input),
        ]);
        expect([a, b].every((x) => x.ok && x.rideCompleted)).toBe(true);
        expect([a, b].filter((x) => x.ok && x.duplicate)).toHaveLength(1);
        expect(await guardsFor(pg, { driverId })).toEqual([]);
      } finally {
        await pgB.end();
      }
    });

    it('rejects out-of-order confirmation', async () => {
      const { poolId, driverId } = await claimedPool(1);
      const r = await rideLifecycle.confirmStop({ rideId: poolId, driverId, sequenceIndex: 1, type: 'dropoff' });
      expect(r).toEqual({ ok: false, reason: 'out_of_order' });
    });

    it('rejects confirmation from a driver who does not hold the claim', async () => {
      const { poolId } = await claimedPool(1);
      const r = await rideLifecycle.confirmStop({
        rideId: poolId,
        driverId: randomUUID(),
        sequenceIndex: 0,
        type: 'pickup',
      });
      expect(r).toEqual({ ok: false, reason: 'not_owner' });
      expect((await poolState(poolId)).pool_state).toBe('closed_full');
    });
  },
);
