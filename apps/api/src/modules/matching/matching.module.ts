import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { RealtimeModule } from '../realtime/realtime.module';
import { RouteSimilarityService } from './route-similarity.service';
import { SharedRideRepository } from './shared-ride.repository';
import { RideStopRepository } from './ride-stop.repository';
import { MatchingService } from './matching.service';
import { PoolLifecycleService, MATCHING_QUEUE } from './pool-lifecycle.service';
import { PoolExpireProcessor } from './pool-expire.processor';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    RealtimeModule,
    BullModule.registerQueue({ name: MATCHING_QUEUE }),
  ],
  providers: [
    RouteSimilarityService,
    SharedRideRepository,
    RideStopRepository,
    PoolLifecycleService,
    MatchingService,
    PoolExpireProcessor,
  ],
  exports: [
    RouteSimilarityService,
    SharedRideRepository,
    RideStopRepository,
    PoolLifecycleService,
    MatchingService,
  ],
})
export class MatchingModule {}
