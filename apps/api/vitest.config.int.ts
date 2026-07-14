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
    setupFiles: ['test/setup.unhandled.ts'],
    // BullMQ Worker disposal still emits a single `Connection is closed.`
    // rejection per spec when the blocking client's pending command unwinds
    // post-shutdown. The shutdown itself is correct; only the trailing
    // reject is noise. Don't fail the run on it.
    dangerouslyIgnoreUnhandledErrors: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Containers start serially; no benefit from parallelism here.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
