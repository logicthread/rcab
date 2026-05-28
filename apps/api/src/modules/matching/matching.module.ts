import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { RouteSimilarityService } from './route-similarity.service';
import { SharedRideRepository } from './shared-ride.repository';
import { MatchingService } from './matching.service';
import { PoolLifecycleService, MATCHING_QUEUE } from './pool-lifecycle.service';
import { PoolExpireProcessor } from './pool-expire.processor';

@Module({
  imports: [
    HttpModule,
    ConfigModule,
    BullModule.registerQueue({ name: MATCHING_QUEUE }),
  ],
  providers: [
    RouteSimilarityService,
    SharedRideRepository,
    PoolLifecycleService,
    MatchingService,
    PoolExpireProcessor,
  ],
  exports: [
    RouteSimilarityService,
    SharedRideRepository,
    PoolLifecycleService,
    MatchingService,
  ],
})
export class MatchingModule {}
