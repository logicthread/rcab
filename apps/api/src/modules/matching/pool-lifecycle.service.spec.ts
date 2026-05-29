import { describe, it, expect, vi } from 'vitest';
import { PoolLifecycleService, POOL_CLOSED_EVENT } from './pool-lifecycle.service';
import type { SharedRideMember, SharedRideRow } from './shared-ride.repository';

function member(overrides: Partial<SharedRideMember> = {}): SharedRideMember {
  return {
    passenger_id: 'p-opener',
    origin_lat:   22.5727,
    origin_lng:   88.3640,
    dest_lat:     22.5801,
    dest_lng:     88.3701,
    joined_at:    '2026-05-29T00:00:00.000Z',
    ...overrides,
  };
}

function pool(overrides: Partial<SharedRideRow> = {}): SharedRideRow {
  return {
    rideId:            'pool-1',
    seatCount:         1,
    maxSeats:          3,
    poolState:         'open',
    poolClosedAt:      null,
    detourBudgetM:     800,
    originLat: 22.5727, originLng: 88.3640,
    destLat:   22.5801, destLng:   88.3701,
    members:           [member()],
    claimedByDriverId: null,
    claimedAt:         null,
    ...overrides,
  };
}

function buildRepo(createdPool?: SharedRideRow) {
  return {
    create:         vi.fn().mockResolvedValue(createdPool ?? pool({ rideId: 'new-pool', seatCount: 1 })),
    incrementSeats: vi.fn().mockResolvedValue(undefined),
    appendMember:   vi.fn().mockResolvedValue(undefined),
    closePool:      vi.fn().mockResolvedValue(undefined),
    findCandidates: vi.fn(),
    findById:       vi.fn(),
    setClaimed:     vi.fn(),
  };
}

function buildQueue() {
  return {
    add: vi.fn().mockResolvedValue({ id: 'job-id' }),
    remove: vi.fn().mockResolvedValue(1),
  };
}

function buildRedis(evalResult: number = 2) {
  return {
    eval:    vi.fn().mockResolvedValue(evalResult),
    hset:    vi.fn().mockResolvedValue(1),
    expire:  vi.fn().mockResolvedValue(1),
  };
}

function buildEvents() {
  return { emit: vi.fn() };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return { get: vi.fn((key: string) => overrides[key] ?? undefined) };
}

function makeService(opts: {
  evalResult?: number;
  createdPool?: SharedRideRow;
  config?: Record<string, unknown>;
} = {}) {
  const repo   = buildRepo(opts.createdPool);
  const queue  = buildQueue();
  const redis  = buildRedis(opts.evalResult ?? 2);
  const events = buildEvents();
  const config = buildConfig(opts.config ?? {});
  const svc = new PoolLifecycleService(
    repo as never,
    queue as never,
    redis as never,
    events as never,
    config as never,
  );
  return { svc, repo, queue, redis, events };
}

describe('PoolLifecycleService.openPool', () => {
  it('creates the DB row, enqueues pool:expire with 60s delay, writes Redis HASH', async () => {
    const { svc, repo, queue, redis } = makeService({
      createdPool: pool({ rideId: 'fresh-pool', seatCount: 1, maxSeats: 3 }),
    });

    const p = await svc.openPool({
      passengerId: 'p-1',
      originLat: 22.5727, originLng: 88.3640,
      destLat:   22.5801, destLng:   88.3701,
      maxSeats: 3, detourBudgetM: 800,
    });

    expect(p.rideId).toBe('fresh-pool');
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        opener: expect.objectContaining({
          passenger_id: 'p-1',
          origin_lat:   22.5727,
        }),
      }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'pool:expire',
      { rideId: 'fresh-pool' },
      expect.objectContaining({
        delay: 60_000,
        jobId: 'pool:expire:fresh-pool',
      }),
    );
    expect(redis.hset).toHaveBeenCalledWith(
      'pool:fresh-pool',
      expect.objectContaining({
        state: 'open',
        seat_count: '1',
        max_seats: '3',
        expiry_job_id: 'pool:expire:fresh-pool',
      }),
    );
    expect(redis.expire).toHaveBeenCalledWith('pool:fresh-pool', 600);
  });

  it('respects MATCHING_POOL_TIMEOUT_MS override', async () => {
    const { svc, queue } = makeService({
      createdPool: pool({ rideId: 'p', seatCount: 1 }),
      config: { MATCHING_POOL_TIMEOUT_MS: 90_000 },
    });

    await svc.openPool({
      passengerId: 'p-1',
      originLat: 0, originLng: 0, destLat: 0, destLng: 0,
      maxSeats: 3, detourBudgetM: 800,
    });

    expect(queue.add).toHaveBeenCalledWith(
      'pool:expire', expect.anything(),
      expect.objectContaining({ delay: 90_000 }),
    );
  });
});

describe('PoolLifecycleService.slotRequest', () => {
  it('claims a seat via Lua, increments DB, appends member, writes HASH seat_count', async () => {
    const { svc, repo, redis } = makeService({ evalResult: 2 });
    const joiner = member({ passenger_id: 'p-joiner' });
    const result = await svc.slotRequest({
      pool: pool({ rideId: 'p1', seatCount: 1, maxSeats: 3 }),
      joiner,
    });

    expect(result).toEqual({ slotted: true, closedFull: false, seatCount: 2 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String), 1, 'pool:p1:seats', '3', '1',
    );
    expect(repo.incrementSeats).toHaveBeenCalledWith('p1', 2);
    expect(repo.appendMember).toHaveBeenCalledWith('p1', joiner);
    expect(redis.hset).toHaveBeenCalledWith('pool:p1', { seat_count: '2' });
  });

  it('returns slotted:false when Lua returns -1 (pool full)', async () => {
    const { svc, repo, redis } = makeService({ evalResult: -1 });
    const result = await svc.slotRequest({
      pool: pool({ rideId: 'full', seatCount: 3, maxSeats: 3 }),
      joiner: member(),
    });

    expect(result).toEqual({ slotted: false, closedFull: false, seatCount: 3 });
    expect(repo.incrementSeats).not.toHaveBeenCalled();
    expect(repo.appendMember).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('auto-closes the pool (closed_full) when the slot filled it; removes expiry job; emits pool.closed', async () => {
    const { svc, repo, queue, redis, events } = makeService({ evalResult: 3 });
    const result = await svc.slotRequest({
      pool: pool({ rideId: 'last-seat', seatCount: 2, maxSeats: 3 }),
      joiner: member({ passenger_id: 'p-last' }),
    });

    expect(result).toEqual({ slotted: true, closedFull: true, seatCount: 3 });
    expect(repo.closePool).toHaveBeenCalledWith('last-seat', 'closed_full');
    expect(queue.remove).toHaveBeenCalledWith('pool:expire:last-seat');
    expect(redis.hset).toHaveBeenCalledWith(
      'pool:last-seat',
      expect.objectContaining({ state: 'closed_full' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      POOL_CLOSED_EVENT,
      { rideId: 'last-seat', reason: 'closed_full' },
    );
  });
});

describe('PoolLifecycleService.closePool', () => {
  it('writes DB state, Redis state, removes expiry job, emits pool.closed for closed_full', async () => {
    const { svc, repo, queue, redis, events } = makeService();
    await svc.closePool('p-x', 'closed_full');

    expect(repo.closePool).toHaveBeenCalledWith('p-x', 'closed_full');
    expect(redis.hset).toHaveBeenCalledWith(
      'pool:p-x',
      expect.objectContaining({ state: 'closed_full', closed_at: expect.any(String) }),
    );
    expect(queue.remove).toHaveBeenCalledWith('pool:expire:p-x');
    expect(events.emit).toHaveBeenCalledWith(
      POOL_CLOSED_EVENT,
      { rideId: 'p-x', reason: 'closed_full' },
    );
  });

  it('does NOT remove the expiry job for closed_timeout but still emits pool.closed', async () => {
    const { svc, repo, queue, redis, events } = makeService();
    await svc.closePool('p-y', 'closed_timeout');

    expect(repo.closePool).toHaveBeenCalledWith('p-y', 'closed_timeout');
    expect(redis.hset).toHaveBeenCalledWith(
      'pool:p-y',
      expect.objectContaining({ state: 'closed_timeout' }),
    );
    expect(queue.remove).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      POOL_CLOSED_EVENT,
      { rideId: 'p-y', reason: 'closed_timeout' },
    );
  });

  it('does NOT emit pool.closed for terminal reasons (closed_started, aborted)', async () => {
    const { svc, events } = makeService();
    await svc.closePool('p-started', 'closed_started');
    await svc.closePool('p-aborted', 'aborted');

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('swallows queue.remove errors (job may already be gone)', async () => {
    const { svc, queue } = makeService();
    queue.remove.mockRejectedValueOnce(new Error('boom'));

    await expect(svc.closePool('p-z', 'aborted')).resolves.not.toThrow();
  });
});
