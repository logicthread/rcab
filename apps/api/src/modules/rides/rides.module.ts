import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { RidesController } from './rides.controller';

@Module({
  imports: [MatchingModule],
  controllers: [RidesController],
})
export class RidesModule {}
