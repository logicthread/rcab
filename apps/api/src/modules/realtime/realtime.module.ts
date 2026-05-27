import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeBus } from './realtime.bus';

@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RealtimeBus],
  exports: [RealtimeBus],
})
export class RealtimeModule {}
