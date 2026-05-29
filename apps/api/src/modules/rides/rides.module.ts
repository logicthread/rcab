import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { PricingModule } from '../pricing/pricing.module';
import { RidesController } from './rides.controller';

@Module({
  imports: [MatchingModule, PricingModule],
  controllers: [RidesController],
})
export class RidesModule {}
