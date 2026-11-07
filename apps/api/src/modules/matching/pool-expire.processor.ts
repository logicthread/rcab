import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MATCHING_QUEUE, POOL_EXPIRE_JOB, PoolLifecycleService } from './pool-lifecycle.service';

/**
 * Published by the outbox relay from `pool.expire.schedule` (jobId
 * `pool-expire-<id>`); legacy in-flight jobs (`pool:expire:<id>`) carry the
 * same data and are handled identically.
 */
export interface PoolExpireJobData {
  rideId: string;
}

@Processor(MATCHING_QUEUE, { autorun: process.env.RCAB_DISABLE_BULL_AUTORUN !== '1' })
export class PoolExpireProcessor extends WorkerHost {
  private readonly log = new Logger(PoolExpireProcessor.name);

  constructor(private readonly lifecycle: PoolLifecycleService) {
    super();
  }

  /**
   * Guarded timeout close. A stale timeout (pool already full / started /
   * finished) is a successful no-op; errors propagate so BullMQ retries.
   */
  async process(job: Job<PoolExpireJobData>): Promise<void> {
    if (job.name !== POOL_EXPIRE_JOB) {
      this.log.warn({ jobName: job.name }, 'unexpected job name');
      return;
    }
    const result = await this.lifecycle.closeIfOpen(job.data.rideId, 'closed_timeout');
    this.log.log({ rideId: job.data.rideId, result }, 'pool:expire processed');
  }
}
