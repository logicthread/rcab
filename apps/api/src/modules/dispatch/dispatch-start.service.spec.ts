import { describe, expect, it, vi } from 'vitest';
import { DispatchStartService } from './dispatch-start.service';

function make(
  opts: {
    ride?: Record<string, unknown> | null;
    pool?: Record<string, unknown> | null;
    woken?: unknown[];
  } = {},
) {
  const ridesRepo = { findById: vi.fn().mockResolvedValue(opts.ride ?? null) };
  const sharedRepo = { findById: vi.fn().mockResolvedValue(opts.pool ?? null) };
  const waves = {
    runSoloWave: vi.fn().mockResolvedValue(undefined),
    runPoolWave: vi.fn().mockResolvedValue(undefined),
  };
  const returning = vi.fn().mockResolvedValue(opts.woken ?? []);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const db = { update: vi.fn().mockReturnValue({ set }) };
  const svc = new DispatchStartService(ridesRepo as never, sharedRepo as never, waves, db as never);
  return { svc, ridesRepo, sharedRepo, waves, db, set };
}

const ride = (o: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'requested',
  dispatchGeneration: 1,
  ...o,
});
const pool = (o: Record<string, unknown> = {}) => ({
  rideId: 'p1',
  poolState: 'closed_full',
  claimedByDriverId: null,
  dispatchGeneration: 1,
  ...o,
});

describe('DispatchStartService.startSolo', () => {
  it('runs wave 1 at the job generation and reports started', async () => {
    const { svc, waves } = make({ ride: ride() });
    expect(await svc.startSolo('r1', 1)).toBe('started');
    expect(waves.runSoloWave).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 1, 1);
  });

  it.each([
    ['missing ride', null, 1],
    ['ride no longer requested', ride({ status: 'accepted' }), 1],
    ['cancelled ride', ride({ status: 'cancelled' }), 1],
    ['older generation job', ride({ dispatchGeneration: 2 }), 1],
    ['job from the future', ride({ dispatchGeneration: 1 }), 2],
  ])('is a stale no-op for a %s', async (_n, r, gen) => {
    const { svc, waves } = make({ ride: r as never });
    expect(await svc.startSolo('r1', gen)).toBe('stale');
    expect(waves.runSoloWave).not.toHaveBeenCalled();
  });

  it('propagates a wave failure so the BullMQ job retries (nothing is swallowed)', async () => {
    const { svc, waves } = make({ ride: ride() });
    waves.runSoloWave.mockRejectedValue(new Error('redis down'));
    await expect(svc.startSolo('r1', 1)).rejects.toThrow('redis down');
  });
});

describe('DispatchStartService.startPool', () => {
  it.each(['closed_full', 'closed_timeout'])('dispatches an unclaimed %s pool', async (state) => {
    const { svc, waves } = make({ pool: pool({ poolState: state }) });
    expect(await svc.startPool('p1', 1)).toBe('started');
    expect(waves.runPoolWave).toHaveBeenCalledWith(expect.objectContaining({ rideId: 'p1' }), 1, 1);
  });

  it.each([
    ['missing', null],
    ['open', pool({ poolState: 'open' })],
    ['aborted', pool({ poolState: 'aborted' })],
    ['claimed', pool({ claimedByDriverId: 'd1' })],
    ['superseded generation', pool({ dispatchGeneration: 2 })],
  ])('is a stale no-op for a %s pool', async (_n, p) => {
    const { svc, waves } = make({ pool: p as never });
    expect(await svc.startPool('p1', 1)).toBe('stale');
    expect(waves.runPoolWave).not.toHaveBeenCalled();
  });
});

describe('DispatchStartService.wakeScheduled', () => {
  it('records the generation, then starts dispatch', async () => {
    const { svc, waves, set } = make({ woken: [{ id: 'r1' }], ride: ride() });
    expect(await svc.wakeScheduled('r1', 1)).toBe('started');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ dispatchGeneration: 1 }));
    expect(waves.runSoloWave).toHaveBeenCalledTimes(1);
  });

  it('is a stale no-op when the guarded UPDATE matches nothing (cancelled / superseded / not scheduled)', async () => {
    const { svc, waves, ridesRepo } = make({ woken: [] });
    expect(await svc.wakeScheduled('r1', 1)).toBe('stale');
    expect(ridesRepo.findById).not.toHaveBeenCalled();
    expect(waves.runSoloWave).not.toHaveBeenCalled();
  });

  it('propagates a failure after the wake was recorded (the retry re-runs wave 1)', async () => {
    const { svc, waves } = make({ woken: [{ id: 'r1' }], ride: ride() });
    waves.runSoloWave.mockRejectedValue(new Error('osrm down'));
    await expect(svc.wakeScheduled('r1', 1)).rejects.toThrow('osrm down');
  });
});
