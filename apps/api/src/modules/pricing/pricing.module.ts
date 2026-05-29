import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PricingService } from './pricing.service';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}
