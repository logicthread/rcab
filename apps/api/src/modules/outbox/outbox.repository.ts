import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import type { OutboxAggregateType, OutboxTopicName } from './outbox.types';

export interface LeasedOutboxRow {
  id: string;
  topic: string;
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  aggregateGeneration: number;
  payload: Record<string, unknown>;
  payloadVersion: number;
  dedupeKey: string;
  /** Includes this lease (incremented when the row was leased). */
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeS: number | null;
  exhausted: number;
}

interface RawLeased extends Record<string, unknown> {
  id: string;
  topic: string;
  aggregate_type: OutboxAggregateType;
  aggregate_id: string;
  aggregate_generation: number;
  payload: Record<string, unknown>;
  payload_version: number;
  dedupe_key: string;
  attempts: number;
  max_attempts: number;
  lease_token: string;
}

/**
 * Lease / ack / fail / re-arm for the transactional outbox (migration 0015).
 *
 * Every state change after the lease is fenced by the lease token, so a relay
 * whose lease expired (slow publish, paused process) cannot overwrite the state
 * a newer relay attempt wrote. No method here calls the network; the relay
 * leases in one short transaction, commits, publishes, then acks in another.
 */
@Injectable()
export class OutboxRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /**
   * Lease up to `limit` due rows for `leaseMs`. A single UPDATE with a
   * `FOR UPDATE SKIP LOCKED` subselect: concurrent relays (several api
   * replicas, or the periodic poll racing a kick) never lease the same row.
   * A row whose lease expired is due again (the previous relay died or stalled).
   * `attempts` counts leases, so a row that keeps killing its relay is
   * eventually exhausted rather than re-leased forever.
   */
  async lease(limit: number, leaseMs: number): Promise<LeasedOutboxRow[]> {
    const res = await this.db.execute<RawLeased>(sql`
      UPDATE outbox
         SET lease_token = gen_random_uuid(),
             leased_until = now() + (${leaseMs}::int * interval '1 millisecond'),
             attempts = attempts + 1,
             updated_at = now()
       WHERE id IN (
         SELECT id FROM outbox
          WHERE processed_at IS NULL
            AND failed_at IS NULL
            AND available_at <= now()
            AND (leased_until IS NULL OR leased_until < now())
          ORDER BY available_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id, topic, aggregate_type, aggregate_id, aggregate_generation,
                payload, payload_version, dedupe_key, attempts, max_attempts, lease_token`);
    return res.rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      aggregateGeneration: Number(r.aggregate_generation),
      payload: r.payload,
      payloadVersion: Number(r.payload_version),
      dedupeKey: r.dedupe_key,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
      leaseToken: r.lease_token,
    }));
  }

  /** Record publication. False when the lease was lost (someone else owns the row now). */
  async ack(id: string, leaseToken: string): Promise<boolean> {
    const res = await this.db.execute(sql`
      UPDATE outbox
         SET processed_at = now(), lease_token = NULL, leased_until = NULL,
             last_error = NULL, updated_at = now()
       WHERE id = ${id}::uuid AND lease_token = ${leaseToken}::uuid
         AND processed_at IS NULL AND failed_at IS NULL`);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Publication failed. Backs off exponentially (2^attempts s, capped at 300 s)
   * until `max_attempts`, then marks the row exhausted (`failed_at`); exhausted
   * rows are retried only by the reconciler or an operator (`rearm`).
   * `permanent` exhausts immediately (unknown topic: retrying cannot help).
   */
  async fail(
    id: string,
    leaseToken: string,
    error: string,
    opts: { permanent?: boolean } = {},
  ): Promise<'retry' | 'exhausted' | 'lost_lease'> {
    const permanent = opts.permanent === true;
    const res = await this.db.execute<{ failed_at: Date | null }>(sql`
      UPDATE outbox
         SET last_error = left(${error}, 2000),
             available_at = now() + (least(power(2, attempts), 300) * interval '1 second'),
             failed_at = CASE WHEN ${permanent} OR attempts >= max_attempts THEN now() END,
             lease_token = NULL, leased_until = NULL, updated_at = now()
       WHERE id = ${id}::uuid AND lease_token = ${leaseToken}::uuid
         AND processed_at IS NULL AND failed_at IS NULL
      RETURNING failed_at`);
    if (res.rows.length === 0) return 'lost_lease';
    return res.rows[0].failed_at ? 'exhausted' : 'retry';
  }

  /**
   * Make the intent for (topic, aggregate, generation) publishable again:
   * reconciler / operator retry. A row that is already pending (not yet
   * published, or currently leased) is left alone so a reconciler pass never
   * steals a lease from a live relay. Returns true when such a row exists
   * afterwards (re-armed or already pending), false when there is no row at
   * all (the caller then writes one with `enqueueOutbox`).
   */
  async rearm(where: {
    topic: OutboxTopicName;
    aggregateId: string;
    generation: number;
  }): Promise<boolean> {
    const rearmed = await this.db.execute(sql`
      UPDATE outbox
         SET processed_at = NULL, failed_at = NULL, attempts = 0, available_at = now(),
             lease_token = NULL, leased_until = NULL, updated_at = now()
       WHERE topic = ${where.topic} AND aggregate_id = ${where.aggregateId}::uuid
         AND aggregate_generation = ${where.generation}
         AND (processed_at IS NOT NULL OR failed_at IS NOT NULL)`);
    if ((rearmed.rowCount ?? 0) > 0) return true;
    const pending = await this.db.execute(sql`
      SELECT 1 FROM outbox
       WHERE topic = ${where.topic} AND aggregate_id = ${where.aggregateId}::uuid
         AND aggregate_generation = ${where.generation}`);
    return pending.rows.length > 0;
  }

  async stats(): Promise<OutboxStats> {
    const res = await this.db.execute<{
      pending: string;
      oldest_age_s: string | null;
      exhausted: string;
    }>(sql`
      SELECT count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL) AS pending,
             extract(epoch FROM now() - min(available_at)
               FILTER (WHERE processed_at IS NULL AND failed_at IS NULL AND available_at <= now())
             ) AS oldest_age_s,
             count(*) FILTER (WHERE failed_at IS NOT NULL) AS exhausted
        FROM outbox`);
    const r = res.rows[0];
    return {
      pending: Number(r.pending),
      oldestPendingAgeS: r.oldest_age_s === null ? null : Math.max(0, Number(r.oldest_age_s)),
      exhausted: Number(r.exhausted),
    };
  }
}
