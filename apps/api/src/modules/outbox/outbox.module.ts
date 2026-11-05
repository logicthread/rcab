import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScheduledModule } from '../scheduled/scheduled.module';
import { DISPATCH_QUEUE_NAME, MATCHING_QUEUE_NAME } from './outbox.jobs';
import { OutboxRepository } from './outbox.repository';
import { OutboxRelay } from './outbox.relay';

/**
 * Transactional outbox (R07): the relay that publishes durable work intents to
 * BullMQ. Depends only on Postgres and the queue handles, never on the workers,
 * so any module that writes outbox rows (rides, matching) can import it without
 * creating a cycle. Workers and the reconciler live in `DispatchRunnerModule`.
 */
@Module({
  imports: [
    ScheduledModule,
    BullModule.registerQueue({ name: DISPATCH_QUEUE_NAME }, { name: MATCHING_QUEUE_NAME }),
  ],
  providers: [OutboxRepository, OutboxRelay],
  exports: [OutboxRepository, OutboxRelay],
})
export class OutboxModule {}
