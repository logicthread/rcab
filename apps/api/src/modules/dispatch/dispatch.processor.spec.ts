import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { DispatchProcessor } from './dispatch.processor';
import { HARD_FAIL_JOB, WAVE_TIMEOUT_JOB } from './dispatch.service';
import { DISPATCH_START_JOB } from '../outbox/outbox.jobs';

function make() {
  const dispatch = {
    handleWaveTimeout: vi.fn().mockResolvedValue(undefined),
    handleHardFail: vi.fn().mockResolvedValue(undefined),
  };
  const start = {
    startSolo: vi.fn().mockResolvedValue('started'),
    startPool: vi.fn().mockResolvedValue('started'),
  };
  return { proc: new DispatchProcessor(dispatch as never, start as never), dispatch, start };
}
const job = (name: string, data: unknown) => ({ name, data }) as unknown as Job;

describe('DispatchProcessor', () => {
  it('dispatch:start routes by kind to the start service at the job generation', async () => {
    const { proc, start } = make();
    await proc.process(job(DISPATCH_START_JOB, { kind: 'solo', tripId: 'r1', generation: 3 }));
    expect(start.startSolo).toHaveBeenCalledWith('r1', 3);
    await proc.process(job(DISPATCH_START_JOB, { kind: 'pool', tripId: 'p1', generation: 1 }));
    expect(start.startPool).toHaveBeenCalledWith('p1', 1);
  });

  it('delegates the timers to the dispatch handlers', async () => {
    const { proc, dispatch } = make();
    const wave = job(WAVE_TIMEOUT_JOB, { rideId: 'r', waveNumber: 2 });
    const hard = job(HARD_FAIL_JOB, { rideId: 'r' });
    await proc.process(wave);
    await proc.process(hard);
    expect(dispatch.handleWaveTimeout).toHaveBeenCalledWith(wave);
    expect(dispatch.handleHardFail).toHaveBeenCalledWith(hard);
  });

  it('does not catch: a failing start rejects so BullMQ retries and the job is not completed', async () => {
    const { proc, start } = make();
    start.startSolo.mockRejectedValue(new Error('boom'));
    await expect(
      proc.process(job(DISPATCH_START_JOB, { kind: 'solo', tripId: 'r1', generation: 1 })),
    ).rejects.toThrow('boom');
  });

  it('ignores an unknown job name', async () => {
    const { proc, start, dispatch } = make();
    await expect(proc.process(job('mystery', {}))).resolves.toBeUndefined();
    expect(start.startSolo).not.toHaveBeenCalled();
    expect(dispatch.handleHardFail).not.toHaveBeenCalled();
  });
});
