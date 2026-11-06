import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RidesModule } from '../rides/rides.module';
import { DispatchService, DISPATCH_QUEUE } from './dispatch.service';
import { DispatchOfferRepository } from './offer.repository';
import { DriverAssignmentRepository } from './assignment.repository';
import { DriverAssignmentProjection } from './driver-assignment.projection';

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
  providers: [
    DispatchService,
    DispatchOfferRepository,
    DriverAssignmentRepository,
    DriverAssignmentProjection,
  ],
  exports: [
    DispatchService,
    DispatchOfferRepository,
    DriverAssignmentRepository,
    DriverAssignmentProjection,
  ],
})
export class DispatchModule {}
