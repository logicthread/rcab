import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { POLICY, type Policy } from '../../config/policy/policy';
import { DRIZZLE_DB, type DrizzleDb } from '../../infra/db/drizzle.module';
import { REDIS } from '../../infra/redis/redis.module';
import {
  activeDrivers,
  busyDrivers,
  outboxExhausted,
  outboxOldestPendingAge,
  outboxPending,
  sharedMatchRate,
} from '../../metrics';
import { OutboxRepository } from '../outbox/outbox.repository';

const GEO_KEY = 'active_drivers';

export interface SampleReport {
  activeDrivers: number | null;
  busyDrivers: number | null;
  outbox: { pending: number; oldestPendingAgeS: number; exhausted: number } | null;
  /** riders in pools closed in the window; `rate` is null when that is 0. */
  matchRate: { riders: number; shared: number; rate: number | null } | null;
}

/**
 * Periodically samples the gauges that are a STATE rather than an event
 * (RCAB-E8.S12): who is online / busy, how much required work is waiting in the
 * outbox, and how many riders actually shared a ride. Event-shaped metrics
 * (outcomes, transitions, latencies, pool joins) are counted at the commit that
 * made them true instead.
 *
 * Each source is sampled independently. A source that cannot be read REMOVES its
 * gauge (the series is removed) rather than keeping a stale, healthy-looking
 * value: missing telemetry must be distinguishable from "all quiet".
 */
@Injectable()
export class BusinessMetricsSampler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(BusinessMetricsSampler.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly everyMs: number;
  private readonly matchWindowMs: number;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly outbox: OutboxRepository,
    @Inject(POLICY) policy: Policy,
  ) {
    this.everyMs = policy.observability.sampleIntervalMs;
    this.matchWindowMs = policy.observability.matchRateWindowMs;
  }

  onApplicationBootstrap(): void {
    if (process.env.RCAB_DISABLE_OUTBOX_RELAY === '1') return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.everyMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sampling pass; never throws. Returns what it read (null = source failed). */
  async sample(): Promise<SampleReport> {
    const report: SampleReport = { activeDrivers: null, busyDrivers: null, outbox: null, matchRate: null };

    report.activeDrivers = await this.step('active drivers', () => activeDrivers.remove(), async () => {
      const n = await this.redis.zcard(GEO_KEY);
      activeDrivers.set(n);
      return n;
    });

    report.busyDrivers = await this.step('busy drivers', () => busyDrivers.remove(), async () => {
      const res = await this.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM driver_active_assignment`);
      const n = Number(res.rows[0]?.n ?? 0);
      busyDrivers.set(n);
      return n;
    });

    report.outbox = await this.step(
      'outbox backlog',
      () => {
        outboxPending.remove();
        outboxOldestPendingAge.remove();
        outboxExhausted.remove();
      },
      async () => {
        const stats = await this.outbox.stats();
        const oldest = stats.oldestPendingAgeS ?? 0;
        outboxPending.set(stats.pending);
        outboxOldestPendingAge.set(oldest);
        outboxExhausted.set(stats.exhausted);
        return { pending: stats.pending, oldestPendingAgeS: oldest, exhausted: stats.exhausted };
      },
    );

    report.matchRate = await this.step('shared match rate', () => sharedMatchRate.remove(), async () => {
      const m = await this.readMatchRate();
      // No pool closed in the window: there is no rate. Absent, not 0 and not 1.
      if (m.rate === null) sharedMatchRate.remove();
      else sharedMatchRate.set(m.rate);
      return m;
    });

    return report;
  }

  /**
   * Population: riders (pool_member rows, one seat each) of pools that LEFT
   * `open` with `pool_closed_at` inside the window. A rider counts as matched
   * when their pool held at least two riders. This measures pool formation
   * (did shared requests meet each other), independent of whether a driver
   * later accepted the pool; that is `rcab_dispatch_outcome_total{kind="pool"}`.
   */
  async readMatchRate(): Promise<{ riders: number; shared: number; rate: number | null }> {
    const res = await this.db.execute<{ riders: string; shared: string }>(sql`
      WITH closed AS (
        SELECT s.ride_id, count(m.passenger_id) AS members
          FROM shared_rides s
          JOIN pool_member m ON m.pool_id = s.ride_id
         WHERE s.pool_state <> 'open'
           AND s.pool_closed_at >= now() - (${this.matchWindowMs}::bigint * interval '1 millisecond')
         GROUP BY s.ride_id)
      SELECT coalesce(sum(members), 0) AS riders,
             coalesce(sum(members) FILTER (WHERE members >= 2), 0) AS shared
        FROM closed`);
    const riders = Number(res.rows[0]?.riders ?? 0);
    const shared = Number(res.rows[0]?.shared ?? 0);
    return { riders, shared, rate: riders > 0 ? shared / riders : null };
  }

  private async step<T>(name: string, onFail: () => void, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      onFail();
      this.log.warn({ err, step: name }, 'metrics sample failed; gauge removed until the next pass');
      return null;
    }
  }
}
