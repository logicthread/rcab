import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { ScheduledDispatchProcessor } from './scheduled.processor';
import { SCHEDULED_WAKE_JOB, type ScheduledWakeJob } from './scheduled.service';

function makeProcessor(wakeScheduled = vi.fn().mockResolvedValue('started')) {
  const start = { wakeScheduled };
  const proc = new ScheduledDispatchProcessor(start as never);
  return { proc, start };
}
const job = (data: ScheduledWakeJob, name = SCHEDULED_WAKE_JOB) =>
  ({ name, data }) as Job<ScheduledWakeJob>;

describe('ScheduledDispatchProcessor', () => {
  it('wakes the ride at the job generation through the dispatch start path', async () => {
    const { proc, start } = makeProcessor();
    await proc.process(job({ rideId: 'ride-42', generation: 1 }));
    expect(start.wakeScheduled).toHaveBeenCalledWith('ride-42', 1);
  });

  it('treats a legacy job without a generation as generation 1', async () => {
    const { proc, start } = makeProcessor();
    await proc.process(job({ rideId: 'ride-42' }));
    expect(start.wakeScheduled).toHaveBeenCalledWith('ride-42', 1);
  });

  it('completes only after the dispatch work finished (the job promise follows it)', async () => {
    let release!: () => void;
    const gate = new Promise<'started'>((r) => (release = () => r('started')));
    const { proc } = makeProcessor(vi.fn().mockReturnValue(gate));
    let done = false;
    const p = proc.process(job({ rideId: 'r', generation: 1 })).then(() => (done = true));
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    release();
    await p;
    expect(done).toBe(true);
  });

  it('propagates a dispatch failure so BullMQ retries the job (F08)', async () => {
    const { proc } = makeProcessor(vi.fn().mockRejectedValue(new Error('redis down')));
    await expect(proc.process(job({ rideId: 'r', generation: 1 }))).rejects.toThrow('redis down');
  });

  it('ignores an unexpected job name (no dispatch)', async () => {
    const { proc, start } = makeProcessor();
    await proc.process(job({ rideId: 'ride-42' }, 'something-else'));
    expect(start.wakeScheduled).not.toHaveBeenCalled();
  });
});
