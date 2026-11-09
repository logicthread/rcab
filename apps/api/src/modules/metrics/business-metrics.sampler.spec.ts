import { beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from 'prom-client';
import { buildPolicy } from '../../config/policy/policy';
import { BusinessMetricsSampler } from './business-metrics.sampler';

async function gauge(name: string): Promise<number | undefined> {
  const m = (await register.getMetricsAsJSON()).find((x) => x.name === name);
  const v = (m?.values as Array<{ value: number }> | undefined)?.[0];
  return v?.value;
}

function make(
  over: {
    zcard?: () => Promise<number>;
    execute?: (q: unknown) => Promise<{ rows: unknown[] }>;
    stats?: () => Promise<{ pending: number; oldestPendingAgeS: number | null; exhausted: number }>;
  } = {},
) {
  const redis = { zcard: vi.fn(over.zcard ?? (async () => 7)) };
  const db = {
    execute: vi.fn(
      over.execute ??
        (async (q: unknown) => {
          const text = JSON.stringify(q);
          return text.includes('driver_active_assignment')
            ? { rows: [{ n: '3' }] }
            : { rows: [{ riders: '10', shared: '8' }] };
        }),
    ),
  };
  const outbox = {
    stats: vi.fn(over.stats ?? (async () => ({ pending: 4, oldestPendingAgeS: 12.5, exhausted: 1 }))),
  };
  const sampler = new BusinessMetricsSampler(db as never, redis as never, outbox as never, buildPolicy({}));
  return { sampler, redis, db, outbox };
}

describe('BusinessMetricsSampler', () => {
  beforeEach(() => {
    register.resetMetrics();
  });

  it('publishes drivers, backlog and match rate from their sources', async () => {
    const { sampler } = make();
    const report = await sampler.sample();
    expect(report).toEqual({
      activeDrivers: 7,
      busyDrivers: 3,
      outbox: { pending: 4, oldestPendingAgeS: 12.5, exhausted: 1 },
      matchRate: { riders: 10, shared: 8, rate: 0.8 },
    });
    expect(await gauge('rcab_active_drivers')).toBe(7);
    expect(await gauge('rcab_busy_drivers')).toBe(3);
    expect(await gauge('rcab_outbox_pending')).toBe(4);
    expect(await gauge('rcab_outbox_oldest_pending_age_seconds')).toBe(12.5);
    expect(await gauge('rcab_outbox_exhausted')).toBe(1);
    expect(await gauge('rcab_shared_match_rate')).toBe(0.8);
  });

  it('nothing due reads as age 0 (not null), but no closed pool means NO match rate', async () => {
    const { sampler } = make({
      stats: async () => ({ pending: 0, oldestPendingAgeS: null, exhausted: 0 }),
      execute: async (q) =>
        JSON.stringify(q).includes('driver_active_assignment')
          ? { rows: [{ n: '0' }] }
          : { rows: [{ riders: '0', shared: '0' }] },
    });
    const report = await sampler.sample();
    expect(report.matchRate).toEqual({ riders: 0, shared: 0, rate: null });
    expect(await gauge('rcab_outbox_oldest_pending_age_seconds')).toBe(0);
    // Zero denominator is not "healthy": the series is absent, not 0 and not 1.
    expect(await gauge('rcab_shared_match_rate')).toBeUndefined();
  });

  it('a source that fails removes its gauge instead of leaving a stale value; the others still update', async () => {
    const { sampler, redis, outbox } = make();
    await sampler.sample();
    expect(await gauge('rcab_active_drivers')).toBe(7);

    redis.zcard.mockRejectedValue(new Error('redis down'));
    outbox.stats.mockRejectedValue(new Error('pg down'));
    const report = await sampler.sample();

    expect(report.activeDrivers).toBeNull();
    expect(report.outbox).toBeNull();
    expect(await gauge('rcab_active_drivers')).toBeUndefined();
    expect(await gauge('rcab_outbox_pending')).toBeUndefined();
    expect(await gauge('rcab_outbox_exhausted')).toBeUndefined();
    // Independent sources keep reporting.
    expect(await gauge('rcab_busy_drivers')).toBe(3);
  });

  it('never throws, even when every source fails', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    const { sampler } = make({ zcard: boom, execute: boom, stats: boom });
    await expect(sampler.sample()).resolves.toEqual({
      activeDrivers: null,
      busyDrivers: null,
      outbox: null,
      matchRate: null,
    });
  });

  it('the timer is off under RCAB_DISABLE_OUTBOX_RELAY=1 (test seam) and unref-ed otherwise', () => {
    const { sampler } = make();
    const prev = process.env.RCAB_DISABLE_OUTBOX_RELAY;
    try {
      process.env.RCAB_DISABLE_OUTBOX_RELAY = '1';
      sampler.onApplicationBootstrap();
      expect((sampler as unknown as { timer: unknown }).timer).toBeNull();

      process.env.RCAB_DISABLE_OUTBOX_RELAY = '0';
      sampler.onApplicationBootstrap();
      expect((sampler as unknown as { timer: unknown }).timer).not.toBeNull();
    } finally {
      sampler.onModuleDestroy();
      if (prev === undefined) delete process.env.RCAB_DISABLE_OUTBOX_RELAY;
      else process.env.RCAB_DISABLE_OUTBOX_RELAY = prev;
    }
    expect((sampler as unknown as { timer: unknown }).timer).toBeNull();
  });
});
