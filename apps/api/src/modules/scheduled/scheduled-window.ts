import type { Policy } from '../../config/policy/policy';

/**
 * Accept/escalation window for SCHEDULED rides (owner decision, RCAB-E8.S8).
 *
 * [[features-scheduled-booking]] step 4: "If no driver accepts within 4
 * minutes, the system notifies the client and escalates". A scheduled ride is
 * woken ahead of pickup (`SCHEDULED_WAKE_LEAD_MS`), so it can afford the longer
 * window; the reused normal path (30 s wave 1, 60 s hard-fail) is left alone
 * and keeps its own `DISPATCH_*` knobs.
 *
 * Two timers, mirroring the normal path's shape:
 *  - wave 2 (widen radius / more drivers) at `waveOneMs`, default half the window
 *  - the window end (`hardFailMs`): for a scheduled ride this does NOT expire
 *    the ride, it RETRIES it (see `scheduled-retry.ts`).
 */
export interface ScheduledDispatchWindow {
  /** Delay before wave 2 is offered (from wave 1). */
  waveOneMs: number;
  /** Delay before the window closes and the ride is retried (from wave 1). */
  hardFailMs: number;
}

/**
 * The scheduled window from the validated policy (`scheduled.dispatchWindowMs`,
 * `scheduled.dispatchWaveOneMs`; env `SCHEDULED_DISPATCH_WINDOW_MS` /
 * `SCHEDULED_DISPATCH_WAVE_ONE_MS`). Bounds and the waveOne ≤ window rule are
 * enforced once, at boot, by `buildPolicy`.
 */
export function scheduledWindowFromPolicy(policy: Policy): ScheduledDispatchWindow {
  return {
    waveOneMs: policy.scheduled.dispatchWaveOneMs,
    hardFailMs: policy.scheduled.dispatchWindowMs,
  };
}

/**
 * The moment after which an unanswered scheduled ride stops being retried and
 * ends as `no_driver`: `scheduled_for` + `scheduled.retryCutoffAfterPickupMs`
 * (RCAB-E8.S13). Pure, so the retry transaction and the realtime snapshot agree.
 */
export function scheduledRetryUntil(scheduledFor: Date, cutoffAfterPickupMs: number): Date {
  return new Date(scheduledFor.getTime() + cutoffAfterPickupMs);
}
