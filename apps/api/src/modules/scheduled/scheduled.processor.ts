import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SCHEDULED_DISPATCH_QUEUE, SCHEDULED_WAKE_JOB, type ScheduledWakeJob } from './scheduled.service';

// Concurrency is env-tunable per the Phase-0 VPS budget; default modest.
const CONCURRENCY = Number(process.env.SCHEDULED_DISPATCH_CONCURRENCY ?? 5);

/**
 * Worker for the scheduled-booking wake queue. RCAB-E6.S1 lands the runner +
 * skeleton; RCAB-E6.S3 replaces the log with `DispatchService.dispatchSolo(rideId)`
 * so a woken ride re-uses the normal dispatch path.
 *
 * `autorun` is gated so integration tests can boot AppModule without a blocking
 * worker fetch (shared with the other processors — see RCAB-E1.S11).
 */
@Processor(SCHEDULED_DISPATCH_QUEUE, {
  autorun: process.env.RCAB_DISABLE_BULL_AUTORUN !== '1',
  concurrency: CONCURRENCY,
})
export class ScheduledDispatchProcessor extends WorkerHost {
  private readonly log = new Logger(ScheduledDispatchProcessor.name);

  async process(job: Job<ScheduledWakeJob>): Promise<void> {
    if (job.name !== SCHEDULED_WAKE_JOB) {
      this.log.warn({ jobName: job.name }, 'unexpected job name on scheduled-dispatch queue');
      return;
    }
    // RCAB-E6.S3: hydrate the ride and call DispatchService.dispatchSolo(rideId).
    this.log.log({ rideId: job.data.rideId }, 'scheduled wake fired (dispatch wiring: RCAB-E6.S3)');
  }
}
