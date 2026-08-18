import { expect, test, type Page } from '@playwright/test';

/**
 * Hackathon-day operations.
 *
 * The surfaces an operator reaches for under time pressure: issuing access
 * codes, clearing a lockout, closing the window, reopening it, and answering
 * "my receipt says…". Plus the guide, which is the thing five hundred learners
 * read at once.
 */

const USERNAME = 'outskill-admin';
const PASSWORD = 'demo-admin-password';

/**
 * Accept the next `window.confirm`.
 *
 * Playwright dismisses dialogs by default, which silently cancels any admin
 * action guarded by a confirmation — the click appears to do nothing.
 */
async function acceptConfirm(page: Page): Promise<void> {
  page.once('dialog', (dialog) => void dialog.accept());
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
}

async function openTeamsPage(page: Page): Promise<void> {
  await signIn(page);
  await page.goto('/admin/cohorts');
  await page.getByRole('link', { name: 'Teams and invites' }).first().click();
  await expect(page.getByRole('heading', { name: 'Teams and access' })).toBeVisible();
}

test.describe('the two-day guide', () => {
  test('is readable without signing in', async ({ page }) => {
    // A team looking this up at 2am should not need their access code first.
    await page.goto('/submit/guide');
    await expect(page.getByRole('heading', { name: /Your two days/ })).toBeVisible();
  });

  test('covers every stage, with a contents list', async ({ page }) => {
    await page.goto('/submit/guide');
    for (const heading of [
      'What the two days look like',
      'Your live product',
      'Your pitch deck',
      'Your demo video',
      'What you learned',
      'Submitting',
      'If something goes wrong',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  });

  test('downloads as a real PDF', async ({ page }) => {
    const response = await page.request.get('/api/guide');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/pdf');

    const body = await response.body();
    expect(body.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    expect(body.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
  });

  test('says nothing about scores, rank or shortlists', async ({ page }) => {
    await page.goto('/submit/guide');
    const html = await page.content();
    for (const forbidden of ['Shortlist', 'Finalist', 'Top 10', 'Rubric', 'Rank']) {
      expect(html, `guide mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('is reachable from the entry page', async ({ page }) => {
    await page.goto('/submit');
    await page.getByTestId('guide-link').click();
    await expect(page).toHaveURL(/\/submit\/guide$/);
  });
});

test.describe('access codes', () => {
  test('shows how many teams can actually get in', async ({ page }) => {
    await openTeamsPage(page);
    const panel = page.getByTestId('access-codes');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Teams with a live code')).toBeVisible();
    await expect(panel.getByText('Waiting for a code')).toBeVisible();
  });

  test('never displays a code, only its state', async ({ page }) => {
    await openTeamsPage(page);
    // Codes are 12 characters from a fixed alphabet. If one were rendered
    // anywhere on this page, this would find it.
    const html = await page.content();
    expect(html).not.toMatch(/\b[ABCDEFGHJKMNPQRSTVWXYZ23456789]{12}\b/);
    expect(html).not.toMatch(
      /\b[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}\b/,
    );
  });

  test('issues codes and downloads the sheet as one action', async ({ page }) => {
    // They cannot be separate buttons: plaintext exists only while a code is
    // being generated, so an "issue" that produced no file would create codes
    // no team could ever be told. The previous design's only download reissued
    // every code in the cohort, which meant codes for five newly imported teams
    // could not be distributed without invalidating the other ninety-five.
    await openTeamsPage(page);

    await expect(
      page.getByRole('heading', { name: 'Issue codes for teams that have none' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Issue .*and download/ })).toBeVisible();

    // Rotation is a separate, explicitly destructive control.
    await expect(page.getByRole('heading', { name: 'Replace every code' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Replace all .* and download/ })).toBeVisible();

    // And there is no standalone download that would silently rotate them.
    await expect(page.getByRole('button', { name: /^Download access codes$/ })).toHaveCount(0);
  });

  test('offers a lockout clear, because a locked-out team cannot wait', async ({ page }) => {
    await openTeamsPage(page);
    await expect(page.getByRole('heading', { name: 'Clear a lockout' })).toBeVisible();
    await page.getByLabel('Group number').fill('27');
    await acceptConfirm(page);
    await page.getByRole('button', { name: 'Clear lockout' }).click();
    await expect(page.getByText(/Group 27 can try again straight away/)).toBeVisible();
  });

  test('names the common submission URL an operator has to paste into Circle', async ({ page }) => {
    await openTeamsPage(page);
    await expect(page.getByText(/Put that link in Circle yourself/)).toBeVisible();
    // And states that there is no integration, so nobody goes looking for one.
    await expect(page.getByText(/no Circle integration/)).toBeVisible();
  });
});

test.describe('closing and reopening', () => {
  test('requires the confirmation to be typed exactly', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');

    const form = page.getByTestId('close-submissions-form').first();
    const button = form.getByRole('button', { name: 'Close submissions' });
    await expect(button).toBeDisabled();

    await form.getByLabel(/Type CLOSE SUBMISSIONS/).fill('close submissions');
    await expect(button).toBeDisabled();

    await form.getByLabel(/Type CLOSE SUBMISSIONS/).fill('CLOSE SUBMISSIONS');
    await expect(button).toBeEnabled();
  });

  test('explains that the deadline is enforced without a scheduler', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');
    await expect(
      page.getByText(/enforced on every save, not by a scheduled job/).first(),
    ).toBeVisible();
  });

  test('closes, then reopens with an acceptance window', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');

    const closeForm = page.getByTestId('close-submissions-form').first();
    await closeForm.getByLabel(/Type CLOSE SUBMISSIONS/).fill('CLOSE SUBMISSIONS');
    await closeForm.getByRole('button', { name: 'Close submissions' }).click();
    await expect(page.getByTestId('closure-result').first()).toContainText(/Submissions are closed/);

    // A learner arriving now is told plainly, before typing a code.
    const learner = await page.context().newPage();
    await learner.goto('/submit');
    await expect(learner.getByTestId('window-notice')).toContainText(/closed/i);
    await learner.close();

    await page.reload();
    const reopenForm = page.getByTestId('reopen-submissions-form').first();
    await reopenForm.getByLabel(/Why are you reopening/).fill('Platform outage during the final hour');
    await reopenForm.getByRole('button', { name: 'Reopen submissions' }).click();
    await expect(page.getByTestId('closure-result').first()).toContainText(/Submissions are open again/);

    const returning = await page.context().newPage();
    await returning.goto('/submit');
    await expect(returning.getByTestId('window-notice')).toContainText(/Submissions close/);
    await returning.close();
  });

  test('refuses a reopen with no reason', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');

    // Pause first, so the reopen form is available without closing the cohort.
    await acceptConfirm(page);
    await page.getByRole('button', { name: 'Pause submissions' }).first().click();
    await expect(page.getByText(/Cohort is now paused/)).toBeVisible();

    await page.reload();
    const form = page.getByTestId('reopen-submissions-form').first();
    await form.getByLabel(/Why are you reopening/).fill('x');
    await form.getByRole('button', { name: 'Reopen submissions' }).click();
    await expect(page.getByTestId('closure-result').first()).toContainText(/Give a reason for reopening/);

    // Restore the cohort for the specs that follow.
    await form.getByLabel(/Why are you reopening/).fill('Restoring after a test');
    await form.getByRole('button', { name: 'Reopen submissions' }).click();
    await expect(page.getByTestId('closure-result').first()).toContainText(/Submissions are open again/);
  });
});

test.describe('receipt lookup', () => {
  test('finds a submission by the ID a learner can quote', async ({ page }) => {
    await signIn(page);

    // Group 12 has already submitted in the fixture; read its receipt from the
    // learner's own page rather than assuming an ID.
    const learner = await page.context().newPage();
    await learner.goto('/');
    const href = await learner
      .locator('[data-testid="demo-scenario-card"][data-scenario="complete"]')
      .getByRole('link', { name: 'Open learner portal' })
      .getAttribute('href');
    await learner.goto(href as string);
    await learner.getByLabel('Your name').fill('Demo editor');
    await learner.getByRole('button', { name: 'Open our submission' }).click();
    await expect(learner.getByTestId('submission-receipt')).toBeVisible();
    const receiptId = (await learner.getByText(/^OSK-/).first().textContent()) as string;
    await learner.close();

    const lookup = page.getByTestId('receipt-lookup');
    await lookup.getByLabel('Receipt ID').fill(receiptId.trim());
    await lookup.getByRole('button', { name: 'Find' }).click();

    const result = page.getByTestId('receipt-result');
    await expect(result).toContainText('Group 12');
    await expect(result.getByRole('link', { name: 'Open the submission' })).toBeVisible();
  });

  test('says so plainly when nothing matches', async ({ page }) => {
    await signIn(page);
    const lookup = page.getByTestId('receipt-lookup');
    await lookup.getByLabel('Receipt ID').fill('OSK-NOPE-999-ZZZZZZ');
    await lookup.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByTestId('receipt-result')).toContainText(/No submission has receipt ID/);
  });
});

test.describe('idea definitions', () => {
  test('marks expanded definitions as draft until a human approves them', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/cohorts');
    await page.getByRole('link', { name: 'Ideas' }).first().click();
    await expect(page.getByRole('heading', { name: 'Approved ideas' })).toBeVisible();

    await expect(page.getByTestId('draft-definitions')).toBeVisible();
    await expect(page.getByText('definition in draft').first()).toBeVisible();

    const draftIdea = page.getByRole('heading', { name: /definition in draft/ }).first();
    const title = ((await draftIdea.textContent()) ?? '').replace('definition in draft', '').trim();

    await acceptConfirm(page);
    await page.getByRole('button', { name: 'Approve this definition' }).first().click();

    // The row itself is the confirmation: the badge flips and the button is
    // replaced by when it was approved.
    await expect(
      page.getByRole('heading', { name: `${title} definition approved` }),
    ).toBeVisible();
    await expect(page.getByTestId('draft-definitions')).toHaveCount(0);
  });
});

test.describe('health', () => {
  test('reports ok when the app can serve a learner', async ({ page }) => {
    const response = await page.request.get('/api/health');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ config: 'ok', store: 'ok' });
  });

  test('reveals nothing about the deployment', async ({ page }) => {
    const body = await (await page.request.get('/api/health')).text();
    for (const forbidden of ['DATABASE', 'SUPABASE', 'KEY', 'secret', 'version', 'host']) {
      expect(body, `health leaks ${forbidden}`).not.toContain(forbidden);
    }
  });
});
