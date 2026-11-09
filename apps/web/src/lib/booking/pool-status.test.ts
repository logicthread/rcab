import { describe, expect, it } from 'vitest';
import { POOL_STATUS_LABEL, poolStatusLabel } from './pool-status';
import type { PoolStatus } from './types';

describe('poolStatusLabel', () => {
  it('has rider-facing copy for every pool status and never leaks the enum', () => {
    const all: PoolStatus[] = ['open', 'closed_full', 'closed_timeout', 'closed_started', 'completed', 'aborted'];
    for (const s of all) {
      expect(POOL_STATUS_LABEL[s]).toBeTruthy();
      expect(poolStatusLabel(s)).not.toMatch(/_/);
    }
  });

  it('falls back for a pending pool and passes an unknown future status through', () => {
    expect(poolStatusLabel(null)).toBe('Setting up your pool');
    expect(poolStatusLabel('brand_new' as PoolStatus)).toBe('brand_new');
  });
});
