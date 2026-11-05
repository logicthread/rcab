import { describe, it, expect } from 'vitest';
import { envNumber, getNumber, parseNumberConfig, InvalidConfigError } from './env';

describe('parseNumberConfig', () => {
  it('converts numeric strings to numbers', () => {
    expect(parseNumberConfig('K', '4000', 1)).toBe(4000);
    expect(parseNumberConfig('K', '0.55', 1)).toBe(0.55);
  });

  it('falls back to the default when unset', () => {
    expect(parseNumberConfig('K', undefined, 7)).toBe(7);
    expect(parseNumberConfig('K', null, 7)).toBe(7);
  });

  it('allows zero when range permits', () => {
    expect(parseNumberConfig('K', '0', 5, { min: 0 })).toBe(0);
  });

  it.each(['', '   ', 'abc', 'NaN', 'Infinity', '-Infinity', '1e999'])(
    'rejects invalid value %j',
    (raw) => {
      expect(() => parseNumberConfig('K', raw, 1)).toThrow(InvalidConfigError);
    },
  );

  it('enforces integer and range constraints', () => {
    expect(() => parseNumberConfig('K', '1.5', 1, { integer: true })).toThrow(/integer/);
    expect(() => parseNumberConfig('K', '-1', 1, { min: 0 })).toThrow(/>= 0/);
    expect(() => parseNumberConfig('K', '2', 1, { max: 1 })).toThrow(/<= 1/);
  });

  it('never echoes the raw value in the error', () => {
    let message = '';
    try {
      parseNumberConfig('SECRETISH', 'hunter2', 1);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('SECRETISH');
    expect(message).not.toContain('hunter2');
  });
});

describe('getNumber / envNumber', () => {
  it('reads from a ConfigService-like source', () => {
    expect(getNumber({ get: () => '12' }, 'K', 1)).toBe(12);
    expect(getNumber({ get: () => 12 }, 'K', 1)).toBe(12);
  });

  it('reads from an env object', () => {
    expect(envNumber('PORT', 3000, { integer: true }, { PORT: '8080' })).toBe(8080);
    expect(envNumber('PORT', 3000, { integer: true }, {})).toBe(3000);
  });
});
