import { describe, it, expect } from 'vitest';
import type { Health } from '@rcab/shared';

describe('web app scaffold', () => {
  it('imports Health from @rcab/shared', () => {
    const h: Health = { ok: true };
    expect(h.ok).toBe(true);
  });
});
