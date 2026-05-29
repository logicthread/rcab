import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  DispatchService,
  DISPATCH_QUEUE,
  HARD_FAIL_JOB,
  WAVE_TIMEOUT_JOB,
} from './dispatch.service';

@Processor(DISPATCH_QUEUE)
export class DispatchProcessor extends WorkerHost {
  private readonly log = new Logger(DispatchProcessor.name);

  constructor(private readonly dispatch: DispatchService) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case WAVE_TIMEOUT_JOB:
        await this.dispatch.handleWaveTimeout(job as Job<{ rideId: string; waveNumber: number }>);
        return;
      case HARD_FAIL_JOB:
        await this.dispatch.handleHardFail(job as Job<{ rideId: string }>);
        return;
      default:
        this.log.warn({ name: job.name }, 'unknown dispatch job; skipping');
        return;
    }
  }
}
