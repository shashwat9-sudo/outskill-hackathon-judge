import { expect, test, type Page } from '@playwright/test';

/**
 * Learner journey and isolation.
 *
 * The negative tests matter more than the positive ones: a participant reaching
 * judging information is the single most damaging failure this system can have.
 */

/**
 * The draft team — its form is editable, so the steps are all reachable.
 * Waits for the form to land, so nothing reads the page mid-navigation.
 */
async function openDraftPortal(page: Page): Promise<void> {
  await page.goto(await portalHref(page, 'incomplete'));
  await expect(page.getByTestId('submission-stepper').first()).toBeVisible();
}

/**
 * Resolve a scenario's invite URL, then navigate to it directly.
 *
 * A hard load matters for the isolation checks: a client-side navigation keeps
 * the PREVIOUS document's inlined payload in the page, so `page.content()`
 * would still contain the demo home's copy and report a leak that is not there.
 */
async function portalHref(page: Page, scenario: string): Promise<string> {
  await page.goto('/');
  const href = await page
    .locator(`[data-testid="demo-scenario-card"][data-scenario="${scenario}"]`)
    .getByRole('link', { name: 'Open learner portal' })
    .getAttribute('href');
  expect(href, `no invite link for the ${scenario} scenario`).toBeTruthy();
  return href as string;
}

/** The complete team — already finally submitted, so it shows the receipt. */
async function openSubmittedPortal(page: Page): Promise<void> {
  await page.goto(await portalHref(page, 'complete'));
  await expect(page.getByTestId('submission-receipt')).toBeVisible();
}

test.describe('learner portal', () => {
  test('shows the Outskill shell with cohort, group and status', async ({ page }) => {
    await openDraftPortal(page);

    const header = page.getByRole('banner');
    await expect(header.getByText('OUTSKILL')).toBeVisible();
    await expect(header.getByText(/^Group \d+$/)).toBeVisible();
    await expect(header.getByText('Draft', { exact: true })).toBeVisible();
  });

  test('uses the required headline and supporting copy', async ({ page }) => {
    await openDraftPortal(page);

    await expect(
      page.getByRole('heading', { name: 'Submit your hackathon product' }),
    ).toBeVisible();
    await expect(
      page.getByText(/Complete the six steps below\. Your progress is saved automatically/),
    ).toBeVisible();
  });

  test('shows the deadline in the official timezone and the local one', async ({ page }) => {
    await openDraftPortal(page);

    await expect(page.getByText('Official deadline')).toBeVisible();
    await expect(page.getByText('Your local time')).toBeVisible();
    await expect(page.getByText('Time remaining')).toBeVisible();
    await expect(page.getByText('The deadline has passed')).toHaveCount(0);
  });

  test('has a six-step progress indicator', async ({ page }) => {
    await openDraftPortal(page);

    const stepper = page.getByTestId('submission-stepper').first();
    await expect(stepper).toBeVisible();

    const steps = stepper.getByRole('button');
    await expect(steps).toHaveCount(6);

    for (const label of [
      'Team',
      'Product idea',
      'Live product',
      'Demo and deck',
      'Learning evidence',
      'Review and submit',
    ]) {
      await expect(stepper.getByRole('button', { name: new RegExp(label) })).toHaveCount(1);
    }
  });

  test('shows completion progress and a save status', async ({ page }) => {
    await openDraftPortal(page);
    await expect(page.getByTestId('percent-complete')).toBeVisible();
    await expect(page.getByTestId('save-status')).toBeVisible();
  });

  test('walks through all six steps, each with a one-sentence explanation', async ({ page }) => {
    await openDraftPortal(page);
    const stepper = page.getByTestId('submission-stepper').first();

    const intros = [
      'Confirm the people who actively built this submission.',
      'Select the approved challenge and describe the problem and product promise.',
      'Tell the automated judge how to safely access and test your core workflow.',
      'Upload the final pitch deck and link the short product walkthrough.',
      'Show how your team scoped, tested and improved the product during the hackathon.',
      'Check everything below, agree to the declarations, then make your final submission.',
    ];

    for (let i = 0; i < 6; i++) {
      await stepper.getByRole('button').nth(i).click();
      await expect(page.getByText(intros[i] as string)).toBeVisible();
    }
  });

  test('presents approved ideas as selectable cards, not a dropdown', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(1).click();

    const cards = page.getByTestId('idea-cards');
    await expect(cards).toBeVisible();
    // Eight approved ideas, each a radio-backed card.
    await expect(cards.getByRole('radio')).toHaveCount(8);
    await expect(cards.getByText('Travel Itinerary Planner')).toBeVisible();
  });

  test('masks the demo password field', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(2).click();

    await page.getByLabel('Our product requires a login').check();
    await expect(page.getByLabel('Demo password')).toHaveAttribute('type', 'password');
  });

  test('offers the deck upload zone and template downloads', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(3).click();

    await expect(page.getByText('Upload your pitch deck (PDF)')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download pitch-deck template' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download submission instructions' })).toBeVisible();
  });

  test('groups missing fields at the top of the review step', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(5).click();

    await expect(page.getByText('Not ready to submit yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit section' }).first()).toBeVisible();
    await expect(page.getByText('This locks your submission')).toBeVisible();
  });

  test('offers Previous, Save draft and Save and continue', async ({ page }) => {
    await openDraftPortal(page);
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save and continue' })).toBeVisible();

    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('button', { name: 'Previous' })).toBeVisible();
  });

  test('shows a receipt page after final submission', async ({ page }) => {
    await openSubmittedPortal(page);

    const receipt = page.getByTestId('submission-receipt');
    await expect(receipt).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Submission received' })).toBeVisible();
    await expect(receipt.getByText(/OSK-AIAPD1-012-/)).toBeVisible();
    await expect(receipt.getByText('What happens next')).toBeVisible();
    await expect(receipt.getByText(/cannot be edited/i)).toBeVisible();

    // The form is replaced entirely — no stepper on the receipt.
    await expect(page.getByTestId('submission-stepper')).toHaveCount(0);
  });
});

test.describe('learner isolation', () => {
  test('an invalid invite token 404s', async ({ page }) => {
    const response = await page.goto('/submit/definitely-not-a-real-token');
    expect(response?.status()).toBe(404);
  });

  test('the learner portal exposes no scores, rank, evidence or shortlist', async ({ page }) => {
    await openDraftPortal(page);
    const body = (await page.content()).toLowerCase();

    for (const forbidden of [
      'weightedscore',
      'rawscore',
      'inshortlist',
      'supportingevidence',
      'contradictoryevidence',
      'tiebreak',
      'privateguidance',
      'meanconfidence',
      'lowconfidence',
      'disqualification',
      'consistencyreview',
      'feedbackreport',
    ]) {
      expect(body, `learner portal leaked "${forbidden}"`).not.toContain(forbidden);
    }
  });

  test('the receipt shows no judging information', async ({ page }) => {
    await openSubmittedPortal(page);
    const body = (await page.content()).toLowerCase();

    for (const forbidden of ['score', 'rank', 'shortlist', 'evidence', 'top 10', 'confidence']) {
      expect(body, `receipt leaked "${forbidden}"`).not.toContain(forbidden);
    }
  });

  test('a participant sees no admin navigation', async ({ page }) => {
    await openDraftPortal(page);
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toHaveCount(0);
    for (const label of ['Judging', 'Shortlist', 'Finalists']) {
      await expect(page.getByRole('link', { name: label })).toHaveCount(0);
    }
  });

  test('a participant cannot reach the admin dashboard', async ({ page }) => {
    await openDraftPortal(page);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByRole('heading', { name: /internal sign in/i })).toBeVisible();
  });

  test('a participant cannot reach the shortlist, finalists or judging routes', async ({ page }) => {
    await openDraftPortal(page);

    for (const route of ['/admin/ranking', '/admin/final-selection', '/admin/assessment-queue']) {
      await page.goto(route);
      await expect(page, `${route} should not render`).toHaveURL(/\/admin\/login/);
      const body = (await page.content()).toLowerCase();
      expect(body).not.toContain('top 10');
      expect(body).not.toContain('private shortlist');
    }
  });

  test('a participant cannot read another team’s submission', async ({ page }) => {
    await page.goto('/');
    const links = await page.getByRole('link', { name: 'Open learner portal' }).all();
    const first = (await links[0]?.getAttribute('href')) as string;
    const second = (await links[1]?.getAttribute('href')) as string;
    expect(first).not.toBe(second);

    await page.goto(first);
    const firstGroup = await page.getByText(/^Group \d+$/).first().textContent();
    await page.goto(second);
    const secondGroup = await page.getByText(/^Group \d+$/).first().textContent();

    expect(firstGroup).not.toBe(secondGroup);
  });

  test('stored demo credentials never reach the learner page', async ({ page }) => {
    await page.goto(await portalHref(page, 'login_required'));

    const body = await page.content();
    expect(body).not.toContain('DemoReviewer!2026');
    expect(body).not.toContain('usernameCiphertext');
  });
});
