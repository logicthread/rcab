import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  DispatchService,
  DISPATCH_QUEUE,
  HARD_FAIL_JOB,
  WAVE_TIMEOUT_JOB,
  type HardFailJob,
  type WaveTimeoutJob,
} from './dispatch.service';
import { DispatchStartService } from './dispatch-start.service';
import { DISPATCH_START_JOB, type DispatchStartJobData } from '../outbox/outbox.jobs';
import { recordDispatchOutcome } from '../../metrics';

/**
 * Worker for the `dispatch` queue. Errors are never caught here: a job that
 * throws is retried by BullMQ and only completes once the dispatch work it
 * stands for has actually finished (R07 / F08). Stale or duplicate jobs are
 * absorbed by the generation/state guards inside the handlers, which return
 * normally.
 */
@Processor(DISPATCH_QUEUE, { autorun: process.env.RCAB_DISABLE_BULL_AUTORUN !== '1' })
export class DispatchProcessor extends WorkerHost {
  private readonly log = new Logger(DispatchProcessor.name);

  constructor(
    private readonly dispatch: DispatchService,
    private readonly start: DispatchStartService,
  ) {
    super();
  }

  /**
   * A dispatch job that failed for good (BullMQ attempts used up) is a dispatch
   * generation lost to infrastructure trouble; the reconciler will rebuild the
   * work, but the failure must be visible. A failure that BullMQ will retry is
   * not counted (that is an attempt, not an outcome).
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined): void {
    if (!job) return;
    if (job.attemptsMade < (job.opts?.attempts ?? 1)) return;
    const kind = (job.data as { kind?: string } | undefined)?.kind === 'solo' ? 'solo' : 'pool';
    recordDispatchOutcome('infra_failure', kind);
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case DISPATCH_START_JOB: {
        const { kind, tripId, generation } = job.data as DispatchStartJobData;
        const outcome =
          kind === 'pool'
            ? await this.start.startPool(tripId, generation)
            : await this.start.startSolo(tripId, generation);
        this.log.log({ kind, tripId, generation, outcome }, 'dispatch start processed');
        return;
      }
      case WAVE_TIMEOUT_JOB:
        await this.dispatch.handleWaveTimeout(job as Job<WaveTimeoutJob>);
        return;
      case HARD_FAIL_JOB:
        await this.dispatch.handleHardFail(job as Job<HardFailJob>);
        return;
      default:
        this.log.warn({ name: job.name }, 'unknown dispatch job; skipping');
        return;
    }
  }
}
