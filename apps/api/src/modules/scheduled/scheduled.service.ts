import { Injectable, Inject, Logger } from '@nestjs/common';
import { POLICY, type Policy } from '../../config/policy/policy';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { legacyWakeJobId, scheduledWakeJobId } from '../outbox/outbox.jobs';

/** BullMQ queue that holds the delayed wake-up jobs for scheduled bookings.
 *  Backed by Redis keyspace `bull:scheduled-dispatch:*` (see [[redis-usage]]). */
export const SCHEDULED_DISPATCH_QUEUE = 'scheduled-dispatch';

/** The single job kind on that queue: "wake this ride and dispatch it now". */
export const SCHEDULED_WAKE_JOB = 'scheduled:wake';

/** Wake `scheduled.wakeLeadMs` (policy, default 10 min, env
 *  `SCHEDULED_WAKE_LEAD_MS`) BEFORE `scheduled_for` so dispatch has lead time to
 *  find a driver before pickup (RCAB-E6 / [[features-scheduled-booking]]).
 *  The accept/escalation window after the wake is `scheduled.dispatchWindowMs`
 *  (4 min; owner decision on contract flag F-1), and an unanswered window is
 *  retried, not expired (scheduled-retry.ts). */

export interface ScheduledWakeJob {
  rideId: string;
  /**
   * The dispatch generation this wake starts (Stage C). Absent on legacy jobs
   * that were in flight at deploy time; the worker treats absence as 1.
   */
  generation?: number;
}

/** Deterministic per-(ride, generation) job id (colon-free, contract §1.3). */
export function wakeJobId(rideId: string, generation = 1): string {
  return scheduledWakeJobId(rideId, generation);
}

/**
 * Owns the scheduled-booking wake queue: publish a delayed wake job for a
 * future ride (called by the outbox relay) and cancel it while still pending.
 * The wake HANDLER lives in `DispatchStartService.wakeScheduled`, driven by
 * `ScheduledDispatchProcessor`.
 */
@Injectable()
export class ScheduledDispatchService {
  private readonly log = new Logger(ScheduledDispatchService.name);
  private readonly leadMs: number;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(
    @InjectQueue(SCHEDULED_DISPATCH_QUEUE) private readonly queue: Queue<ScheduledWakeJob>,
    @Inject(POLICY) policy: Policy,
  ) {
    this.leadMs = policy.scheduled.wakeLeadMs;
    this.attempts = policy.outbox.jobAttempts;
    this.backoffMs = policy.outbox.jobBackoffMs;
  }

  /**
   * Publish a delayed wake job to fire `leadMs` before `scheduledFor`. If the
   * wake time is already in the past the job fires immediately (delay clamped
   * to 0). Called by the outbox relay, never inline in a request: the durable
   * intent is the outbox row. Idempotent per (ride, generation) through the
   * deterministic jobId, so a republish after a lost acknowledgment (or a
   * reconciler re-arm) never produces a second wake. Retention keeps the
   * finished job for a while so a late duplicate publish is also a no-op; the
   * worker's status/generation guard is the real protection either way.
   */
  async scheduleWake(
    rideId: string,
    scheduledFor: Date,
    generation = 1,
  ): Promise<{ jobId: string; delayMs: number }> {
    const delayMs = Math.max(0, scheduledFor.getTime() - this.leadMs - Date.now());
    const jobId = wakeJobId(rideId, generation);
    await this.queue.add(
      SCHEDULED_WAKE_JOB,
      { rideId, generation },
      {
        jobId,
        delay: delayMs,
        attempts: this.attempts,
        backoff: { type: 'exponential', delay: this.backoffMs },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    );
    this.log.log({ rideId, generation, delayMs }, 'scheduled wake published');
    return { jobId, delayMs };
  }

  /**
   * Best-effort removal of a still-pending wake job (free cancellation before
   * the ride wakes, RCAB-E6.S4). Removes the generation-1 job and the legacy
   * colon-id job. Returns true if a job was removed. Never the source of
   * safety: a wake that fires anyway is a no-op because the worker only acts on
   * a ride that is still `requested` (T26).
   */
  async cancelWake(rideId: string): Promise<boolean> {
    let removed = false;
    for (const jobId of [wakeJobId(rideId, 1), legacyWakeJobId(rideId)]) {
      const job = await this.queue.getJob(jobId);
      if (!job) continue;
      // An active/finished job cannot be removed; that is fine (see above).
      await job.remove().then(
        () => {
          removed = true;
        },
        () => undefined,
      );
    }
    if (removed) this.log.log({ rideId }, 'scheduled wake cancelled');
    return removed;
  }
}
