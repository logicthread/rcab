import { describe, it, expect } from 'vitest';
import { createIntentKeyTracker } from './intent';

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

describe('createIntentKeyTracker', () => {
  it('reuses one key for repeated submits of the same intent', () => {
    const t = createIntentKeyTracker(counter());
    expect(t.keyFor('private|a|b')).toBe('key-1');
    expect(t.keyFor('private|a|b')).toBe('key-1');
  });

  it('rotates when the intent changes', () => {
    const t = createIntentKeyTracker(counter());
    t.keyFor('private|a|b');
    expect(t.keyFor('private|a|c')).toBe('key-2');
  });

  it('rotates after clear() (confirmed success)', () => {
    const t = createIntentKeyTracker(counter());
    t.keyFor('x');
    t.clear();
    expect(t.keyFor('x')).toBe('key-2');
  });
});

describe('default key format', () => {
  it('satisfies the API Idempotency-Key rule (1-128 visible ASCII, apps/api rides/idempotency.ts)', () => {
    const key = createIntentKeyTracker().keyFor('private|a|b');
    expect(key).toMatch(/^[\x21-\x7e]{1,128}$/);
  });
});
