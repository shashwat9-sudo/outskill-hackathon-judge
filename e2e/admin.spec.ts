import { expect, test, type Page } from '@playwright/test';

/**
 * Admin journey.
 *
 * Exercises the paths an operator actually uses: understand the cohort, work
 * the checklist, review evidence, shortlist, choose the winners.
 */

const USERNAME = 'outskill-admin';
const PASSWORD = 'demo-admin-password';

function adminNav(page: Page) {
  return page.getByRole('navigation', { name: 'Admin sections' }).first();
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  // The onboarding panel overlays the page on first run; dismiss it once.
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

test.describe('admin access', () => {
  test('rejects a wrong password without confirming the username', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill('wrong-password-entirely');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Incorrect username or password.')).toBeVisible();

    await page.getByLabel('Username').fill('not-a-real-admin');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Incorrect username or password.')).toBeVisible();
  });

  test('signs out and loses access', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Sign out' }).first().click();
    await expect(page).toHaveURL(/\/admin\/login/);

    await page.goto('/admin/ranking');
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});

test.describe('admin navigation', () => {
  test('uses operator language, not developer language', async ({ page }) => {
    await signIn(page);
    const nav = adminNav(page);

    for (const label of [
      'Overview',
      'Cohorts',
      'Submissions',
      'Judging',
      'Shortlist',
      'Finalists',
      'Resources',
      'Settings',
    ]) {
      await expect(nav.getByRole('link', { name: label })).toHaveCount(1);
    }

    // The vague labels are gone.
    await expect(nav.getByRole('link', { name: 'Queue' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Ranking' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Final four' })).toHaveCount(0);
  });

  test('marks the active section', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Shortlist' }).click();
    await expect(adminNav(page).getByRole('link', { name: 'Shortlist' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

test.describe('admin overview', () => {
  test('shows the onboarding panel on first visit, and remembers dismissal', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    const panel = page.getByTestId('onboarding-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Welcome to Hackathon Judge')).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Start setup' })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Preview learner journey' })).toBeVisible();

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(panel).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('onboarding-panel')).toHaveCount(0);
  });

  test('shows the run-this-cohort checklist with states', async ({ page }) => {
    await signIn(page);

    const checklist = page.getByTestId('cohort-checklist');
    await expect(checklist).toBeVisible();

    for (const step of [
      'Configure cohort',
      'Review approved ideas',
      'Import learners and issue access codes',
      'Open submissions',
      'Close submissions and start judging',
      'Review the top 10',
      'Select 3 winners',
    ]) {
      await expect(checklist.getByText(step)).toBeVisible();
    }

    // Exactly one step is the thing to do next.
    await expect(checklist.getByText('Do this next')).toHaveCount(1);
  });

  test('shows metric cards and an attention list', async ({ page }) => {
    await signIn(page);

    for (const label of ['Teams invited', 'Drafts', 'Final submissions', 'Needs attention']) {
      await expect(page.getByText(label).first()).toBeVisible();
    }
    await expect(page.getByTestId('attention-required')).toBeVisible();
  });

  test('recommends an action matching the cohort status', async ({ page }) => {
    await signIn(page);
    // The demo cohort is open, so the recommendation is about closing/judging.
    await expect(page.getByText(/until submissions close/)).toBeVisible();
    await expect(page.getByText('Next:')).toBeVisible();
  });

  test('does not show an expired deadline warning', async ({ page }) => {
    await signIn(page);
    await expect(page.getByText(/deadline has passed/i)).toHaveCount(0);
  });
});

test.describe('cohorts', () => {
  test('lists cohorts as cards with status and counts', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Cohorts' }).click();

    await expect(page.getByRole('heading', { name: 'Cohorts', level: 1 })).toBeVisible();
    await expect(page.getByText('Teams invited').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage cohort' }).first()).toBeVisible();
  });

  test('creates a cohort through a guided three-step flow', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Cohorts' }).click();

    await page.getByRole('button', { name: '+ Create cohort' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a cohort' });
    await expect(dialog).toBeVisible();

    // Step 1 — Basics
    await expect(dialog.getByText('Basics')).toBeVisible();
    await dialog.getByLabel('Name').fill('E2E Cohort');
    await dialog.getByLabel('Code').fill('E2E1');
    await dialog.getByRole('button', { name: 'Continue' }).click();

    // Step 2 — Schedule
    await expect(dialog.getByLabel('Day 12 start')).toBeVisible();
    await dialog.getByLabel('Day 12 start').fill('2030-06-01T09:00');
    await dialog.getByLabel('Day 13 deadline').fill('2030-06-02T23:59');
    await dialog.getByRole('button', { name: 'Continue' }).click();

    // Step 3 — Review, showing what is inherited
    await expect(dialog.getByText('What this cohort inherits')).toBeVisible();
    await expect(dialog.getByText('E2E Cohort')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create cohort' })).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('explains the effect of each lifecycle change', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Cohorts' }).click();

    // Reversible transitions live on the lifecycle card...
    await expect(
      page.getByText('Learners can view their entries but cannot edit or submit.'),
    ).toBeVisible();

    // ...while closing and reopening have their own panel, because neither is a
    // status change to the person pressing it.
    await expect(page.getByTestId('closure-controls').first()).toBeVisible();
    await expect(
      page.getByText('Every team loses the ability to edit or submit the moment you press this.'),
    ).toBeVisible();
  });
});

test.describe('judging progress', () => {
  test('is titled for operators and shows the pipeline', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Judging' }).click();

    await expect(page.getByRole('heading', { name: 'Judging progress', level: 1 })).toBeVisible();
    await expect(
      page.getByText(/Track automated product testing, evidence review and cases/),
    ).toBeVisible();

    for (const phase of ['Submitted', 'Pre-flight', 'Browser testing', 'Scoring', 'Completed']) {
      await expect(page.getByText(phase, { exact: true })).toBeVisible();
    }
  });

  test('puts needs-attention before technical consumption detail', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/assessment-queue');

    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();

    // Usage figures are collapsed by default — present in the DOM but hidden.
    const usage = page.getByTestId('usage-details');
    await expect(usage).not.toHaveAttribute('open', /.*/);
    await expect(page.getByText('Browser testing time used')).toBeHidden();

    await usage.locator('summary').click();
    await expect(page.getByText('Browser testing time used')).toBeVisible();
  });

  test('explains the average duration against the browser-testing limit', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/assessment-queue');
    await page.getByTestId('usage-details').locator('summary').click();

    await expect(page.getByText(/applies only to the browser-testing/)).toBeVisible();
    await expect(page.getByText(/8 minutes per submission/)).toBeVisible();
  });

  test('never shows raw millisecond values', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/assessment-queue');
    await page.getByTestId('usage-details').locator('summary').click();

    const body = await page.textContent('body');
    expect(body).not.toContain('480000');
    expect(body).not.toContain('browserBudgetMs');
  });
});

test.describe('shortlist', () => {
  test('is labelled private and never uses winner language', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Shortlist' }).click();

    await expect(page.getByRole('heading', { name: 'Private shortlist', level: 1 })).toBeVisible();
    await expect(page.getByText('Private — never visible to participants')).toBeVisible();

    const body = (await page.textContent('body')) ?? '';
    expect(body.toLowerCase()).not.toContain('winner');
  });

  test('shows the top entries with score, confidence, breakdown and evidence link', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/ranking');

    const entries = page.getByTestId('shortlist-entries');
    await expect(entries).toBeVisible();
    await expect(entries.getByRole('link', { name: 'Review evidence' }).first()).toBeVisible();
    // Rubric v2 names the category "Working core experience".
    await expect(entries.getByText('Working core experience').first()).toBeVisible();
    await expect(entries.getByText(/confidence \d/).first()).toBeVisible();
  });

  test('keeps the full ranking available but secondary', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/ranking');
    await expect(page.getByText(/Full eligible ranking/)).toBeVisible();
  });
});

test.describe('finalists', () => {
  test('uses the required title and explains who decides', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Finalists' }).click();

    await expect(page.getByRole('heading', { name: 'Final selection', level: 1 })).toBeVisible();
    await expect(
      page.getByText(/The automated judge provides evidence and a private shortlist/),
    ).toBeVisible();
  });

  test('shows one numbered slot per configured winner, none pre-filled by the system', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/final-selection');

    await expect(page.getByTestId('finalist-slots')).toBeVisible();
    for (const position of [1, 2, 3]) {
      await expect(page.getByTestId(`finalist-slot-${position}`)).toBeVisible();
    }
    await expect(page.getByText('0 of 3 selected')).toBeVisible();
    await expect(page.getByTestId('finalist-slot-4')).toHaveCount(0);
  });

  test('refuses a selection that is not exactly the cohort target', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/final-selection');

    await page.getByLabel('Submission').first().selectOption({ index: 1 });
    await page.getByLabel('Internal note').first().fill('Strongest working product.');

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Confirm final selection' }).click();

    await expect(page.getByText(/Choose a submission for all 3 positions/)).toBeVisible();
  });
});

test.describe('resources', () => {
  test('shows downloadable cards grouped by audience', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Resources' }).click();

    await expect(page.getByRole('heading', { name: 'Participant resources' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Admin resources' })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Official pitch-deck template' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Admin operating playbook' })).toBeVisible();

    // Each card carries purpose, file type, size and an action.
    await expect(page.getByText(/PowerPoint · /).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download' }).first()).toBeVisible();
  });

  test('does not lead with storage implementation detail', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/resources');

    const body = (await page.textContent('body')) ?? '';
    for (const internal of ['browser-evidence', 'submission-decks', 'traces', 'storage.objects']) {
      expect(body, `resources page leads with "${internal}"`).not.toContain(internal);
    }
  });
});

test.describe('settings', () => {
  test('separates access, judging, retention and diagnostics', async ({ page }) => {
    await signIn(page);
    await adminNav(page).getByRole('link', { name: 'Settings' }).click();

    await expect(page.getByRole('heading', { name: 'Admin access' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Judging configuration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Retention and privacy' })).toBeVisible();
    await expect(page.getByTestId('advanced-settings')).toBeVisible();
    await expect(page.getByTestId('system-diagnostics')).toBeVisible();
  });

  test('shows judging settings in minutes and counts, never milliseconds', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/settings');

    await expect(page.getByLabel('Concurrent assessments')).toHaveValue('4');
    await expect(page.getByLabel('Maximum browser-testing time')).toHaveValue('8');
    await expect(page.getByLabel('Maximum retries')).toHaveValue('3');
    await expect(page.getByLabel('Top shortlist size')).toHaveValue('10');

    // The raw value is not in the operator-facing controls.
    const judgingCard = page.locator('section, div').filter({ hasText: 'Judging configuration' }).first();
    expect(await judgingCard.textContent()).not.toContain('480000');
  });

  test('keeps the raw values available under Advanced', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/settings');

    await page.getByTestId('advanced-settings').locator('summary').click();
    await expect(page.getByText('worker.browserBudgetMs')).toBeVisible();
    await expect(page.getByText('worker.concurrency')).toBeVisible();
  });

  test('moves storage diagnostics into System diagnostics', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/settings');

    await page.getByTestId('system-diagnostics').locator('summary').click();
    await expect(page.getByRole('heading', { name: 'Storage diagnostics' })).toBeVisible();
    await expect(page.getByText('browser-evidence')).toBeVisible();
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
});

test.describe('submission evidence', () => {
  test('shows the full evidence trail', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/submissions');
    await page.getByRole('link', { name: '12', exact: true }).click();

    await expect(page.getByRole('heading', { name: /Group 12/ })).toBeVisible();

    await page.getByRole('tab', { name: 'Preflight' }).click();
    await expect(page.getByRole('heading', { name: 'Preflight checks' })).toBeVisible();

    await page.getByRole('tab', { name: 'Browser evidence' }).click();
    await expect(page.getByRole('heading', { name: 'desktop run' })).toBeVisible();

    await page.getByRole('tab', { name: 'Scores' }).click();
    await expect(page.getByText(/Total \d+/)).toBeVisible();
    await expect(page.getByText('Supporting').first()).toBeVisible();
  });

  test('flags a low-confidence submission and states the video limitation', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/submissions');
    await page.getByRole('link', { name: '61', exact: true }).click();

    await expect(page.getByText('low confidence')).toBeVisible();
    await page.getByRole('tab', { name: 'Artifacts' }).click();
    await expect(page.getByText('Video could not be analysed')).toBeVisible();
  });

  test('requires a reason to override a score', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/submissions');
    await page.getByRole('link', { name: '12', exact: true }).click();
    await page.getByRole('tab', { name: 'Scores' }).click();

    await page.getByText('Override this score').first().click();
    const form = page.locator('details[open]').first();
    await form.getByLabel(/Reason/).fill('Reviewer confirmed the flow manually during review.');
    await form.getByRole('button', { name: 'Override' }).click();

    await expect(page.getByText(/overridden/i).first()).toBeVisible();
  });
});
