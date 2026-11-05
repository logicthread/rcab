/**
 * Queue names, job names, deterministic job IDs and job payload shapes that the
 * outbox relay publishes and the workers / reconciler consume (Stage C, R07).
 *
 * This file is deliberately dependency-free. The relay is imported by the rides
 * controller, and the workers import the dispatch service, which imports the
 * rides repository: importing worker modules from the relay would close an ES
 * import cycle. The queue-name constants below therefore mirror the ones owned
 * by their modules (`DISPATCH_QUEUE`, `SCHEDULED_DISPATCH_QUEUE`,
 * `MATCHING_QUEUE`); `outbox.jobs.spec.ts` pins them equal.
 *
 * BullMQ job IDs never contain a colon (contract §1.3 rule 7). The legacy
 * colon-separated IDs of jobs still in flight at deploy time are exposed as
 * `legacy*` helpers so cancellation and reconciliation can address both.
 */

export const DISPATCH_QUEUE_NAME = 'dispatch';
export const SCHEDULED_QUEUE_NAME = 'scheduled-dispatch';
export const MATCHING_QUEUE_NAME = 'matching';

/** Starts dispatch generation `g` of a solo ride or a closed pool. */
export const DISPATCH_START_JOB = 'dispatch:start';
export const SCHEDULED_WAKE_JOB_NAME = 'scheduled:wake';
export const POOL_EXPIRE_JOB_NAME = 'pool:expire';

export type DispatchKind = 'solo' | 'pool';

export interface DispatchStartJobData {
  kind: DispatchKind;
  tripId: string;
  generation: number;
}

export function dispatchStartJobId(tripId: string, generation: number): string {
  return `dispatch-start-${tripId}-g${generation}`;
}

export function wave2JobId(tripId: string, generation: number): string {
  return `dispatch-wave2-${tripId}-g${generation}`;
}

export function hardFailJobId(tripId: string, generation: number): string {
  return `dispatch-hardfail-${tripId}-g${generation}`;
}

export function scheduledWakeJobId(rideId: string, generation: number): string {
  return `scheduled-wake-${rideId}-g${generation}`;
}

export function poolExpireJobId(poolId: string): string {
  return `pool-expire-${poolId}`;
}

export const legacyWave2JobId = (tripId: string): string => `dispatch:wave2-timeout:${tripId}`;
export const legacyHardFailJobId = (tripId: string): string => `dispatch:hard-fail:${tripId}`;
export const legacyWakeJobId = (rideId: string): string => `scheduled:wake:${rideId}`;
export const legacyPoolExpireJobId = (poolId: string): string => `pool:expire:${poolId}`;
