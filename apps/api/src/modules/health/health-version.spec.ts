import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('GET /v1/health/version', () => {
  const saved = { v: process.env.RCAB_VERSION, b: process.env.RCAB_BUILT_AT };
  afterEach(() => {
    if (saved.v === undefined) delete process.env.RCAB_VERSION;
    else process.env.RCAB_VERSION = saved.v;
    if (saved.b === undefined) delete process.env.RCAB_BUILT_AT;
    else process.env.RCAB_BUILT_AT = saved.b;
  });

  it('reports the build args baked into the image', () => {
    process.env.RCAB_VERSION = 'abc1234';
    process.env.RCAB_BUILT_AT = '2026-11-08T00:00:00Z';
    const c = new HealthController({} as never);
    expect(c.version()).toEqual({ version: 'abc1234', builtAt: '2026-11-08T00:00:00Z' });
  });

  it('falls back to dev/unknown outside an image build', () => {
    delete process.env.RCAB_VERSION;
    delete process.env.RCAB_BUILT_AT;
    const c = new HealthController({} as never);
    expect(c.version()).toEqual({ version: 'dev', builtAt: 'unknown' });
  });
});
