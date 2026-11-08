import { describe, it, expect } from 'vitest';
import { scheduledWindowFromPolicy } from './scheduled-window';
import { buildPolicy } from '../../config/policy/policy';

const cfg = (o: Record<string, unknown> = {}) => ({ get: (k: string) => o[k] });
const scheduledWindowFromConfig = (c: ReturnType<typeof cfg>) => scheduledWindowFromPolicy(buildPolicy(c));

describe('scheduledWindowFromPolicy', () => {
  it('defaults to the four-minute window the feature note specifies, wave 2 at half', () => {
    expect(scheduledWindowFromConfig(cfg())).toEqual({ hardFailMs: 240_000, waveOneMs: 120_000 });
  });

  it('parses string env values and derives wave 2 from the window when unset', () => {
    expect(scheduledWindowFromConfig(cfg({ SCHEDULED_DISPATCH_WINDOW_MS: '60000' }))).toEqual({
      hardFailMs: 60_000,
      waveOneMs: 30_000,
    });
    expect(
      scheduledWindowFromConfig(
        cfg({ SCHEDULED_DISPATCH_WINDOW_MS: '60000', SCHEDULED_DISPATCH_WAVE_ONE_MS: '10000' }),
      ),
    ).toEqual({ hardFailMs: 60_000, waveOneMs: 10_000 });
  });

  it.each([
    [{ SCHEDULED_DISPATCH_WINDOW_MS: 'abc' }],
    [{ SCHEDULED_DISPATCH_WINDOW_MS: '' }],
    [{ SCHEDULED_DISPATCH_WINDOW_MS: '0' }],
    [{ SCHEDULED_DISPATCH_WINDOW_MS: '1.5' }],
    [{ SCHEDULED_DISPATCH_WINDOW_MS: '1000', SCHEDULED_DISPATCH_WAVE_ONE_MS: '1001' }],
    [{ SCHEDULED_DISPATCH_WAVE_ONE_MS: '0' }],
  ])('rejects invalid config %j', (o) => {
    expect(() => scheduledWindowFromConfig(cfg(o))).toThrow(/SCHEDULED_DISPATCH/);
  });
});
