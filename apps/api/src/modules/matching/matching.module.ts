import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { RouteSimilarityService } from './route-similarity.service';
import { SharedRideRepository } from './shared-ride.repository';
import { MatchingService } from './matching.service';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [RouteSimilarityService, SharedRideRepository, MatchingService],
  exports: [RouteSimilarityService, SharedRideRepository, MatchingService],
})
export class MatchingModule {}
