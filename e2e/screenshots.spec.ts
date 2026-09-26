import { expect, test, type Page } from '@playwright/test';
import { dismissTour, openScenario } from './learner-support';
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

/** On a phone the six steps are folded behind a toggle; on a laptop they are not. */
async function openSteps(page: Page) {
  const toggle = page.getByTestId('toggle-steps');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
}

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
      // The step list is folded away on a phone, so the progress line is what
      // is on screen at both sizes.
      await openScenario(page, 'incomplete');
      await expect(page.getByTestId('percent-complete')).toBeVisible();
      await shoot(page, `${device}-02-learner-welcome`);

      // --- Learner: the help menu and the first-run tour ---
      await page.getByTestId('need-help').click();
      await expect(page.getByTestId('help-menu')).toBeVisible();
      await shoot(page, `${device}-02b-learner-help-menu`);
      await page.getByTestId('help-replay-tour').click();
      await expect(page.getByTestId('submission-walkthrough')).toBeVisible();
      await shoot(page, `${device}-02c-learner-tour`);
      await dismissTour(page);

      // --- Learner: a form step with cards (product idea) ---
      await openSteps(page);
      await page.getByTestId('submission-stepper').first().getByRole('button').nth(1).click();
      await expect(page.getByTestId('idea-cards')).toBeVisible();
      await shoot(page, `${device}-03-learner-step`);

      // --- Learner: a question explaining itself ---
      await page.getByTestId('see-example-exactProblem').click();
      await expect(page.getByTestId('example-exactProblem')).toBeVisible();
      await shoot(page, `${device}-03b-learner-field-example`);

      // --- Learner: review ---
      await openSteps(page);
      await page.getByTestId('submission-stepper').first().getByRole('button').nth(5).click();
      await expect(page.getByText('Before you submit')).toBeVisible();
      await shoot(page, `${device}-04-learner-review`);

      // --- Learner: the completed example ---
      await page.goto('/submit/example');
      await expect(page.getByTestId('example-banner')).toBeVisible();
      await shoot(page, `${device}-04b-learner-completed-example`);

      // --- Learner: receipt ---
      await openScenario(page, 'complete');
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
      await expect(page.getByRole('heading', { name: 'Final selection' })).toBeVisible();
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
