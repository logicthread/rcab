import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ScheduledDispatchService,
  SCHEDULED_WAKE_JOB,
  SCHEDULED_WAKE_LEAD_MS,
  wakeJobId,
} from './scheduled.service';

function makeQueue() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn(),
  };
}

const config = { get: vi.fn().mockReturnValue(undefined) } as never;

describe('ScheduledDispatchService', () => {
  const NOW = new Date('2026-07-15T00:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('wakeJobId is deterministic per (ride, generation) and colon-free', () => {
    expect(wakeJobId('abc')).toBe('scheduled-wake-abc-g1');
    expect(wakeJobId('abc', 2)).toBe('scheduled-wake-abc-g2');
    expect(wakeJobId('abc')).not.toContain(':');
  });

  it('scheduleWake enqueues a delayed job firing lead-time before scheduled_for', async () => {
    const queue = makeQueue();
    const svc = new ScheduledDispatchService(queue as never, config);
    const scheduledFor = new Date(NOW + 2 * 60 * 60 * 1000); // 2h out

    const { jobId, delayMs } = await svc.scheduleWake('ride-1', scheduledFor, 1);

    expect(jobId).toBe('scheduled-wake-ride-1-g1');
    expect(delayMs).toBe(2 * 60 * 60 * 1000 - SCHEDULED_WAKE_LEAD_MS);
    // Add-only: the deterministic id makes a republish a no-op (no remove/re-add race).
    expect(queue.add).toHaveBeenCalledWith(
      SCHEDULED_WAKE_JOB,
      { rideId: 'ride-1', generation: 1 },
      expect.objectContaining({ jobId: 'scheduled-wake-ride-1-g1', delay: delayMs, attempts: 5 }),
    );
  });

  it('clamps delay to 0 when the wake time is already in the past', async () => {
    const queue = makeQueue();
    const svc = new ScheduledDispatchService(queue as never, config);
    const { delayMs } = await svc.scheduleWake('ride-2', new Date(NOW + 60_000)); // 1min out
    expect(delayMs).toBe(0);
  });

  it('honours a config-overridden lead time', async () => {
    const queue = makeQueue();
    const overridden = { get: vi.fn().mockReturnValue(60_000) } as never; // 1min lead
    const svc = new ScheduledDispatchService(queue as never, overridden);
    const { delayMs } = await svc.scheduleWake('ride-3', new Date(NOW + 2 * 60 * 60 * 1000));
    expect(delayMs).toBe(2 * 60 * 60 * 1000 - 60_000);
  });

  it('cancelWake removes the pending new-id and legacy-id jobs and reports whether one existed', async () => {
    const queue = makeQueue();
    const removeNew = vi.fn().mockResolvedValue(undefined);
    const removeLegacy = vi.fn().mockResolvedValue(undefined);
    queue.getJob.mockImplementation(async (id: string) =>
      id === 'scheduled-wake-ride-4-g1'
        ? { remove: removeNew }
        : id === 'scheduled:wake:ride-4'
          ? { remove: removeLegacy }
          : undefined,
    );
    const svc = new ScheduledDispatchService(queue as never, config);
    expect(await svc.cancelWake('ride-4')).toBe(true);
    expect(removeNew).toHaveBeenCalled();
    expect(removeLegacy).toHaveBeenCalled();

    queue.getJob.mockResolvedValue(undefined);
    expect(await svc.cancelWake('ride-4')).toBe(false);
  });

  it('cancelWake tolerates a job that cannot be removed (already active)', async () => {
    const queue = makeQueue();
    queue.getJob.mockResolvedValue({ remove: vi.fn().mockRejectedValue(new Error('locked')) });
    const svc = new ScheduledDispatchService(queue as never, config);
    await expect(svc.cancelWake('ride-5')).resolves.toBe(false);
  });
});
