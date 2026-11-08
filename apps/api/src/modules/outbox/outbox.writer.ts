import { outbox } from '../../db/schema';
import type { DbExecutor } from '../../infra/db/drizzle.module';
import { getPolicy } from '../../config/policy/policy';
import { outboxDedupeKey, type OutboxMessage, type OutboxTopicName } from './outbox.types';

/**
 * Record a work intent. MUST be called with the transaction that commits the
 * business mutation it belongs to — that is the whole point of the outbox.
 * Idempotent on the dedupe key: returns false when the intent already exists
 * (a retried writer), true when this call created it. Publishing is the relay's
 * job (outbox slice); callers may nudge it after commit but never publish here.
 */
export async function enqueueOutbox<T extends OutboxTopicName>(
  tx: DbExecutor,
  message: OutboxMessage<T>,
): Promise<boolean> {
  const inserted = await tx
    .insert(outbox)
    .values({
      topic: message.topic,
      aggregateType: message.aggregateType,
      aggregateId: message.aggregateId,
      aggregateGeneration: message.generation,
      payload: message.payload as unknown as Record<string, unknown>,
      dedupeKey: outboxDedupeKey(message.topic, message.aggregateId, message.generation),
      // Policy `outbox.maxPublishAttempts` (same value as the column default, 10).
      maxAttempts: getPolicy().outbox.maxPublishAttempts,
      ...(message.availableAt ? { availableAt: message.availableAt } : {}),
    })
    .onConflictDoNothing({ target: outbox.dedupeKey })
    .returning({ id: outbox.id });
  return inserted.length > 0;
}
