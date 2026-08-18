import { defineConfig, devices } from '@playwright/test';

/**
 * The acceptance suite.
 *
 * Separate from `playwright.config.ts` because it tests a different thing. That
 * suite runs against a hermetic demo server with fixture data; this one drives
 * the **real acceptance server** — real Postgres, real Supabase Storage, real
 * access codes — to prove the product works against the infrastructure it will
 * actually run on.
 *
 * It therefore does NOT start a server. The acceptance server is long-running
 * and holds the state under test; starting another would either collide on the
 * port or, worse, build into the same directory and pull the running server's
 * module graph out from under it.
 *
 *   npm run test:acceptance
 *
 * Serial by necessity: the tests share one cohort and one submission, and they
 * change cohort status. Running them in parallel would have one test pausing
 * the cohort while another tries to save.
 */
export default defineConfig({
  testDir: './e2e-acceptance',
  // Compiles the dev-server routes before any test measures anything.
  globalSetup: './e2e-acceptance/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results/.acceptance',
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: process.env.ACCEPTANCE_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The acceptance server runs `next dev`, which is slower to respond than a
    // production build on first hit of a route.
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
