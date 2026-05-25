import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.int.spec.ts'],
    globalSetup: ['test/setup.int.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Containers start serially; no benefit from parallelism here.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
