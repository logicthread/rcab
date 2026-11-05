import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MatchingModule } from '../matching/matching.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DispatchReconciler } from '../outbox/dispatch-reconciler.service';
import {
  DISPATCH_QUEUE_NAME,
  MATCHING_QUEUE_NAME,
  SCHEDULED_QUEUE_NAME,
} from '../outbox/outbox.jobs';
import { RidesModule } from '../rides/rides.module';
import { ScheduledDispatchProcessor } from '../scheduled/scheduled.processor';
import { ScheduledModule } from '../scheduled/scheduled.module';
import { DispatchModule } from './dispatch.module';
import { DispatchProcessor } from './dispatch.processor';
import { DispatchStartService } from './dispatch-start.service';

/**
 * Hosts everything that RUNS durable dispatch work: the `dispatch` and
 * `scheduled-dispatch` queue workers, the start service they call, and the
 * reconciler that rebuilds lost jobs from Postgres. It sits above both
 * `DispatchModule` and `ScheduledModule`/`RidesModule` so the scheduled wake can
 * call the dispatch path directly (no in-memory event, F08) without a module
 * cycle (Rides -> Scheduled -> Dispatch -> Rides).
 */
@Module({
  imports: [
    ConfigModule,
    DispatchModule,
    MatchingModule,
    OutboxModule,
    RidesModule,
    ScheduledModule,
    BullModule.registerQueue(
      { name: DISPATCH_QUEUE_NAME },
      { name: SCHEDULED_QUEUE_NAME },
      { name: MATCHING_QUEUE_NAME },
    ),
  ],
  providers: [
    DispatchStartService,
    DispatchProcessor,
    ScheduledDispatchProcessor,
    DispatchReconciler,
  ],
  exports: [DispatchStartService, DispatchReconciler],
})
export class DispatchRunnerModule {}
