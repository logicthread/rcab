import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MatchingModule } from '../matching/matching.module';
import { PricingModule } from '../pricing/pricing.module';
import { RidesController } from './rides.controller';
import { QuoteTokenService } from './quote-token.service';
import { RidesRepository } from './rides.repository';

@Module({
  imports: [AuthModule, MatchingModule, PricingModule],
  controllers: [RidesController],
  providers: [QuoteTokenService, RidesRepository],
})
export class RidesModule {}
