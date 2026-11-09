import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ScheduledDispatchService } from '../scheduled/scheduled.service';
import {
  DISPATCH_QUEUE_NAME,
  DISPATCH_START_JOB,
  MATCHING_QUEUE_NAME,
  POOL_EXPIRE_JOB_NAME,
  dispatchStartJobId,
  poolExpireJobId,
  type DispatchStartJobData,
} from './outbox.jobs';
import { OutboxRepository, type LeasedOutboxRow } from './outbox.repository';
import { OutboxTopic } from './outbox.types';
import { POLICY, getPolicy, type Policy } from '../../config/policy/policy';
import { outboxPublish } from '../../metrics';

/** Raised for a row the relay can never publish; the row is exhausted at once. */
class PermanentPublishError extends Error {}

/**
 * Publishes due outbox rows to BullMQ (R07).
 *
 * Cycle per row: lease (short Postgres txn, committed) -> publish (network,
 * no DB lock held) -> ack fenced by the lease token. Every failure window is
 * recoverable and at worst produces a duplicate publish, which the
 * deterministic job IDs and the consumers' state/generation guards absorb:
 *
 *  - crash before lease commit      -> row still due
 *  - crash/err after lease, pre-publish -> lease expires (30 s), row due again
 *  - publish ok, ack fails/crashes  -> lease expires, republish is a no-op add
 *  - publish fails                  -> `fail()` backs off exponentially
 *
 * Publication is NOT business completion: the BullMQ job only completes once
 * the worker finished the actual dispatch work.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<{ published: number; failed: number }> | null = null;
  private rekick = false;
  private kickTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: OutboxRepository,
    private readonly scheduled: ScheduledDispatchService,
    @InjectQueue(DISPATCH_QUEUE_NAME) private readonly dispatchQueue: Queue,
    @InjectQueue(MATCHING_QUEUE_NAME) private readonly matchingQueue: Queue,
    // Poll/batch/lease and job retry knobs (policy `outbox.*`). Optional so
    // hand-built test harnesses get the process policy.
    @Optional() @Inject(POLICY) private readonly policy: Policy = getPolicy(),
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.RCAB_DISABLE_OUTBOX_RELAY === '1') return;
    this.timer = setInterval(() => void this.tick(), this.policy.outbox.relayPollMs);
    this.timer.unref();
    this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
  }

  /**
   * Ask for an immediate drain (called after a business commit so latency is
   * not bounded by the poll interval). Debounced and fire-and-forget: a failure
   * here is invisible to the caller by design, the poll loop is the backstop.
   */
  kick(): void {
    if (process.env.RCAB_DISABLE_OUTBOX_RELAY === '1') return;
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.tick();
    }, 0);
    this.kickTimer.unref();
  }

  /** One drain pass: lease a batch, publish each row, ack or fail it. */
  drainOnce(): Promise<{ published: number; failed: number }> {
    // One drain at a time per process; a second caller shares the in-flight one.
    if (this.draining) {
      this.rekick = true;
      return this.draining;
    }
    const run = this.drain().finally(() => {
      this.draining = null;
    });
    this.draining = run;
    return run;
  }

  private async tick(): Promise<void> {
    try {
      const { published, failed } = await this.drainOnce();
      // A full batch means more is probably due: keep draining without waiting.
      if (this.rekick || published + failed >= this.policy.outbox.relayBatchSize) {
        this.rekick = false;
        this.kick();
      }
    } catch (err) {
      this.log.error({ err }, 'outbox drain failed');
    }
  }

  private async drain(): Promise<{ published: number; failed: number }> {
    const rows = await this.repo.lease(this.policy.outbox.relayBatchSize, this.policy.outbox.relayLeaseMs);
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.publish(row);
      } catch (err) {
        failed++;
        await this.recordFailure(row, err);
        continue;
      }
      published++;
      outboxPublish.inc({ result: 'published' });
      try {
        const acked = await this.repo.ack(row.id, row.leaseToken);
        if (!acked) {
          this.log.warn({ outboxId: row.id, topic: row.topic }, 'outbox ack lost (lease expired)');
        }
      } catch (err) {
        // Published but not acknowledged: the lease expires and the row is
        // published again, which is a deduplicated no-op.
        this.log.warn({ err, outboxId: row.id }, 'outbox ack failed; row will be re-published');
      }
    }
    return { published, failed };
  }

  private async recordFailure(row: LeasedOutboxRow, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof PermanentPublishError;
    try {
      const outcome = await this.repo.fail(row.id, row.leaseToken, message, { permanent });
      // Attempts, counted separately from business completions.
      outboxPublish.inc({ result: outcome });
      const ctx = { outboxId: row.id, topic: row.topic, attempts: row.attempts, outcome };
      if (outcome === 'exhausted') {
        this.log.error({ ...ctx, err }, 'outbox row exhausted; operator or reconciler must re-arm');
      } else {
        this.log.warn({ ...ctx, err }, 'outbox publish failed; will retry');
      }
    } catch (failErr) {
      // Could not even record the failure: the lease will expire and retry.
      this.log.error({ err: failErr, outboxId: row.id }, 'outbox fail() could not be recorded');
    }
  }

  /** Topic -> BullMQ publication (contract §3.2). */
  private async publish(row: LeasedOutboxRow): Promise<void> {
    const generation = row.aggregateGeneration;
    switch (row.topic) {
      case OutboxTopic.RideDispatchRequested:
        await this.addDispatchStart({ kind: 'solo', tripId: row.aggregateId, generation });
        return;
      case OutboxTopic.PoolDispatchRequested:
        await this.addDispatchStart({ kind: 'pool', tripId: row.aggregateId, generation });
        return;
      case OutboxTopic.RideWakeSchedule: {
        const scheduledFor = parseInstant(row.payload.scheduledFor, 'scheduledFor');
        await this.scheduled.scheduleWake(row.aggregateId, scheduledFor, generation);
        return;
      }
      case OutboxTopic.PoolExpireSchedule: {
        const expireAt = parseInstant(row.payload.expireAt, 'expireAt');
        await this.matchingQueue.add(
          POOL_EXPIRE_JOB_NAME,
          { rideId: row.aggregateId },
          {
            jobId: poolExpireJobId(row.aggregateId),
            delay: Math.max(0, expireAt.getTime() - Date.now()),
            attempts: this.policy.outbox.jobAttempts,
            backoff: { type: 'exponential', delay: this.policy.outbox.jobBackoffMs },
            removeOnComplete: { age: 3_600, count: 1_000 },
            removeOnFail: { age: 7 * 24 * 3_600 },
          },
        );
        return;
      }
      default:
        this.log.error({ outboxId: row.id, topic: row.topic }, 'unknown outbox topic');
        throw new PermanentPublishError('unknown_topic');
    }
  }

  private async addDispatchStart(data: DispatchStartJobData): Promise<void> {
    await this.dispatchQueue.add(DISPATCH_START_JOB, data, {
      jobId: dispatchStartJobId(data.tripId, data.generation),
      attempts: this.policy.outbox.jobAttempts,
      backoff: { type: 'exponential', delay: this.policy.outbox.jobBackoffMs },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    });
  }
}

function parseInstant(raw: unknown, field: string): Date {
  const d = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new PermanentPublishError(`invalid_payload:${field}`);
  return d;
}
