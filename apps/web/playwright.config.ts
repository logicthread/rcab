import { defineConfig, devices } from '@playwright/test';

// e2e runs against the dockerized dev stack (web :3002 + api :3000). Bring it up
// with `pnpm dev:up` first (CI does this before `pnpm test:e2e`). We intentionally
// do NOT use Playwright's `webServer` — the app is a compose service, not a
// process Playwright should own.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
