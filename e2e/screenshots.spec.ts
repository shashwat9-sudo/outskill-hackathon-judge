import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

/**
 * Visual review capture.
 *
 * Not an assertion suite — it drives the product to each key surface and saves
 * a desktop and a mobile screenshot for human review. Run with:
 *
 *   DEMO_MODE=1 npx playwright test e2e/screenshots.spec.ts
 *
 * Output: test-results/ux-review/
 */

const OUT = 'test-results/ux-review';
const DESKTOP = { width: 1440, height: 960 };
const MOBILE = { width: 390, height: 844 };

const USERNAME = 'outskill-admin';
const PASSWORD = 'demo-admin-password';

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true });
});

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(300); // let transitions settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function signIn(page: Page) {
  await page.goto('/admin/login');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

async function portalHref(page: Page, scenario: string): Promise<string> {
  await page.goto('/');
  const href = await page
    .locator(`[data-testid="demo-scenario-card"][data-scenario="${scenario}"]`)
    .getByRole('link', { name: 'Open learner portal' })
    .getAttribute('href');
  return href as string;
}

for (const [device, viewport] of [
  ['desktop', DESKTOP],
  ['mobile', MOBILE],
] as const) {
  test.describe(`${device} screenshots`, () => {
    test.use({ viewport });

    test(`captures every key surface (${device})`, async ({ page }) => {
      // --- Demo home ---
      await page.goto('/');
      await expect(page.getByTestId('demo-scenario-card').first()).toBeVisible();
      await shoot(page, `${device}-01-demo-home`);

      // --- Learner: welcome / step 1 ---
      const draft = await portalHref(page, 'incomplete');
      await page.goto(draft);
      await expect(page.getByTestId('submission-stepper').first()).toBeVisible();
      await shoot(page, `${device}-02-learner-welcome`);

      // --- Learner: a form step with cards (product idea) ---
      await page.getByTestId('submission-stepper').first().getByRole('button').nth(1).click();
      await expect(page.getByTestId('idea-cards')).toBeVisible();
      await shoot(page, `${device}-03-learner-step`);

      // --- Learner: review ---
      await page.getByTestId('submission-stepper').first().getByRole('button').nth(5).click();
      await expect(page.getByText('This locks your submission')).toBeVisible();
      await shoot(page, `${device}-04-learner-review`);

      // --- Learner: receipt ---
      await page.goto(await portalHref(page, 'complete'));
      await expect(page.getByTestId('submission-receipt')).toBeVisible();
      await shoot(page, `${device}-05-learner-receipt`);

      // --- Admin ---
      await signIn(page);
      await expect(page.getByTestId('cohort-checklist')).toBeVisible();
      await shoot(page, `${device}-06-admin-overview`);

      const dismiss = page.getByRole('button', { name: 'Dismiss' });
      if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

      await page.goto('/admin/cohorts');
      await expect(page.getByRole('heading', { name: 'Cohorts', level: 1 })).toBeVisible();
      await shoot(page, `${device}-07-cohorts`);

      await page.goto('/admin/assessment-queue');
      await expect(page.getByRole('heading', { name: 'Judging progress' })).toBeVisible();
      await shoot(page, `${device}-08-judging`);

      await page.goto('/admin/ranking');
      await expect(page.getByRole('heading', { name: 'Private shortlist' })).toBeVisible();
      await shoot(page, `${device}-09-shortlist`);

      await page.goto('/admin/final-selection');
      await expect(page.getByRole('heading', { name: 'Select the final four' })).toBeVisible();
      await shoot(page, `${device}-10-finalists`);

      await page.goto('/admin/resources');
      await expect(page.getByRole('heading', { name: 'Resources', level: 1 })).toBeVisible();
      await shoot(page, `${device}-11-resources`);

      await page.goto('/admin/settings');
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      await shoot(page, `${device}-12-settings`);

      // --- Submission evidence, the densest admin surface ---
      await page.goto('/admin/submissions');
      await page.getByRole('link', { name: '12', exact: true }).click();
      await page.getByRole('tab', { name: 'Scores' }).click();
      await expect(page.getByText(/Total \d+/)).toBeVisible();
      await shoot(page, `${device}-13-submission-scores`);
    });
  });
}
