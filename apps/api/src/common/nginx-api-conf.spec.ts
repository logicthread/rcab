import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Regression: the catch-all `location /` proxied /metrics (Prometheus, internal-only) to the public internet.
describe('nginx api.conf', () => {
  const conf = readFileSync(resolve(__dirname, '../../../../infra/docker/nginx/conf.d/api.conf'), 'utf8');

  it('blocks /metrics before the catch-all proxy', () => {
    const block = conf.match(/location = \/metrics \{([^}]*)\}/);
    expect(block?.[1]).toMatch(/return 404;/);
    expect(conf.indexOf('location = /metrics')).toBeLessThan(conf.indexOf('location / {'));
  });
});
