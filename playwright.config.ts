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
    /**
     * A hermetic server.
     *
     * Every variable the application reads from `.env.local` is neutralised
     * here, because Next.js loads that file for `next start` too. A developer
     * with real credentials on disk was otherwise running the end-to-end suite
     * against a server holding production seeds — which is how the admin tests
     * started failing to sign in: `ADMIN_SEED_USERNAME` was set, so the demo
     * fallback the tests rely on never applied.
     *
     * Empty strings rather than deletions: Next only fills a key that is
     * `undefined`, so an empty value is what actually blocks the file from
     * being read back in.
     */
    env: {
      DEMO_MODE: '1',
      NODE_ENV: 'production',
      // Demo credentials must win, so the seeds have to be absent.
      ADMIN_SEED_USERNAME: '',
      ADMIN_SEED_PASSWORD: '',
      // Nothing real may be reachable from a test run.
      DATABASE_URL: '',
      SUPABASE_URL: '',
      SUPABASE_SECRET_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      AI_API_KEY: '',
      AI_PROVIDER: 'demo',
      APP_BASE_URL: `http://127.0.0.1:${PORT}`,
    },
  },
});
