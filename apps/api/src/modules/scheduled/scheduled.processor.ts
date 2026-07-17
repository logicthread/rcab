import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Job } from 'bullmq';
import { SCHEDULED_DISPATCH_QUEUE, SCHEDULED_WAKE_JOB, type ScheduledWakeJob } from './scheduled.service';
import { RIDE_REQUESTED_EVENT, type RideRequestedEventPayload } from '../dispatch/dispatch.service';

// Concurrency is env-tunable per the Phase-0 VPS budget; default modest.
const CONCURRENCY = Number(process.env.SCHEDULED_DISPATCH_CONCURRENCY ?? 5);

/**
 * Worker for the scheduled-booking wake queue (RCAB-E6.S3). On wake it emits the
 * exact same `ride.requested` event a normal booking fires at creation, so the
 * woken ride re-uses the normal dispatch path with zero new dispatch logic:
 * `DispatchService.@OnEvent(RIDE_REQUESTED_EVENT)` → `dispatchSolo`, which guards
 * on `status='requested'` (a ride cancelled before wake is safely skipped).
 *
 * Emitting the event (rather than importing DispatchModule) also avoids a module
 * cycle: RidesModule → ScheduledModule (S2) and DispatchModule → RidesModule
 * already exist; a direct ScheduledModule → DispatchModule import would close the
 * loop. EventEmitter2 is global; the event constant is a value-only import.
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

  constructor(private readonly events: EventEmitter2) {
    super();
  }

  async process(job: Job<ScheduledWakeJob>): Promise<void> {
    if (job.name !== SCHEDULED_WAKE_JOB) {
      this.log.warn({ jobName: job.name }, 'unexpected job name on scheduled-dispatch queue');
      return;
    }
    const { rideId } = job.data;
    this.log.log({ rideId }, 'scheduled wake → ride.requested (normal dispatch path)');
    this.events.emit(RIDE_REQUESTED_EVENT, { rideId } satisfies RideRequestedEventPayload);
  }
}
