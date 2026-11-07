import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxRelay } from './outbox.relay';
import type { LeasedOutboxRow } from './outbox.repository';
import { OutboxTopic } from './outbox.types';

const ID = '7d1f3c1e-6f9a-4c55-9d43-0b1c2f3a4b5c';

function row(o: Partial<LeasedOutboxRow> = {}): LeasedOutboxRow {
  return {
    id: 'ob-1',
    topic: OutboxTopic.RideDispatchRequested,
    aggregateType: 'ride',
    aggregateId: ID,
    aggregateGeneration: 1,
    payload: {},
    payloadVersion: 1,
    dedupeKey: 'k',
    attempts: 1,
    maxAttempts: 10,
    leaseToken: 'tok-1',
    ...o,
  };
}

function make(rows: LeasedOutboxRow[]) {
  const repo = {
    lease: vi.fn().mockResolvedValue(rows),
    ack: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('retry'),
  };
  const scheduled = { scheduleWake: vi.fn().mockResolvedValue({ jobId: 'j', delayMs: 0 }) };
  const dispatchQ = { add: vi.fn().mockResolvedValue(undefined) };
  const matchingQ = { add: vi.fn().mockResolvedValue(undefined) };
  const relay = new OutboxRelay(repo as never, scheduled as never, dispatchQ as never, matchingQ as never);
  return { relay, repo, scheduled, dispatchQ, matchingQ };
}

describe('OutboxRelay.drainOnce', () => {
  it('ride.dispatch.requested -> dispatch:start job with a deterministic colon-free id, then ack', async () => {
    const { relay, repo, dispatchQ } = make([row()]);
    expect(await relay.drainOnce()).toEqual({ published: 1, failed: 0 });
    expect(dispatchQ.add).toHaveBeenCalledWith(
      'dispatch:start',
      { kind: 'solo', tripId: ID, generation: 1 },
      expect.objectContaining({ jobId: `dispatch-start-${ID}-g1`, attempts: 5 }),
    );
    expect(repo.ack).toHaveBeenCalledWith('ob-1', 'tok-1');
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it('pool.dispatch.requested -> dispatch:start with kind=pool at the row generation', async () => {
    const { relay, dispatchQ } = make([
      row({ topic: OutboxTopic.PoolDispatchRequested, aggregateType: 'shared_ride', aggregateGeneration: 2 }),
    ]);
    await relay.drainOnce();
    expect(dispatchQ.add).toHaveBeenCalledWith(
      'dispatch:start',
      { kind: 'pool', tripId: ID, generation: 2 },
      expect.objectContaining({ jobId: `dispatch-start-${ID}-g2` }),
    );
  });

  it('ride.wake.schedule -> the scheduled service with the payload instant and the row generation', async () => {
    const at = '2026-12-01T10:00:00.000Z';
    const { relay, scheduled } = make([
      row({ topic: OutboxTopic.RideWakeSchedule, payload: { scheduledFor: at } }),
    ]);
    await relay.drainOnce();
    expect(scheduled.scheduleWake).toHaveBeenCalledWith(ID, new Date(at), 1);
  });

  it('pool.expire.schedule -> matching queue pool:expire with a delay to expireAt', async () => {
    const expireAt = new Date(Date.now() + 45_000).toISOString();
    const { relay, matchingQ } = make([
      row({
        topic: OutboxTopic.PoolExpireSchedule,
        aggregateType: 'shared_ride',
        aggregateGeneration: 0,
        payload: { expireAt },
      }),
    ]);
    await relay.drainOnce();
    const [name, data, opts] = matchingQ.add.mock.calls[0] as [string, unknown, { jobId: string; delay: number }];
    expect(name).toBe('pool:expire');
    expect(data).toEqual({ rideId: ID });
    expect(opts.jobId).toBe(`pool-expire-${ID}`);
    expect(opts.delay).toBeGreaterThan(40_000);
    expect(opts.delay).toBeLessThanOrEqual(45_000);
  });

  it('a past expireAt clamps the delay to 0', async () => {
    const { relay, matchingQ } = make([
      row({
        topic: OutboxTopic.PoolExpireSchedule,
        payload: { expireAt: new Date(Date.now() - 10_000).toISOString() },
      }),
    ]);
    await relay.drainOnce();
    expect((matchingQ.add.mock.calls[0][2] as { delay: number }).delay).toBe(0);
  });

  it('a publish failure is recorded with backoff and does not stop the rest of the batch', async () => {
    const { relay, repo, dispatchQ } = make([row({ id: 'a', leaseToken: 't-a' }), row({ id: 'b', leaseToken: 't-b' })]);
    dispatchQ.add.mockRejectedValueOnce(new Error('redis down'));
    expect(await relay.drainOnce()).toEqual({ published: 1, failed: 1 });
    expect(repo.fail).toHaveBeenCalledWith('a', 't-a', 'redis down', { permanent: false });
    expect(repo.ack).toHaveBeenCalledWith('b', 't-b');
    expect(repo.ack).not.toHaveBeenCalledWith('a', 't-a');
  });

  it('an unknown topic is failed permanently with unknown_topic', async () => {
    const { relay, repo, dispatchQ } = make([row({ topic: 'x.mystery' })]);
    await relay.drainOnce();
    expect(repo.fail).toHaveBeenCalledWith('ob-1', 'tok-1', 'unknown_topic', { permanent: true });
    expect(dispatchQ.add).not.toHaveBeenCalled();
    expect(repo.ack).not.toHaveBeenCalled();
  });

  it('a malformed payload is failed permanently (retrying cannot help)', async () => {
    const { relay, repo } = make([row({ topic: OutboxTopic.RideWakeSchedule, payload: { scheduledFor: 'nope' } })]);
    await relay.drainOnce();
    expect(repo.fail).toHaveBeenCalledWith('ob-1', 'tok-1', 'invalid_payload:scheduledFor', { permanent: true });
  });

  it('a lost acknowledgment is not an error: the row will be re-published and deduplicated', async () => {
    const { relay, repo } = make([row()]);
    repo.ack.mockRejectedValue(new Error('connection reset'));
    await expect(relay.drainOnce()).resolves.toEqual({ published: 1, failed: 0 });
    expect(repo.fail).not.toHaveBeenCalled();
  });

  it('survives fail() itself failing (the lease expiry is the backstop)', async () => {
    const { relay, repo, dispatchQ } = make([row()]);
    dispatchQ.add.mockRejectedValue(new Error('x'));
    repo.fail.mockRejectedValue(new Error('pg down'));
    await expect(relay.drainOnce()).resolves.toEqual({ published: 0, failed: 1 });
  });

  it('concurrent drainOnce calls in one process share a single in-flight drain', async () => {
    const { relay, repo } = make([row()]);
    const [a, b] = await Promise.all([relay.drainOnce(), relay.drainOnce()]);
    expect(repo.lease).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});

describe('OutboxRelay timers', () => {
  const saved = process.env.RCAB_DISABLE_OUTBOX_RELAY;
  beforeEach(() => {
    delete process.env.RCAB_DISABLE_OUTBOX_RELAY; // the unit config disables it globally
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (saved === undefined) delete process.env.RCAB_DISABLE_OUTBOX_RELAY;
    else process.env.RCAB_DISABLE_OUTBOX_RELAY = saved;
  });

  it('kick() drains soon, debounced; the interval keeps polling; destroy stops it', async () => {
    const { relay, repo } = make([]);
    relay.onApplicationBootstrap(); // initial kick + 1 s interval
    relay.kick();
    relay.kick();
    await vi.advanceTimersByTimeAsync(1);
    expect(repo.lease).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(repo.lease.mock.calls.length).toBeGreaterThanOrEqual(3);
    relay.onModuleDestroy();
    const n = repo.lease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repo.lease).toHaveBeenCalledTimes(n);
  });

  it('RCAB_DISABLE_OUTBOX_RELAY=1 turns the poller and kick() off (test seam)', async () => {
    process.env.RCAB_DISABLE_OUTBOX_RELAY = '1';
    const { relay, repo } = make([]);
    relay.onApplicationBootstrap();
    relay.kick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repo.lease).not.toHaveBeenCalled();
  });

  it('a lease error is logged, not thrown, and the poll continues', async () => {
    const { relay, repo } = make([]);
    repo.lease.mockRejectedValueOnce(new Error('pg down')).mockResolvedValue([]);
    relay.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(repo.lease.mock.calls.length).toBeGreaterThanOrEqual(2);
    relay.onModuleDestroy();
  });
});
