import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SCHEDULED_DISPATCH_QUEUE, SCHEDULED_WAKE_JOB, type ScheduledWakeJob } from './scheduled.service';
import { DispatchStartService } from '../dispatch/dispatch-start.service';
import { envNumber } from '../../common/utils/env';

// Concurrency is env-tunable per the Phase-0 VPS budget; default modest.
const CONCURRENCY = envNumber('SCHEDULED_DISPATCH_CONCURRENCY', 5, { integer: true, min: 1 });

/**
 * Worker for the scheduled-booking wake queue (RCAB-E6.S3, hardened by R07).
 *
 * The job only completes after `DispatchStartService.wakeScheduled` resolved,
 * i.e. after the wake was recorded in Postgres AND wave 1 of dispatch ran
 * (offers written, wave-2/hard-fail timers added). Errors propagate so BullMQ
 * retries the job; nothing is swallowed. Previously the worker emitted an
 * in-memory event and resolved immediately, so a failing dispatch was logged
 * and lost (F08).
 *
 * A legacy job that was in flight at deploy time has no `generation`; it is
 * treated as generation 1 (a scheduled ride wakes from generation 0 to 1).
 *
 * `autorun` is gated so integration tests can boot AppModule without a blocking
 * worker fetch (shared with the other processors, see RCAB-E1.S11).
 */
@Processor(SCHEDULED_DISPATCH_QUEUE, {
  autorun: process.env.RCAB_DISABLE_BULL_AUTORUN !== '1',
  concurrency: CONCURRENCY,
})
export class ScheduledDispatchProcessor extends WorkerHost {
  private readonly log = new Logger(ScheduledDispatchProcessor.name);

  constructor(private readonly start: DispatchStartService) {
    super();
  }

  async process(job: Job<ScheduledWakeJob>): Promise<void> {
    if (job.name !== SCHEDULED_WAKE_JOB) {
      this.log.warn({ jobName: job.name }, 'unexpected job name on scheduled-dispatch queue');
      return;
    }
    const { rideId } = job.data;
    const generation = job.data.generation ?? 1;
    const outcome = await this.start.wakeScheduled(rideId, generation);
    this.log.log({ rideId, generation, outcome }, 'scheduled wake processed');
  }
}
