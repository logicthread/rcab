import type { PoolStatus } from './types';

/** Rider-facing wording for a shared-ride pool status (the raw enum is an API detail, not copy). */
export const POOL_STATUS_LABEL: Record<PoolStatus, string> = {
  open: 'Waiting for a co-rider',
  closed_full: 'Pool is full, finding your driver',
  closed_timeout: 'No co-rider joined, finding your driver',
  closed_started: 'Trip under way',
  completed: 'Trip complete',
  aborted: 'Pool cancelled',
};

export function poolStatusLabel(status: PoolStatus | null | undefined): string {
  return status ? (POOL_STATUS_LABEL[status] ?? status) : 'Setting up your pool';
}
