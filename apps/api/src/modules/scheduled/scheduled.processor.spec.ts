import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { ScheduledDispatchProcessor } from './scheduled.processor';
import { SCHEDULED_WAKE_JOB, type ScheduledWakeJob } from './scheduled.service';
import { RIDE_REQUESTED_EVENT } from '../dispatch/dispatch.service';

function makeProcessor() {
  const events = { emit: vi.fn() };
  const proc = new ScheduledDispatchProcessor(events as never);
  return { proc, events };
}

const job = (data: ScheduledWakeJob, name = SCHEDULED_WAKE_JOB) =>
  ({ name, data }) as Job<ScheduledWakeJob>;

describe('ScheduledDispatchProcessor', () => {
  it('emits ride.requested on a wake job — reusing the normal dispatch path', async () => {
    const { proc, events } = makeProcessor();
    await proc.process(job({ rideId: 'ride-42' }));
    expect(events.emit).toHaveBeenCalledWith(RIDE_REQUESTED_EVENT, { rideId: 'ride-42' });
  });

  it('ignores an unexpected job name (no dispatch)', async () => {
    const { proc, events } = makeProcessor();
    await proc.process(job({ rideId: 'ride-42' }, 'something-else'));
    expect(events.emit).not.toHaveBeenCalled();
  });
});
