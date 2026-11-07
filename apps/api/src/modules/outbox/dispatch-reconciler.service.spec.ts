import { describe, it, expect, vi } from 'vitest';
import { DispatchReconciler } from './dispatch-reconciler.service';
import { dispatchStartJobId, hardFailJobId } from './outbox.jobs';

const TRIP = '6f1c1a8e-8f3b-4d7a-9a52-0d5d4c1e2b3a';

function job(state: string) {
  return { getState: vi.fn().mockResolvedValue(state), remove: vi.fn().mockResolvedValue(undefined) };
}

function make(offerRow: { count: number; first: Date | null }, jobs: Record<string, ReturnType<typeof job>>) {
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([offerRow]) }) }),
  };
  const outbox = { rearm: vi.fn().mockResolvedValue(true) };
  const dispatchQueue = {
    getJob: vi.fn(async (id: string) => jobs[id]),
    add: vi.fn().mockResolvedValue(undefined),
  };
  const config = { get: vi.fn().mockReturnValue(undefined) };
  const svc = new DispatchReconciler(
    db as never,
    outbox as never,
    dispatchQueue as never,
    {} as never,
    {} as never,
    config as never,
  );
  const run = () =>
    (
      svc as unknown as {
        reconcileDispatching: (k: string, id: string, g: number, r: object) => Promise<void>;
      }
    ).reconcileDispatching('solo', TRIP, 1, { dispatchRearmed: 0, timersRestored: 0 });
  return { run, outbox, dispatchQueue };
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
