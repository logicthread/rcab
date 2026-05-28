import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
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
