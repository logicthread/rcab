import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MatchingModule } from '../matching/matching.module';
import { PricingModule } from '../pricing/pricing.module';
import { RidesController } from './rides.controller';

@Module({
  imports: [AuthModule, MatchingModule, PricingModule],
  controllers: [RidesController],
})
export class RidesModule {}
