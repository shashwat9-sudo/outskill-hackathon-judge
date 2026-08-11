import { expect, test, type Page } from '@playwright/test';

/**
 * Participant journey and isolation.
 *
 * The negative tests matter more than the positive ones: a participant reaching
 * judging information is the single most damaging failure this system can have.
 */

async function firstInviteUrl(page: Page): Promise<string> {
  await page.goto('/');
  const link = page.getByRole('link', { name: 'Open submission' }).first();
  await expect(link).toBeVisible();
  return (await link.getAttribute('href')) as string;
}

test.describe('participant portal', () => {
  test('opens a submission through a secure invite link', async ({ page }) => {
    const inviteUrl = await firstInviteUrl(page);
    await page.goto(inviteUrl);

    await expect(page.getByRole('heading', { name: /Demo Cohort/i })).toBeVisible();
    await expect(page.getByText('Submission deadline')).toBeVisible();
    await expect(page.getByText(/Group \d+/).first()).toBeVisible();
  });

  test('shows the deadline, the approved ideas and the public rubric', async ({ page }) => {
    await page.goto(await firstInviteUrl(page));

    await expect(page.getByText('Official deadline')).toBeVisible();
    await expect(page.getByText('Your local time')).toBeVisible();

    // Public rubric: categories and weights, totalling 100.
    await expect(page.getByRole('heading', { name: 'How submissions are assessed' })).toBeVisible();
    await expect(page.getByText('Core workflow functionality')).toBeVisible();
    await expect(page.getByText('Problem and target-user clarity')).toBeVisible();

    const rubricTable = page.getByRole('table', { name: /rubric categories and weights/i });
    await expect(rubricTable.getByRole('cell', { name: '100', exact: true })).toBeVisible();
  });

  test('offers the pitch deck template for download', async ({ page }) => {
    await page.goto(await firstInviteUrl(page));
    await expect(page.getByRole('link', { name: 'Pitch Deck Template' })).toBeVisible();
  });

  test('walks through the six form steps', async ({ page }) => {
    // Group 27 is the seeded draft — a locked submission shows a receipt panel
    // instead of the form, so the steps would not be present.
    await page.goto('/');
    await page.getByRole('row', { name: /^27/ }).getByRole('link', { name: 'Open submission' }).click();

    // Step buttons carry a number or tick prefix, so they are addressed by
    // position within the step navigation rather than by an anchored name.
    const steps = page.getByRole('navigation', { name: 'Submission steps' }).getByRole('button');
    await expect(steps).toHaveCount(7); // six steps plus review

    for (let i = 0; i < 6; i++) {
      await steps.nth(i).click();
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    }

    await steps.nth(6).click();
    await expect(page.getByRole('heading', { name: 'Review and submit' })).toBeVisible();
  });

  test('locks the submission after final submit and shows a receipt', async ({ page }) => {
    // Group 12 is seeded as already finally submitted.
    await page.goto('/');
    const submitted = page.getByRole('row', { name: /^12/ }).getByRole('link', { name: 'Open submission' });
    await submitted.click();

    await expect(page.getByText('Your submission is in')).toBeVisible();
    await expect(page.getByText(/OSK-AIAPD1-012-/)).toBeVisible();
    await expect(page.getByText(/locked and can no longer be edited/i)).toBeVisible();
  });
});

test.describe('participant isolation', () => {
  test('an invalid invite token 404s', async ({ page }) => {
    const response = await page.goto('/submit/definitely-not-a-real-token');
    expect(response?.status()).toBe(404);
  });

  test('the participant page exposes no scores, rank, evidence or shortlist', async ({ page }) => {
    await page.goto(await firstInviteUrl(page));
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
      expect(body, `participant page leaked "${forbidden}"`).not.toContain(forbidden);
    }
  });

  test('a participant cannot reach the admin dashboard', async ({ page }) => {
    await page.goto(await firstInviteUrl(page));
    await page.goto('/admin');
    // Redirected to sign-in, with no admin content rendered.
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByRole('heading', { name: /internal sign in/i })).toBeVisible();
  });

  test('a participant cannot reach the ranking or the final-four workspace', async ({ page }) => {
    await page.goto(await firstInviteUrl(page));

    for (const route of ['/admin/ranking', '/admin/final-selection', '/admin/assessment-queue']) {
      await page.goto(route);
      await expect(page, `${route} should not render`).toHaveURL(/\/admin\/login/);
      const body = (await page.content()).toLowerCase();
      expect(body).not.toContain('top 10');
      expect(body).not.toContain('shortlist');
    }
  });

  test('a participant cannot read another team’s submission', async ({ page }) => {
    await page.goto('/');
    const links = await page.getByRole('link', { name: 'Open submission' }).all();
    const first = (await links[0]?.getAttribute('href')) as string;
    const second = (await links[1]?.getAttribute('href')) as string;
    expect(first).not.toBe(second);

    await page.goto(first);
    const firstGroup = await page.getByText(/^Group \d+$/).first().textContent();

    await page.goto(second);
    const secondGroup = await page.getByText(/^Group \d+$/).first().textContent();

    // Each token resolves to exactly one team, and never the other.
    expect(firstGroup).not.toBe(secondGroup);
  });

  test('stored demo credentials never reach the participant page', async ({ page }) => {
    await page.goto('/');
    // Group 45 is the login-required scenario with stored credentials.
    const loginRequired = page.getByRole('row', { name: /^45/ }).getByRole('link', { name: 'Open submission' });
    await loginRequired.click();

    const body = await page.content();
    expect(body).not.toContain('DemoReviewer!2026');
    expect(body).not.toContain('usernameCiphertext');
  });
});
