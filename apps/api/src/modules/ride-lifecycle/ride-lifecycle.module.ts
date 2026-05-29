import { Module } from '@nestjs/common';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RideLifecycleService } from './ride-lifecycle.service';

@Module({
  imports: [MatchingModule, RealtimeModule],
  providers: [RideLifecycleService],
  exports: [RideLifecycleService],
})
export class RideLifecycleModule {}
