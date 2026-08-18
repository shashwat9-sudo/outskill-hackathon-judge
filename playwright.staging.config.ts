import { defineConfig, devices } from '@playwright/test';

/**
 * The staging suite.
 *
 * Drives the deployed HTTPS build. It starts no server — the server is Vercel —
 * and it holds no credentials of its own: the two synthetic access codes are
 * read from the operator's CSV at run time.
 *
 * Serial, because the two staging teams share one cohort and the tests change
 * a draft. Retries are zero on purpose: this suite exists partly to measure how
 * often sign-in fails (F-17), and a retry would hide exactly the thing being
 * counted.
 *
 *   npm run test:staging
 */
export default defineConfig({
  testDir: './e2e-staging',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results/.staging',
  timeout: 120_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL: process.env.STAGING_BASE_URL ?? 'https://outskill-hackathon-judge.vercel.app',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A cold serverless start plus a pooled connection to another region is
    // slower than anything local, and timing out on that would be a false
    // failure about the network rather than a finding about the product.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
