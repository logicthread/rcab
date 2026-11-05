import { describe, it, expect, vi } from 'vitest';
import { POOL_HASH_TTL_SECONDS, PoolProjectionService } from './pool-projection.service';
import type { SharedRideRow } from './shared-ride.repository';

function row(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId: 'pool-1',
    seatCount: 2,
    maxSeats: 3,
    poolState: 'open',
    poolClosedAt: null,
    detourBudgetM: 800,
    originLat: 1,
    originLng: 2,
    destLat: 3,
    destLng: 4,
    members: [],
    claimedByDriverId: null,
    claimedAt: null,
    dispatchGeneration: 0,
    stateVersion: 7,
    ...overrides,
  };
}

function make(rows: Record<string, SharedRideRow | null> = {}, ids: string[] = []) {
  const pools = {
    findById: vi.fn(async (id: string) => rows[id] ?? null),
    listNonTerminalIds: vi.fn().mockResolvedValue(ids),
  };
  const redis = { eval: vi.fn().mockResolvedValue(1) };
  return { svc: new PoolProjectionService(pools as never, redis as never), pools, redis };
}

describe('PoolProjectionService', () => {
  it('project re-reads Postgres and writes a version-guarded hash', async () => {
    const { svc, redis } = make({
      'pool-1': row({ claimedByDriverId: 'd-1', poolState: 'closed_full' }),
    });
    await expect(svc.project('pool-1')).resolves.toMatchObject({ rideId: 'pool-1' });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("HGET', KEYS[1], 'version'"),
      1,
      'pool:pool-1',
      '7',
      'closed_full',
      '2',
      '3',
      'd-1',
      String(POOL_HASH_TTL_SECONDS),
    );
  });

  it('project of a missing pool writes nothing', async () => {
    const { svc, redis } = make();
    await expect(svc.project('gone')).resolves.toBeNull();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('write reports whether the projection advanced', async () => {
    const { svc, redis } = make();
    redis.eval.mockResolvedValueOnce(0);
    await expect(svc.write(row())).resolves.toBe(false);
    await expect(svc.write(row())).resolves.toBe(true);
    expect(redis.eval.mock.calls[1][7]).toBe('');
  });

  it('rebuildAll projects every non-terminal pool; bootstrap never throws', async () => {
    const { svc, redis, pools } = make({ a: row({ rideId: 'a' }), b: row({ rideId: 'b' }) }, [
      'a',
      'b',
      'x',
    ]);
    await expect(svc.rebuildAll()).resolves.toBe(2);
    expect(redis.eval).toHaveBeenCalledTimes(2);

    pools.listNonTerminalIds.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
