import { describe, it, expect } from 'vitest';
import { status } from './main';

describe('api scaffold', () => {
  it('imports Health from @rcab/shared', () => {
    expect(status.ok).toBe(true);
  });
});
