import { defineConfig, devices } from '@playwright/test';

/**
 * Demo-recording config (RCAB-E8.S14). NOT part of `pnpm test:e2e` (different testMatch + dir). Run it with
 * `pnpm demo:record:web` (see README.md). Scenes create their own recording contexts (they need per-scene
 * video sizes and, for W07, two contexts), so `video` is controlled in lib/scene.ts, not here.
 */
const SLOW_MO = Number(process.env.DEMO_SLOWMO ?? 200);

export default defineConfig({
  testDir: './scenes',
  testMatch: '**/*.demo.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60_000,
  reporter: 'list',
  outputDir: './out/test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3002',
    headless: true,
    launchOptions: { slowMo: SLOW_MO },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
