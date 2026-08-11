import { defineConfig, devices } from '@playwright/test';

const PORT = 3399;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Shared in-memory fixture state — serial keeps runs honest.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : [['list']],
  // Playwright empties its output directory before every run. Point it at a
  // subfolder so the UX review screenshots in test-results/ux-review survive.
  outputDir: './test-results/.playwright',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: `npm run build && DEMO_MODE=1 npx next start apps/web -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { DEMO_MODE: '1', NODE_ENV: 'production' },
  },
});
