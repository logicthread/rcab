import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MatchingModule } from '../matching/matching.module';
import { PricingModule } from '../pricing/pricing.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RidesController } from './rides.controller';
import { QuoteTokenService } from './quote-token.service';
import { RidesRepository } from './rides.repository';
import { RideStateMachine } from './ride-state-machine.service';

@Module({
  imports: [AuthModule, MatchingModule, PricingModule, RealtimeModule],
  controllers: [RidesController],
  providers: [QuoteTokenService, RidesRepository, RideStateMachine],
  exports: [RidesRepository],
})
export class RidesModule {}
