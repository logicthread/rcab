import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { RealtimeModule } from '../realtime/realtime.module';
import { IdempotencyRepository } from '../rides/idempotency.repository';
import { RouteSimilarityService } from './route-similarity.service';
import { SharedRideRepository } from './shared-ride.repository';
import { RideStopRepository } from './ride-stop.repository';
import { MatchingService } from './matching.service';
import { PoolLifecycleService, MATCHING_QUEUE } from './pool-lifecycle.service';
import { PoolExpireProcessor } from './pool-expire.processor';
import { PoolMembershipRepository } from './pool-membership.repository';
import { PoolProjectionService } from './pool-projection.service';

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
    PoolMembershipRepository,
    PoolProjectionService,
    // Stateless (DRIZZLE_DB only): the pool seat transaction completes the
    // shared-create idempotency claim in the same commit.
    IdempotencyRepository,
    PoolLifecycleService,
    MatchingService,
    PoolExpireProcessor,
  ],
  exports: [
    RouteSimilarityService,
    SharedRideRepository,
    RideStopRepository,
    PoolMembershipRepository,
    PoolProjectionService,
    PoolLifecycleService,
    MatchingService,
  ],
})
export class MatchingModule {}
