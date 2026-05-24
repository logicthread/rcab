import { describe, it, expectTypeOf } from 'vitest';
import type { Health } from './index';

describe('api-client', () => {
  it('re-exports Health from @rcab/shared', () => {
    expectTypeOf<Health>().toMatchTypeOf<{ ok: boolean }>();
  });
});
