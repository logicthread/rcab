import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/** BullMQ queue that holds the delayed wake-up jobs for scheduled bookings.
 *  Backed by Redis keyspace `bull:scheduled-dispatch:*` (see [[redis-usage]]). */
export const SCHEDULED_DISPATCH_QUEUE = 'scheduled-dispatch';
/** The single job kind on that queue: "wake this ride and dispatch it now". */
export const SCHEDULED_WAKE_JOB = 'scheduled:wake';
/** Wake this many ms BEFORE `scheduled_for` so dispatch has lead time to find a
 *  driver before pickup (RCAB-E6 / [[features-scheduled-booking]]). */
export const SCHEDULED_WAKE_LEAD_MS = 10 * 60 * 1000; // 10 minutes

export interface ScheduledWakeJob {
  rideId: string;
}

/** Deterministic per-ride job id so a scheduled ride has at most one wake job
 *  and cancellation (RCAB-E6.S4) can address it directly. */
export function wakeJobId(rideId: string): string {
  return `scheduled:wake:${rideId}`;
}

/**
 * Owns the scheduled-booking wake queue: enqueue a delayed wake job for a
 * future ride, and cancel it while still pending. The wake HANDLER (running the
 * normal dispatch path) is wired in RCAB-E6.S3; this service is the runner +
 * enqueue/cancel surface (RCAB-E6.S1).
 */
@Injectable()
export class ScheduledDispatchService {
  private readonly log = new Logger(ScheduledDispatchService.name);
  private readonly leadMs: number;

  constructor(
    @InjectQueue(SCHEDULED_DISPATCH_QUEUE) private readonly queue: Queue<ScheduledWakeJob>,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.leadMs = config.get<number>('SCHEDULED_WAKE_LEAD_MS') ?? SCHEDULED_WAKE_LEAD_MS;
  }

  /**
   * Enqueue a delayed wake job to fire `leadMs` before `scheduledFor`. If the
   * wake time is already in the past (edge: scheduled very close to now), the
   * job fires immediately (delay clamped to 0). Idempotent per ride via a fixed
   * jobId — re-scheduling replaces the pending job.
   */
  async scheduleWake(rideId: string, scheduledFor: Date): Promise<{ jobId: string; delayMs: number }> {
    const delayMs = Math.max(0, scheduledFor.getTime() - this.leadMs - Date.now());
    const jobId = wakeJobId(rideId);
    // Replace any existing pending wake for this ride before re-adding.
    await this.queue.remove(jobId).catch(() => undefined);
    await this.queue.add(
      SCHEDULED_WAKE_JOB,
      { rideId },
      { jobId, delay: delayMs, removeOnComplete: true, removeOnFail: 100 },
    );
    this.log.log({ rideId, delayMs }, 'scheduled wake enqueued');
    return { jobId, delayMs };
  }

  /**
   * Remove a still-pending wake job (free cancellation before the ride wakes —
   * RCAB-E6.S4). Returns true if a job was removed. No-op once the job has
   * already fired (removeOnComplete drops it).
   */
  async cancelWake(rideId: string): Promise<boolean> {
    const jobId = wakeJobId(rideId);
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    await job.remove().catch(() => undefined);
    this.log.log({ rideId }, 'scheduled wake cancelled');
    return true;
  }
}
