import { Module } from '@nestjs/common';
import { DispatchModule } from '../dispatch/dispatch.module';
import { MatchingModule } from '../matching/matching.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { RideLifecycleService } from './ride-lifecycle.service';

@Module({
  imports: [MatchingModule, RealtimeModule, DispatchModule],
  providers: [RideLifecycleService],
  exports: [RideLifecycleService],
})
export class RideLifecycleModule {}
