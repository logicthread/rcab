import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduledDispatchService, SCHEDULED_DISPATCH_QUEUE } from './scheduled.service';
import { ScheduledDispatchProcessor } from './scheduled.processor';

/**
 * Scheduled booking (Epic E6, Demo 5). Owns the BullMQ delayed-job runner that
 * wakes a future ride ~10 min before pickup and hands it to the normal dispatch
 * path. S1 = queue + runner + enqueue/cancel; S2 wires the quote/request flow;
 * S3 wires the wake handler to DispatchService (this module will import
 * DispatchModule then).
 */
@Module({
  imports: [ConfigModule, BullModule.registerQueue({ name: SCHEDULED_DISPATCH_QUEUE })],
  providers: [ScheduledDispatchService, ScheduledDispatchProcessor],
  exports: [ScheduledDispatchService],
})
export class ScheduledModule {}
