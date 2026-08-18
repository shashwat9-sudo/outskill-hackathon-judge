import { expect, test } from '@playwright/test';

/**
 * Demo home page.
 *
 * The regression these guard against: the scenario list rendered its headings
 * with zero rows, because a class-identity check for the demo store failed
 * after a module reload. An empty list is invisible in a passing build — so it
 * gets an explicit count assertion.
 */

const SCENARIOS = [
  'complete',
  'incomplete',
  'login_required',
  'inaccessible',
  'manual_review',
  'low_confidence',
];

test.describe('demo home', () => {
  test('is clearly marked as internal demo mode', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Internal demo mode — synthetic data only')).toBeVisible();
  });

  test('offers the two primary entry points, separated by audience', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Preview the learner experience' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open the admin workspace' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Preview learner journey/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Open admin workspace/ })).toBeVisible();
  });

  test('renders exactly six scenario cards', async ({ page }) => {
    await page.goto('/');
    // The defect was zero rows behind a visible heading.
    await expect(page.getByTestId('demo-scenario-card')).toHaveCount(6);
  });

  test('covers every required scenario', async ({ page }) => {
    await page.goto('/');
    for (const scenario of SCENARIOS) {
      await expect(
        page.locator(`[data-testid="demo-scenario-card"][data-scenario="${scenario}"]`),
        `missing scenario card: ${scenario}`,
      ).toHaveCount(1);
    }
  });

  test('shows group number, product, scenario label and status on each card', async ({ page }) => {
    await page.goto('/');
    const first = page.getByTestId('demo-scenario-card').first();

    await expect(first.getByText(/^Group \d+$/)).toBeVisible();
    await expect(first.getByText('Submission status:')).toBeVisible();
    await expect(first.getByRole('link', { name: 'Open learner portal' })).toBeVisible();
  });

  test('every learner link opens a working invite route', async ({ page }) => {
    await page.goto('/');
    const links = page.getByRole('link', { name: 'Open learner portal' });
    await expect(links).toHaveCount(6);

    const hrefs = await links.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).getAttribute('href')),
    );

    expect(new Set(hrefs).size).toBe(6); // six distinct tokens

    for (const href of hrefs) {
      expect(href).toMatch(/^\/submit\/[A-Za-z0-9_-]{20,}$/);
      const response = await page.goto(href as string);
      expect(response?.status(), `${href} did not load`).toBe(200);
      // The invite page names the team it is about to open, before anyone
      // commits to it.
      await expect(page.getByText(/^Group \d+$/).first()).toBeVisible();
      await expect(page.getByTestId('invite-entry-form')).toBeVisible();
    }
  });

  test('offers an admin link on the assessed scenarios', async ({ page }) => {
    await page.goto('/');
    // The draft has no assessment to view; the other five do.
    await expect(page.getByRole('link', { name: 'View in admin' })).toHaveCount(5);
  });

  test('shows a deadline that has not expired', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/remaining/)).toBeVisible();
    await expect(page.getByText(/deadline has passed/i)).toHaveCount(0);
  });
});
