import { describe, expect, it } from 'vitest';
import { DISPATCH_QUEUE } from '../dispatch/dispatch.service';
import { MATCHING_QUEUE } from '../matching/pool-lifecycle.service';
import { SCHEDULED_DISPATCH_QUEUE, SCHEDULED_WAKE_JOB } from '../scheduled/scheduled.service';
import {
  DISPATCH_QUEUE_NAME,
  MATCHING_QUEUE_NAME,
  POOL_EXPIRE_JOB_NAME,
  SCHEDULED_QUEUE_NAME,
  SCHEDULED_WAKE_JOB_NAME,
  dispatchStartJobId,
  hardFailJobId,
  legacyHardFailJobId,
  legacyPoolExpireJobId,
  legacyWakeJobId,
  legacyWave2JobId,
  poolExpireJobId,
  scheduledWakeJobId,
  wave2JobId,
} from './outbox.jobs';
import { POOL_EXPIRE_JOB } from '../matching/pool-lifecycle.service';

describe('outbox.jobs', () => {
  it('mirrors the queue and job names owned by their modules (the file is dependency-free on purpose)', () => {
    expect(DISPATCH_QUEUE_NAME).toBe(DISPATCH_QUEUE);
    expect(SCHEDULED_QUEUE_NAME).toBe(SCHEDULED_DISPATCH_QUEUE);
    expect(MATCHING_QUEUE_NAME).toBe(MATCHING_QUEUE);
    expect(SCHEDULED_WAKE_JOB_NAME).toBe(SCHEDULED_WAKE_JOB);
    expect(POOL_EXPIRE_JOB_NAME).toBe(POOL_EXPIRE_JOB);
  });

  it('new job IDs are deterministic, generation-scoped and colon-free', () => {
    const id = '7d1f3c1e-6f9a-4c55-9d43-0b1c2f3a4b5c';
    const ids = [
      dispatchStartJobId(id, 2),
      wave2JobId(id, 2),
      hardFailJobId(id, 2),
      scheduledWakeJobId(id, 1),
      poolExpireJobId(id),
    ];
    expect(ids).toEqual([
      `dispatch-start-${id}-g2`,
      `dispatch-wave2-${id}-g2`,
      `dispatch-hardfail-${id}-g2`,
      `scheduled-wake-${id}-g1`,
      `pool-expire-${id}`,
    ]);
    for (const x of ids) expect(x).not.toContain(':');
    expect(dispatchStartJobId(id, 1)).not.toBe(dispatchStartJobId(id, 2));
  });

  it('legacy IDs keep their in-flight colon form so they can still be addressed', () => {
    expect(legacyWave2JobId('x')).toBe('dispatch:wave2-timeout:x');
    expect(legacyHardFailJobId('x')).toBe('dispatch:hard-fail:x');
    expect(legacyWakeJobId('x')).toBe('scheduled:wake:x');
    expect(legacyPoolExpireJobId('x')).toBe('pool:expire:x');
  });
});
