import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { MATCHING_QUEUE, POOL_EXPIRE_JOB, PoolLifecycleService } from './pool-lifecycle.service';

export interface PoolExpireJobData {
  rideId: string;
}

@Processor(MATCHING_QUEUE, { autorun: process.env.RCAB_DISABLE_BULL_AUTORUN !== '1' })
export class PoolExpireProcessor extends WorkerHost {
  private readonly log = new Logger(PoolExpireProcessor.name);

  constructor(private readonly lifecycle: PoolLifecycleService) {
    super();
  }

  async process(job: Job<PoolExpireJobData>): Promise<void> {
    if (job.name !== POOL_EXPIRE_JOB) {
      this.log.warn({ jobName: job.name }, 'unexpected job name');
      return;
    }
    await this.lifecycle.closePool(job.data.rideId, 'closed_timeout');
  }
}
