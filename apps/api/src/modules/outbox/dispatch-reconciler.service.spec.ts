import { buildPolicy } from '../../config/policy/policy';
import { describe, it, expect, vi } from 'vitest';

const { rearm } = vi.hoisted(() => ({ rearm: vi.fn() }));
vi.mock('../scheduled/scheduled-retry', () => ({ rearmScheduledRide: rearm }));
import { DispatchReconciler } from './dispatch-reconciler.service';
import { dispatchStartJobId, hardFailJobId } from './outbox.jobs';

const TRIP = '6f1c1a8e-8f3b-4d7a-9a52-0d5d4c1e2b3a';

function job(state: string) {
  return { getState: vi.fn().mockResolvedValue(state), remove: vi.fn().mockResolvedValue(undefined) };
}

function make(
  offerRow: { count: number; first: Date | null },
  jobs: Record<string, ReturnType<typeof job>>,
  extra: { dispatch?: unknown; env?: Record<string, unknown> } = {},
) {
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([offerRow]) }) }),
  };
  const outbox = { rearm: vi.fn().mockResolvedValue(true) };
  const dispatchQueue = {
    getJob: vi.fn(async (id: string) => jobs[id]),
    add: vi.fn().mockResolvedValue(undefined),
  };
  const config = { get: vi.fn((k: string) => extra.env?.[k]) };
  const svc = new DispatchReconciler(
    db as never,
    outbox as never,
    dispatchQueue as never,
    {} as never,
    {} as never,
    buildPolicy(config),
    extra.dispatch as never,
  );
  const report = { dispatchRearmed: 0, timersRestored: 0, scheduledRetried: 0, scheduledExpired: 0 };
  const run = (ctx?: { scheduled: boolean; idleSince: Date }) =>
    (
      svc as unknown as {
        reconcileDispatching: (k: string, id: string, g: number, r: object, c?: object) => Promise<void>;
      }
    ).reconcileDispatching('solo', TRIP, 1, report, ctx);
  return { run, outbox, dispatchQueue, report };
}

describe('DispatchReconciler.reconcileDispatching — no offers yet', () => {
  it('removes a failed/retained hard-fail job before re-arming wave 1, so the new timer is not deduped', async () => {
    const start = job('completed');
    const hardFail = job('failed');
    const { run, outbox } = make(
      { count: 0, first: null },
      { [dispatchStartJobId(TRIP, 1)]: start, [hardFailJobId(TRIP, 1)]: hardFail },
    );
    await run();
    expect(start.remove).toHaveBeenCalledTimes(1);
    expect(hardFail.remove).toHaveBeenCalledTimes(1);
    expect(outbox.rearm).toHaveBeenCalledTimes(1);
  });

  it('never removes a live hard-fail job (that case is not a re-arm at all)', async () => {
    const hardFail = job('delayed');
    const { run, outbox } = make({ count: 0, first: null }, { [hardFailJobId(TRIP, 1)]: hardFail });
    await run();
    expect(hardFail.remove).not.toHaveBeenCalled();
    expect(outbox.rearm).not.toHaveBeenCalled();
  });
});

describe('DispatchReconciler.reconcileDispatching — scheduled retry cutoff (RCAB-E8.S13)', () => {
  const overdue = { scheduled: true, idleSince: new Date(Date.now() - 600_000) };

  it('passes the policy cutoff to the settle transaction and counts a re-arm', async () => {
    rearm.mockReset().mockResolvedValue({ outcome: 'rearmed' });
    const dispatch = { onScheduledNoDriver: vi.fn() };
    const { run, report } = make({ count: 1, first: new Date(Date.now() - 300_000) }, {}, {
      dispatch,
      env: { SCHEDULED_RETRY_CUTOFF_AFTER_PICKUP_MS: '900000' },
    });
    await run(overdue);
    expect(rearm).toHaveBeenCalledWith(expect.anything(), TRIP, 1, { cutoffAfterPickupMs: 900_000 });
    expect(report.scheduledRetried).toBe(1);
    expect(report.scheduledExpired).toBe(0);
    expect(dispatch.onScheduledNoDriver).not.toHaveBeenCalled();
  });

  it('past the cutoff: counts the expiry and tells the passenger via DispatchService', async () => {
    const ended = {
      outcome: 'no_driver',
      rideId: TRIP,
      passengerId: 'c-1',
      generation: 1,
      revokedOffers: [],
    };
    rearm.mockReset().mockResolvedValue(ended);
    const dispatch = { onScheduledNoDriver: vi.fn().mockResolvedValue(undefined) };
    const { run, report } = make({ count: 1, first: new Date(Date.now() - 300_000) }, {}, { dispatch });
    await run(overdue);
    expect(report.scheduledExpired).toBe(1);
    expect(report.scheduledRetried).toBe(0);
    expect(dispatch.onScheduledNoDriver).toHaveBeenCalledWith(ended);
  });

  it('a failing notification does not fail the reconcile pass', async () => {
    rearm.mockReset().mockResolvedValue({ outcome: 'no_driver', rideId: TRIP });
    const dispatch = { onScheduledNoDriver: vi.fn().mockRejectedValue(new Error('bus down')) };
    const { run, report } = make({ count: 1, first: new Date(Date.now() - 300_000) }, {}, { dispatch });
    await expect(run(overdue)).resolves.toBeUndefined();
    expect(report.scheduledExpired).toBe(1);
  });

  it('a no-op settle (cancelled / accepted concurrently) counts nothing', async () => {
    rearm.mockReset().mockResolvedValue(null);
    const dispatch = { onScheduledNoDriver: vi.fn() };
    const { run, report } = make({ count: 1, first: new Date(Date.now() - 300_000) }, {}, { dispatch });
    await run(overdue);
    expect(report).toMatchObject({ scheduledRetried: 0, scheduledExpired: 0 });
    expect(dispatch.onScheduledNoDriver).not.toHaveBeenCalled();
  });

  it('a live hard-fail timer is trusted: the timer path settles, not the reconciler', async () => {
    rearm.mockReset();
    const { run } = make(
      { count: 1, first: new Date(Date.now() - 300_000) },
      { [hardFailJobId(TRIP, 1)]: job('delayed') },
    );
    await run(overdue);
    expect(rearm).not.toHaveBeenCalled();
  });
});
