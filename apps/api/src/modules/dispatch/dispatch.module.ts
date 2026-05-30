import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RidesModule } from '../rides/rides.module';
import { DispatchService, DISPATCH_QUEUE } from './dispatch.service';
import { DispatchProcessor } from './dispatch.processor';

@Module({
  imports: [
    ConfigModule,
    MatchingModule,
    RealtimeModule,
    RidesModule,
    BullModule.registerQueue({ name: DISPATCH_QUEUE }),
  ],
  providers: [DispatchService, DispatchProcessor],
  exports: [DispatchService],
})
export class DispatchModule {}
