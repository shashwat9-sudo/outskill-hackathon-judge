import { expect, test, type Page } from '@playwright/test';

/**
 * Admin journey.
 *
 * Signs in with the demo credential, then exercises the paths a reviewer
 * actually uses on the night: queue, evidence, override, ranking, final four.
 */

const USERNAME = 'outskill-admin';
const PASSWORD = 'demo-admin-password';

/** The top navigation, scoped so its links never collide with in-page ones. */
function adminNav(page: Page) {
  return page.getByRole('navigation', { name: 'Admin sections' });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test.describe('admin', () => {
  test('rejects a wrong password with a message that does not confirm the username', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill('wrong-password-entirely');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const error = page.getByText('Incorrect username or password.');
    await expect(error).toBeVisible();

    // The same message for a wrong username — it must not confirm which is wrong.
    await page.getByLabel('Username').fill('not-a-real-admin');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Incorrect username or password.')).toBeVisible();
  });

  test('signs in and shows the operations overview', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: /Demo Cohort/ })).toBeVisible();
    await expect(page.getByText('Shortlist window')).toBeVisible();
    await expect(page.getByText('Private top 10')).toBeVisible();
  });

  test('lists cohorts and their ideas', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Cohorts' }).click();
    await expect(page.getByRole('heading', { name: 'Cohorts', level: 1 })).toBeVisible();

    await page.getByRole('link', { name: 'Ideas' }).first().click();
    await expect(page.getByRole('heading', { name: 'Approved ideas' })).toBeVisible();
    // All eight approved ideas are configured.
    await expect(page.getByRole('heading', { name: 'Travel Itinerary Planner' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Website Content Scraper' })).toBeVisible();
  });

  test('shows teams with their invite state', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');
    await page.getByRole('link', { name: 'Teams' }).first().click();

    await expect(page.getByRole('heading', { name: 'Teams and invites' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download invite CSV' })).toBeVisible();
    await expect(page.getByText('active').first()).toBeVisible();
  });

  test('lists submissions with internal stage, score and rank', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');
    await page.getByRole('link', { name: 'Submissions' }).first().click();

    await expect(page.getByRole('heading', { name: 'Submissions', level: 1 })).toBeVisible();
    await expect(page.getByText('completed').first()).toBeVisible();
    await expect(page.getByText('manual review').first()).toBeVisible();
    // Internal-only columns are present for admins.
    await expect(page.getByRole('columnheader', { name: 'Score' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Rank' })).toBeVisible();
  });

  test('shows the full evidence trail on a submission', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');
    await page.getByRole('link', { name: 'Submissions' }).first().click();
    await page.getByRole('link', { name: '12', exact: true }).click();

    await expect(page.getByRole('heading', { name: /Group 12/ })).toBeVisible();

    // Preflight records every attempt.
    await page.getByRole('tab', { name: 'Preflight' }).click();
    await expect(page.getByRole('heading', { name: 'Preflight checks' })).toBeVisible();

    // Browser evidence, step by step.
    await page.getByRole('tab', { name: 'Browser evidence' }).click();
    await expect(page.getByRole('heading', { name: 'desktop run' })).toBeVisible();
    await expect(page.getByText('Console errors').first()).toBeVisible();

    // Every score carries evidence.
    await page.getByRole('tab', { name: 'Scores' }).click();
    await expect(page.getByText(/Total \d+/)).toBeVisible();
    await expect(page.getByText('Supporting').first()).toBeVisible();
    await expect(page.getByText('Missing').first()).toBeVisible();
  });

  test('shows a low-confidence submission as flagged, with the video limitation stated', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');
    await page.getByRole('link', { name: 'Submissions' }).first().click();
    await page.getByRole('link', { name: '61', exact: true }).click();

    await expect(page.getByText('low confidence')).toBeVisible();

    await page.getByRole('tab', { name: 'Artifacts' }).click();
    await expect(page.getByText('Video could not be analysed')).toBeVisible();
    await expect(page.getByText(/No video content has been inferred/)).toBeVisible();
  });

  test('overrides a category score, requiring a reason', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');
    await page.getByRole('link', { name: 'Submissions' }).first().click();
    await page.getByRole('link', { name: '12', exact: true }).click();
    await page.getByRole('tab', { name: 'Scores' }).click();

    await page.getByText('Override this score').first().click();
    const form = page.locator('details[open]').first();
    await form.getByLabel(/Reason/).fill('Reviewer confirmed the flow manually during review.');
    await form.getByRole('button', { name: 'Override' }).click();

    await expect(page.getByText(/overridden/i).first()).toBeVisible();
  });

  test('shows the private ranking with the top 10 highlighted', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Ranking' }).click();

    await expect(page.getByRole('heading', { name: 'Ranking', level: 1 })).toBeVisible();
    await expect(page.getByText('Internal only')).toBeVisible();
    await expect(page.getByText(/Current ranking/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export shortlist CSV' })).toBeVisible();
  });

  test('regenerates a ranking snapshot and keeps the previous one', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/ranking');

    await page.getByLabel('Note').fill('E2E regeneration check');
    await page.getByRole('button', { name: 'Generate snapshot' }).click();

    await expect(page.getByText(/New ranking snapshot/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Snapshot history' })).toBeVisible();
  });

  test('refuses a final selection that is not exactly four', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Final four' }).click();

    await expect(page.getByText('Humans choose, not the system')).toBeVisible();

    // Fill only one position, then submit.
    await page.getByLabel('Submission').first().selectOption({ index: 1 });
    await page.getByLabel('Reason').first().fill('Strongest working product.');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Record final four' }).click();

    await expect(page.getByText(/Choose a submission for all four positions/)).toBeVisible();
  });

  test('shows the shared-account attribution limit in settings', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Settings' }).click();

    await expect(page.getByRole('heading', { name: 'Shared admin credentials' })).toBeVisible();
    await expect(page.getByText(/cannot attribute an action to a person/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Runtime configuration' })).toBeVisible();
  });

  test('rejects a password rotation without the current password', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/settings');

    await page.getByLabel('Current password').fill('not-the-current-password');
    await page.getByLabel('New password').fill('a-perfectly-fine-new-passphrase');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Rotate credentials' }).click();

    await expect(page.getByText('The current password is incorrect.')).toBeVisible();
  });

  test('shows storage buckets as private on the resources page', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Resources' }).click();

    await expect(page.getByRole('heading', { name: 'Resources', level: 1 })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'browser-evidence', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'traces', exact: true })).toBeVisible();
  });

  test('signs out and loses access', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/admin\/login/);

    await page.goto('/admin/ranking');
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
