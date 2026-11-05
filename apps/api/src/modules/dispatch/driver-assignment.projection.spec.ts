import { describe, expect, it, vi } from 'vitest';
import {
  DriverAssignmentProjection,
  clearCurrentRide,
  driverStateKey,
  projectCurrentRide,
} from './driver-assignment.projection';
import type { AssignmentRow } from './assignment.repository';

const D1 = '00000000-0000-4000-8000-000000000001';
const D2 = '00000000-0000-4000-8000-000000000002';
const D3 = '00000000-0000-4000-8000-000000000003';

function guard(driverId: string, rideId: string): AssignmentRow {
  return {
    driverId,
    trip: { kind: 'solo', rideId },
    offerId: null,
    generation: 1,
    assignedAt: new Date(),
  };
}

/** A tiny in-memory Redis with just the calls the projection makes. */
function fakeRedis(hashes: Record<string, Record<string, string>>) {
  return {
    eval: vi.fn(async (script: string, _n: number, key: string, field: string, value: string) => {
      const h = hashes[key];
      if (script.includes("'EXISTS'")) {
        if (!h) return 0;
        h[field] = value;
        return 1;
      }
      if (h && h[field] === value) {
        delete h[field];
        return 1;
      }
      return 0;
    }),
    hget: vi.fn(async (key: string, field: string) => {
      if (key === 'driver:state:not-a-hash') throw new Error('WRONGTYPE');
      return hashes[key]?.[field] ?? null;
    }),
    scan: vi.fn(async () => ['0', Object.keys(hashes).concat('driver:state:not-a-hash')]),
  };
}

function build(guards: AssignmentRow[], hashes: Record<string, Record<string, string>>) {
  const redis = fakeRedis(hashes);
  const assignments = {
    listAll: vi.fn().mockResolvedValue(guards),
    findByDriver: vi.fn(async (_db: unknown, id: string) => guards.find((g) => g.driverId === id) ?? null),
  };
  const offers = { expireLapsed: vi.fn().mockResolvedValue(2) };
  const projection = new DriverAssignmentProjection(
    {} as never,
    redis as never,
    assignments as never,
    offers as never,
  );
  return { projection, redis, assignments, offers, hashes };
}

describe('projection helpers', () => {
  it('only writes onto a present hash, and only clears a matching value', async () => {
    const hashes: Record<string, Record<string, string>> = {
      [driverStateKey(D1)]: { availability: 'online' },
    };
    const redis = fakeRedis(hashes);
    expect(await projectCurrentRide(redis as never, D1, 'r-1')).toBe(true);
    expect(await projectCurrentRide(redis as never, D2, 'r-1')).toBe(false);
    expect(hashes[driverStateKey(D2)]).toBeUndefined();

    expect(await clearCurrentRide(redis as never, D1, 'r-other')).toBe(false);
    expect(hashes[driverStateKey(D1)].current_ride_id).toBe('r-1');
    expect(await clearCurrentRide(redis as never, D1, 'r-1')).toBe(true);
    expect(hashes[driverStateKey(D1)].current_ride_id).toBeUndefined();
  });
});

describe('DriverAssignmentProjection.reconcile', () => {
  it('projects guards, clears orphans, leaves correct and absent drivers alone', async () => {
    const hashes: Record<string, Record<string, string>> = {
      [driverStateKey(D1)]: { availability: 'online' }, // lost projection
      [driverStateKey(D2)]: { current_ride_id: 'stale' }, // no guard → orphan
      [driverStateKey(D3)]: { current_ride_id: 'r-3' }, // already right
      'driver:state:legacy-non-uuid': { current_ride_id: 'x' },
    };
    const { projection, offers } = build([guard(D1, 'r-1'), guard(D3, 'r-3')], hashes);

    const res = await projection.reconcile();

    expect(res).toEqual({ projected: 1, cleared: 2, expiredOffers: 2 });
    expect(offers.expireLapsed).toHaveBeenCalled();
    expect(hashes[driverStateKey(D1)].current_ride_id).toBe('r-1');
    expect(hashes[driverStateKey(D2)].current_ride_id).toBeUndefined();
    expect(hashes[driverStateKey(D3)].current_ride_id).toBe('r-3');
    expect(hashes['driver:state:legacy-non-uuid'].current_ride_id).toBeUndefined();
  });

  it('re-checks Postgres before writing: a guard released mid-scan is not re-projected', async () => {
    const hashes: Record<string, Record<string, string>> = {
      [driverStateKey(D1)]: { availability: 'online' },
    };
    const { projection, assignments } = build([guard(D1, 'r-1')], hashes);
    assignments.findByDriver.mockResolvedValue(null);
    const res = await projection.reconcile();
    expect(res.projected).toBe(0);
    expect(hashes[driverStateKey(D1)].current_ride_id).toBeUndefined();
  });

  it('re-checks Postgres before clearing: an assignment committed mid-scan survives', async () => {
    const hashes: Record<string, Record<string, string>> = {
      [driverStateKey(D2)]: { current_ride_id: 'r-new' },
    };
    const { projection, assignments } = build([], hashes);
    assignments.findByDriver.mockResolvedValue(guard(D2, 'r-new'));
    expect((await projection.reconcile()).cleared).toBe(0);
    expect(hashes[driverStateKey(D2)].current_ride_id).toBe('r-new');
  });

  it('boot + interval hooks are gated by RCAB_DISABLE_BULL_AUTORUN and never throw', async () => {
    const { projection, assignments } = build([], {});
    const prev = process.env.RCAB_DISABLE_BULL_AUTORUN;
    try {
      process.env.RCAB_DISABLE_BULL_AUTORUN = '1';
      await projection.onApplicationBootstrap();
      await projection.onInterval();
      expect(assignments.listAll).not.toHaveBeenCalled();

      process.env.RCAB_DISABLE_BULL_AUTORUN = '0';
      assignments.listAll.mockRejectedValueOnce(new Error('db down'));
      await expect(projection.onApplicationBootstrap()).resolves.toBeUndefined();
      await projection.onInterval();
      expect(assignments.listAll).toHaveBeenCalledTimes(2);
    } finally {
      process.env.RCAB_DISABLE_BULL_AUTORUN = prev;
    }
  });

  it('set / clear are best effort', async () => {
    const { projection, redis } = build([], {});
    redis.eval.mockRejectedValue(new Error('redis down'));
    await expect(projection.set(D1, 'r-1')).resolves.toBeUndefined();
    await expect(projection.clear(D1, 'r-1')).resolves.toBeUndefined();
  });
});
