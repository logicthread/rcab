import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { BusinessMetricsSampler } from './business-metrics.sampler';

/** Periodic business gauges (RCAB-E8.S12). Event metrics live at their commit sites. */
@Module({
  imports: [OutboxModule],
  providers: [BusinessMetricsSampler],
  exports: [BusinessMetricsSampler],
})
export class MetricsModule {}
