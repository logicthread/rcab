import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { getNumber } from '../../common/utils/env';
import { rearmScheduledRide } from '../scheduled/scheduled-retry';
import { scheduledWindowFromConfig, type ScheduledDispatchWindow } from '../scheduled/scheduled-window';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { dispatchOffer, rides, sharedRide } from '../../db/schema';
import { HARD_FAIL_JOB, WAVE_TIMEOUT_JOB } from '../dispatch/dispatch.service';
import {
  DISPATCH_QUEUE_NAME,
  MATCHING_QUEUE_NAME,
  SCHEDULED_QUEUE_NAME,
  dispatchStartJobId,
  hardFailJobId,
  legacyHardFailJobId,
  legacyPoolExpireJobId,
  legacyWakeJobId,
  legacyWave2JobId,
  poolExpireJobId,
  scheduledWakeJobId,
  wave2JobId,
  type DispatchKind,
} from './outbox.jobs';
import { OutboxRepository } from './outbox.repository';
import { enqueueOutbox } from './outbox.writer';
import { OutboxTopic, type OutboxTopicName } from './outbox.types';

const RECONCILE_EVERY_MS = 5 * 60 * 1000;
/** Ignore trips touched this recently: the relay/worker is probably mid-flight. */
const GRACE_MS = 15_000;
const MAX_PER_PASS = 500;

export interface ReconcileReport {
  wakeRearmed: number;
  dispatchRearmed: number;
  timersRestored: number;
  /** Scheduled rides re-armed under a new generation because their window closed unanswered. */
  scheduledRetried: number;
  poolExpireRearmed: number;
  outboxPending: number;
  outboxOldestPendingAgeS: number | null;
  outboxExhausted: number;
}

/** BullMQ states in which a job will still run (or is running). */
const LIVE_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/**
 * Rebuilds durable work from Postgres (R07, contract §3.4). Postgres is the
 * authority: a processed outbox row proves only that a job was once published,
 * not that it still exists (Redis can be flushed or restored from an old
 * snapshot, a failed job can sit exhausted). On boot and every 5 minutes this
 * finds trips that should have work in flight, checks that the work exists, and
 * re-arms the outbox intent (or restores a timer) when it does not.
 *
 * It never decides business outcomes: a late dispatch is still validated by the
 * worker's generation/state guards, and it never touches trips that are
 * cancelled, claimed or finished.
 */
@Injectable()
export class DispatchReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(DispatchReconciler.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<ReconcileReport> | null = null;
  private readonly waveOneTimeoutMs: number;
  private readonly hardFailMs: number;
  private readonly poolTimeoutMs: number;
  private readonly scheduledWindow: ScheduledDispatchWindow;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly outbox: OutboxRepository,
    @InjectQueue(DISPATCH_QUEUE_NAME) private readonly dispatchQueue: Queue,
    @InjectQueue(SCHEDULED_QUEUE_NAME) private readonly scheduledQueue: Queue,
    @InjectQueue(MATCHING_QUEUE_NAME) private readonly matchingQueue: Queue,
    @Inject(ConfigService) config: ConfigService,
  ) {
    // Same keys and defaults as DispatchService / PoolLifecycleService. Stage C
    // changes none of these values (contract flag F-1).
    this.waveOneTimeoutMs = getNumber(config, 'DISPATCH_WAVE_ONE_TIMEOUT_MS', 30_000, {
      integer: true,
      min: 1,
    });
    this.hardFailMs = getNumber(config, 'DISPATCH_HARD_FAIL_MS', 60_000, { integer: true, min: 1 });
    this.scheduledWindow = scheduledWindowFromConfig(config);
    this.poolTimeoutMs = getNumber(config, 'MATCHING_POOL_TIMEOUT_MS', 60_000, {
      integer: true,
      min: 1,
    });
  }

  onApplicationBootstrap(): void {
    if (process.env.RCAB_DISABLE_OUTBOX_RELAY === '1') return;
    void this.reconcile().catch((err: unknown) =>
      this.log.error({ err }, 'boot reconcile failed'),
    );
    this.timer = setInterval(() => {
      void this.reconcile().catch((err: unknown) =>
        this.log.error({ err }, 'periodic reconcile failed'),
      );
    }, RECONCILE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One full pass. Concurrent callers share the in-flight pass. */
  reconcile(): Promise<ReconcileReport> {
    if (this.running) return this.running;
    const run = this.pass().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async pass(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      wakeRearmed: 0,
      dispatchRearmed: 0,
      timersRestored: 0,
      scheduledRetried: 0,
      poolExpireRearmed: 0,
      outboxPending: 0,
      outboxOldestPendingAgeS: null,
      outboxExhausted: 0,
    };
    // Each step is independent: Redis trouble in one must not block the others,
    // and the next pass retries whatever failed.
    await this.step('unwoken scheduled rides', () => this.reconcileUnwokenScheduled(report));
    await this.step('in-flight solo dispatch', () => this.reconcileSoloDispatch(report));
    await this.step('open pools', () => this.reconcileOpenPools(report));
    await this.step('closed pools', () => this.reconcileClosedPools(report));
    await this.step('outbox stats', async () => {
      const stats = await this.outbox.stats();
      report.outboxPending = stats.pending;
      report.outboxOldestPendingAgeS = stats.oldestPendingAgeS;
      report.outboxExhausted = stats.exhausted;
      if (stats.exhausted > 0 || (stats.oldestPendingAgeS ?? 0) > 60) {
        this.log.warn({ ...stats }, 'outbox backlog');
      }
    });
    if (
      report.wakeRearmed +
        report.dispatchRearmed +
        report.timersRestored +
        report.scheduledRetried +
        report.poolExpireRearmed >
      0
    ) {
      this.log.warn({ ...report }, 'reconcile repaired missing durable work');
    }
    return report;
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log.error({ err, step: name }, 'reconcile step failed; next pass retries');
    }
  }

  // ── 1. scheduled rides whose wake never became a job ──────────────────────

  private async reconcileUnwokenScheduled(report: ReconcileReport): Promise<void> {
    const due = await this.db
      .select({ id: rides.id, scheduledFor: rides.scheduledFor })
      .from(rides)
      .where(
        and(
          eq(rides.type, 'scheduled'),
          eq(rides.status, 'requested'),
          eq(rides.dispatchGeneration, 0),
        ),
      )
      .limit(MAX_PER_PASS);
    for (const ride of due) {
      if (!ride.scheduledFor) continue;
      if (
        await this.hasLiveJob(this.scheduledQueue, [
          scheduledWakeJobId(ride.id, 1),
          legacyWakeJobId(ride.id),
        ])
      ) {
        continue;
      }
      await this.removeFinished(this.scheduledQueue, scheduledWakeJobId(ride.id, 1));
      const exists = await this.outbox.rearm({
        topic: OutboxTopic.RideWakeSchedule,
        aggregateId: ride.id,
        generation: 1,
      });
      if (!exists) {
        await enqueueOutbox(this.db, {
          topic: OutboxTopic.RideWakeSchedule,
          aggregateType: 'ride',
          aggregateId: ride.id,
          generation: 1,
          payload: { scheduledFor: ride.scheduledFor.toISOString() },
        });
      }
      report.wakeRearmed++;
    }
  }

  // ── 2. solo rides dispatching (normal, or woken scheduled) ────────────────

  private async reconcileSoloDispatch(report: ReconcileReport): Promise<void> {
    const open = await this.db
      .select({
        id: rides.id,
        generation: rides.dispatchGeneration,
        type: rides.type,
        updatedAt: rides.updatedAt,
      })
      .from(rides)
      .where(
        and(
          eq(rides.status, 'requested'),
          gt(rides.dispatchGeneration, 0),
          sql`${rides.updatedAt} < now() - (${GRACE_MS}::int * interval '1 millisecond')`,
        ),
      )
      .limit(MAX_PER_PASS);
    for (const ride of open) {
      await this.reconcileDispatching('solo', ride.id, ride.generation, report, {
        scheduled: ride.type === 'scheduled',
        idleSince: ride.updatedAt,
      });
    }
  }

  // ── 3. pools ──────────────────────────────────────────────────────────────

  private async reconcileOpenPools(report: ReconcileReport): Promise<void> {
    const open = await this.db
      .select({
        id: sharedRide.rideId,
        poolClosedAt: sharedRide.poolClosedAt,
        poolOpenedAt: sharedRide.poolOpenedAt,
      })
      .from(sharedRide)
      .where(
        and(
          eq(sharedRide.poolState, 'open'),
          sql`${sharedRide.updatedAt} < now() - (${GRACE_MS}::int * interval '1 millisecond')`,
        ),
      )
      .limit(MAX_PER_PASS);
    for (const pool of open) {
      if (
        await this.hasLiveJob(this.matchingQueue, [
          poolExpireJobId(pool.id),
          legacyPoolExpireJobId(pool.id),
        ])
      ) {
        continue;
      }
      await this.removeFinished(this.matchingQueue, poolExpireJobId(pool.id));
      const exists = await this.outbox.rearm({
        topic: OutboxTopic.PoolExpireSchedule,
        aggregateId: pool.id,
        generation: 0,
      });
      if (!exists) {
        // openPool records the planned close time in pool_closed_at; fall back
        // to opened-at + the configured timeout for pools opened before that.
        const expireAt =
          pool.poolClosedAt ?? new Date(pool.poolOpenedAt.getTime() + this.poolTimeoutMs);
        await enqueueOutbox(this.db, {
          topic: OutboxTopic.PoolExpireSchedule,
          aggregateType: 'shared_ride',
          aggregateId: pool.id,
          generation: 0,
          payload: { expireAt: expireAt.toISOString() },
        });
      }
      report.poolExpireRearmed++;
    }
  }

  private async reconcileClosedPools(report: ReconcileReport): Promise<void> {
    const closed = await this.db
      .select({ id: sharedRide.rideId, generation: sharedRide.dispatchGeneration })
      .from(sharedRide)
      .where(
        and(
          inArray(sharedRide.poolState, ['closed_full', 'closed_timeout']),
          sql`${sharedRide.claimedByDriverId} IS NULL`,
          gt(sharedRide.dispatchGeneration, 0),
          sql`${sharedRide.updatedAt} < now() - (${GRACE_MS}::int * interval '1 millisecond')`,
        ),
      )
      .limit(MAX_PER_PASS);
    for (const pool of closed) {
      await this.reconcileDispatching('pool', pool.id, pool.generation, report);
    }
  }

  // ── shared: is dispatch for (trip, generation) really in flight? ──────────

  private async reconcileDispatching(
    kind: DispatchKind,
    tripId: string,
    generation: number,
    report: ReconcileReport,
    ctx: { scheduled: boolean; idleSince: Date } = { scheduled: false, idleSince: new Date() },
  ): Promise<void> {
    // Scheduled rides run on their own (longer) window; see scheduled-window.ts.
    const waveOneTimeoutMs = ctx.scheduled ? this.scheduledWindow.waveOneMs : this.waveOneTimeoutMs;
    const hardFailMs = ctx.scheduled ? this.scheduledWindow.hardFailMs : this.hardFailMs;
    const startId = dispatchStartJobId(tripId, generation);
    const hardFailIds = [hardFailJobId(tripId, generation), legacyHardFailJobId(tripId)];
    const wave2Ids = [wave2JobId(tripId, generation), legacyWave2JobId(tripId)];

    // The start job itself still being scheduled or running is progress.
    if (await this.hasLiveJob(this.dispatchQueue, [startId])) return;

    const offers = await this.offerSummary(kind, tripId, generation);
    const hasHardFail = await this.hasLiveJob(this.dispatchQueue, hardFailIds);

    // A scheduled ride still `requested` after its window, with no timer left to
    // close that window (lost, or exhausted), is RETRIED under a new generation
    // with a fresh window, never expired and never capped (owner decision,
    // RCAB-E8.S8). Same transaction + generation guard as the hard-fail path, so
    // a concurrent hard-fail / cancel / accept makes this a no-op (null). Not
    // announced to the passenger from here: only the hard-fail path notifies.
    if (ctx.scheduled && !hasHardFail) {
      const windowStart = (offers.firstOfferedAt ?? ctx.idleSince).getTime();
      if (Date.now() >= windowStart + hardFailMs) {
        if (await rearmScheduledRide(this.db, tripId, generation)) report.scheduledRetried++;
        return;
      }
    }

    if (!hasHardFail && offers.count === 0) {
      // Wave 1 never completed (or its timers were lost): start it again. The
      // wave is idempotent per generation, so a duplicate is harmless.
      await this.removeFinished(this.dispatchQueue, startId);
      // A failed/retained hard-fail job for this generation would make the
      // re-armed wave's own hard-fail add a jobId no-op: clear it first.
      await this.removeFinished(this.dispatchQueue, hardFailIds[0]);
      const topic: OutboxTopicName =
        kind === 'solo' ? OutboxTopic.RideDispatchRequested : OutboxTopic.PoolDispatchRequested;
      const exists = await this.outbox.rearm({ topic, aggregateId: tripId, generation });
      if (!exists) {
        if (kind === 'solo') {
          await enqueueOutbox(this.db, {
            topic: OutboxTopic.RideDispatchRequested,
            aggregateType: 'ride',
            aggregateId: tripId,
            generation,
            payload: { rideId: tripId },
          });
        } else {
          await enqueueOutbox(this.db, {
            topic: OutboxTopic.PoolDispatchRequested,
            aggregateType: 'shared_ride',
            aggregateId: tripId,
            generation,
            payload: { poolId: tripId, reason: 'closed_timeout' },
          });
        }
      }
      report.dispatchRearmed++;
      return;
    }

    if (offers.count === 0 || !offers.firstOfferedAt) return;

    // Offers exist: wave 1 ran. Restore whichever timers were lost, with the
    // delay that remains relative to when wave 1 actually offered.
    const now = Date.now();
    const base = offers.firstOfferedAt.getTime();
    if (!hasHardFail) {
      await this.removeFinished(this.dispatchQueue, hardFailIds[0]);
      await this.dispatchQueue.add(
        HARD_FAIL_JOB,
        { rideId: tripId, kind, generation },
        {
          jobId: hardFailIds[0],
          delay: Math.max(0, base + hardFailMs - now),
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      report.timersRestored++;
    }
    const waveOneEndsAt = base + waveOneTimeoutMs;
    if (now < waveOneEndsAt && !(await this.hasLiveJob(this.dispatchQueue, wave2Ids))) {
      await this.removeFinished(this.dispatchQueue, wave2Ids[0]);
      await this.dispatchQueue.add(
        WAVE_TIMEOUT_JOB,
        { rideId: tripId, waveNumber: 2, kind, generation },
        {
          jobId: wave2Ids[0],
          delay: Math.max(0, waveOneEndsAt - now),
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      report.timersRestored++;
    }
  }

  private async offerSummary(
    kind: DispatchKind,
    tripId: string,
    generation: number,
  ): Promise<{ count: number; firstOfferedAt: Date | null }> {
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        first: sql<Date | null>`min(${dispatchOffer.offeredAt})`,
      })
      .from(dispatchOffer)
      .where(
        and(
          kind === 'solo' ? eq(dispatchOffer.rideId, tripId) : eq(dispatchOffer.sharedRideId, tripId),
          eq(dispatchOffer.dispatchGeneration, generation),
        ),
      );
    return { count: Number(row?.count ?? 0), firstOfferedAt: row?.first ? new Date(row.first) : null };
  }

  // ── BullMQ helpers ────────────────────────────────────────────────────────

  private async hasLiveJob(queue: Queue, jobIds: string[]): Promise<boolean> {
    for (const id of jobIds) {
      const job = await queue.getJob(id);
      if (!job) continue;
      if (LIVE_STATES.has(await job.getState())) return true;
    }
    return false;
  }

  /**
   * A finished job still occupies its ID, which would turn the republish into a
   * silent no-op. Only called once we have established the work is missing.
   */
  private async removeFinished(queue: Queue, jobId: string): Promise<void> {
    const job: Job | undefined = await queue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (!LIVE_STATES.has(state)) await job.remove().catch(() => undefined);
  }
}
