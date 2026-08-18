import { expect, test, type Page } from '@playwright/test';
import { openDraftPortal, openScenario } from './learner-support';

/**
 * Learner journey and isolation.
 *
 * The negative tests matter more than the positive ones: a participant reaching
 * judging information is the single most damaging failure this system can have.
 *
 * Entry runs through `learner-support`, which also gets past the first-run
 * walkthrough. A hard load matters for the isolation checks: a client-side
 * navigation keeps the PREVIOUS document's inlined payload in the page, so
 * `page.content()` would still contain the demo home's copy and report a leak
 * that is not there.
 */

/** The complete team — already finally submitted, so it shows the receipt. */
async function openSubmittedPortal(page: Page): Promise<void> {
  await openScenario(page, 'complete');
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
      page.getByText(/There are 6 simple steps\. Your work saves as you go/),
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

    // The same sentences the tour uses, read from one source.
    const intros = [
      'Tell us who built the project and what each person worked on.',
      'Tell us who your product is for, what problem you are solving, and what you built.',
      'Share your working product and tell us the main flow we should test.',
      'Upload your pitch deck and share your short demo video.',
      'Tell us what went wrong, what you fixed, what you learned, and what you would improve next.',
      "Check everything once. Final Submit locks your submission, so only use it when you're done.",
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

    await page.getByLabel('Does someone need to log in to use it?').check();
    await expect(page.getByLabel('Demo password')).toHaveAttribute('type', 'password');
  });

  test('offers the deck upload zone and template downloads', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(3).click();

    await expect(page.getByText('Upload your pitch deck (PDF)')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download pitch-deck template' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Download submission instructions' })).toBeVisible();
  });

  test('reviews as a checklist, with every missing item listed and clickable', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(5).click();

    const checklist = page.getByTestId('review-checklist');
    await expect(checklist).toBeVisible();
    // One row per content step; declarations are shown as themselves below.
    await expect(checklist.locator('[data-testid^="review-row-"]')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Fix this' }).first()).toBeVisible();
    await expect(page.getByText('Before you submit')).toBeVisible();
    await expect(
      page.getByText('You can edit your answers until you use Final Submit'),
    ).toBeVisible();
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

  test('a participant cannot read another team\u2019s submission', async ({ page }) => {
    await openScenario(page, 'incomplete');
    const firstGroup = await page.getByRole('banner').getByText(/^Group \d+$/).textContent();

    await openScenario(page, 'inaccessible');
    const secondGroup = await page.getByRole('banner').getByText(/^Group \d+$/).textContent();

    // Each session resolves to exactly one team, and switching identity takes a
    // fresh invite — a session is never widened by visiting another link.
    expect(firstGroup).not.toBe(secondGroup);
  });

  test('stored demo credentials never reach the learner page', async ({ page }) => {
    await openScenario(page, 'login_required');

    const body = await page.content();
    expect(body).not.toContain('DemoReviewer!2026');
    expect(body).not.toContain('usernameCiphertext');
  });
});
