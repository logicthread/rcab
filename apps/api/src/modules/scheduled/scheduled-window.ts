import { getNumber, type ConfigReader } from '../../common/utils/env';

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
export const SCHEDULED_DISPATCH_WINDOW_MS_DEFAULT = 4 * 60 * 1000; // 240 s

export interface ScheduledDispatchWindow {
  /** Delay before wave 2 is offered (from wave 1). */
  waveOneMs: number;
  /** Delay before the window closes and the ride is retried (from wave 1). */
  hardFailMs: number;
}

/**
 * Read and validate the scheduled window from config. Throws
 * `InvalidConfigError` (at boot, via the constructors that call this) on a
 * non-numeric, non-integer or non-positive value, or a wave-1 delay longer than
 * the window.
 */
export function scheduledWindowFromConfig(config: ConfigReader): ScheduledDispatchWindow {
  const hardFailMs = getNumber(
    config,
    'SCHEDULED_DISPATCH_WINDOW_MS',
    SCHEDULED_DISPATCH_WINDOW_MS_DEFAULT,
    { integer: true, min: 1 },
  );
  const waveOneMs = getNumber(
    config,
    'SCHEDULED_DISPATCH_WAVE_ONE_MS',
    Math.floor(hardFailMs / 2),
    { integer: true, min: 1, max: hardFailMs },
  );
  return { waveOneMs, hardFailMs };
}
