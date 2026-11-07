import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduledDispatchService, SCHEDULED_DISPATCH_QUEUE } from './scheduled.service';

/**
 * Scheduled booking (Epic E6, Demo 5). Owns the BullMQ queue handle that holds
 * the delayed wake jobs for future rides (publish by the outbox relay, cancel by
 * the rides controller). The wake WORKER (`ScheduledDispatchProcessor`) is
 * provided by `DispatchRunnerModule`: it must call `DispatchStartService`, and
 * hosting it here would close a module cycle (Rides -> Scheduled -> Dispatch ->
 * Rides) that the old in-memory event existed to avoid.
 */
@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: SCHEDULED_DISPATCH_QUEUE })],
  providers: [ScheduledDispatchService],
  exports: [ScheduledDispatchService],
})
export class ScheduledModule {}
