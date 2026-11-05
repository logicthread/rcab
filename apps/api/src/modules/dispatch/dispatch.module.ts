import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RidesModule } from '../rides/rides.module';
import { DispatchService, DISPATCH_QUEUE } from './dispatch.service';

@Module({
  imports: [
    ConfigModule,
    MatchingModule,
    RealtimeModule,
    RidesModule,
    BullModule.registerQueue({ name: DISPATCH_QUEUE }),
  ],
  // DispatchProcessor (+ DispatchStartService) live in DispatchRunnerModule: the
  // processor calls the start service, which needs the rides/outbox modules.
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
