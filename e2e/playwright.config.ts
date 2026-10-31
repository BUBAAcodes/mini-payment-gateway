import { defineConfig, devices } from '@playwright/test';

// The full flow in a real browser against the Docker stack (section 15, end-to-end).
// global-setup.ts builds and starts the stack; run with `pnpm test:e2e` from the repo root.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // Every spec pays as the one seeded merchant, and the dashboard checks read its data.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // A payment waits on the bank (~1 s), the redirect (3 s) and a webhook (2 s polling).
  timeout: 90_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
