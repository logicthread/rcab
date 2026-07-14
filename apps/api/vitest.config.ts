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
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
    // app.spec.ts boots the full AppModule. Without these, its BullMQ workers
    // and the socket.io Redis adapter eagerly connect to the compose hostname
    // `redis`, which only resolves inside the compose network — on a bare host
    // the beforeAll hook hangs to timeout. The same seams the integration setup
    // uses (RCAB-E1.S11) keep the unit smoke offline-safe.
    env: {
      RCAB_DISABLE_BULL_AUTORUN: '1',
      RCAB_DISABLE_WS_ADAPTER: '1',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.test.ts',
        'src/main.ts',
        'src/**/*.module.ts',
        'src/**/*.types.ts',
        'src/db/schema.ts',
      ],
      // Floors set just under the measured unit-only baseline (stmts/lines 78.4,
      // branches 88, funcs 73.3) — a regression ratchet, not an aspiration.
      // Raise as integration-uncovered paths get unit tests.
      thresholds: {
        statements: 75,
        branches: 85,
        functions: 70,
        lines: 75,
      },
    },
  },
});
