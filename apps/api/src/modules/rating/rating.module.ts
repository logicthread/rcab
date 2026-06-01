import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RidesModule } from '../rides/rides.module';
import { RatingController } from './rating.controller';
import { RatingService } from './rating.service';
import { RatingRepository } from './rating.repository';

/**
 * Rating capture (the insert half of the `rating` module per [[module-map]]).
 * Aggregation + denorm to `user.rating_avg`/`rating_count` is Epic E7. Imports
 * RidesModule for `RidesRepository` (ride lookup) and AuthModule for the guard.
 * RCAB-E4.S9.
 */
@Module({
  imports: [AuthModule, RidesModule],
  controllers: [RatingController],
  providers: [RatingService, RatingRepository],
})
export class RatingModule {}
