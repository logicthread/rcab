import { describe, it, expect } from 'vitest';
import type { Health } from './health';

describe('Health', () => {
  it('accepts ok: true', () => {
    const h: Health = { ok: true };
    expect(h.ok).toBe(true);
  });

  it('accepts ok: false', () => {
    const h: Health = { ok: false };
    expect(h.ok).toBe(false);
  });
});
