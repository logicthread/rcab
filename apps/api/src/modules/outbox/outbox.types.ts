/**
 * Stage C outbox contract (F08 / R07, migration 0015). Shared by every slice
 * that must make work durable in the same transaction as a business mutation.
 * The relay, worker wiring and reconciliation live with the outbox slice; this
 * file holds only the cross-slice vocabulary.
 */

/** Registry of outbox topics. The DB only checks the dotted format. */
export const OutboxTopic = {
  /** Start dispatch generation `g` for a solo/normal ride (or a woken scheduled ride). */
  RideDispatchRequested: 'ride.dispatch.requested',
  /** Publish the delayed BullMQ wake for a scheduled ride (fires at T−lead). */
  RideWakeSchedule: 'ride.wake.schedule',
  /** Start dispatch generation `g` for a closed pool. */
  PoolDispatchRequested: 'pool.dispatch.requested',
  /** Publish the delayed BullMQ expiry (timeout close) for an open pool. */
  PoolExpireSchedule: 'pool.expire.schedule',
} as const;

export type OutboxTopicName = (typeof OutboxTopic)[keyof typeof OutboxTopic];

export type OutboxAggregateType = 'ride' | 'shared_ride';

export interface RideDispatchRequestedPayload {
  rideId: string;
}

export interface RideWakeSchedulePayload {
  /** ISO-8601; the wake fires at scheduledFor − SCHEDULED_WAKE_LEAD_MS. */
  scheduledFor: string;
}

export interface PoolDispatchRequestedPayload {
  poolId: string;
  reason: 'closed_full' | 'closed_timeout';
}

export interface PoolExpireSchedulePayload {
  /** ISO-8601 instant the pool should time out. */
  expireAt: string;
}

export interface OutboxPayloadByTopic {
  'ride.dispatch.requested': RideDispatchRequestedPayload;
  'ride.wake.schedule': RideWakeSchedulePayload;
  'pool.dispatch.requested': PoolDispatchRequestedPayload;
  'pool.expire.schedule': PoolExpireSchedulePayload;
}

export interface OutboxMessage<T extends OutboxTopicName = OutboxTopicName> {
  topic: T;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  /** The rides/shared_rides.dispatch_generation this work targets. */
  generation: number;
  payload: OutboxPayloadByTopic[T];
  /** Earliest publish instant; defaults to now(). */
  availableAt?: Date;
}

/** `<topic>:<aggregateId>:g<generation>` — one intent per (topic, row, generation). */
export function outboxDedupeKey(topic: OutboxTopicName, aggregateId: string, generation: number): string {
  return `${topic}:${aggregateId}:g${generation}`;
}
