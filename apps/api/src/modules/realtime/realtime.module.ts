import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeBus } from './realtime.bus';
import { RealtimeSnapshotService } from './realtime-snapshot.service';

@Module({
  imports: [AuthModule],
  // The snapshot service reads Postgres through the global DrizzleModule only,
  // so realtime keeps no dependency on the feature modules that import it.
  providers: [RealtimeGateway, RealtimeBus, RealtimeSnapshotService],
  exports: [RealtimeBus, RealtimeSnapshotService],
})
export class RealtimeModule {}
