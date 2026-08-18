import { expect, type Page } from '@playwright/test';

/**
 * Getting into a learner portal, in the demo server.
 *
 * Shared because there are now three things every learner test has to do before
 * it can look at anything — clear the previous scenario's session, walk the
 * invite through the editor-name step, and get past the first-run tour — and
 * three copies of that drift.
 */

/**
 * Dismiss the first-run walkthrough.
 *
 * It appears on the first entry for a team in a browser, which in a test is
 * every entry: Playwright gives each context fresh storage. It sits over the
 * form, so a test that ignores it fails on a click it cannot explain.
 *
 * Deliberately tolerant of it being absent. A test that has already dismissed
 * it, or one running against a context that has seen it, must not fail here —
 * whether the tour showed is the tour's own test's business.
 */
export async function dismissTour(page: Page): Promise<void> {
  const tour = page.getByTestId('submission-walkthrough');

  // Waited for rather than polled once. The tour is opened by an effect after
  // hydration, so an immediate `isVisible()` answers "no" a beat before it
  // appears — and then every later click in the test is intercepted by a dialog
  // the test believed it had checked for.
  try {
    await tour.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    // Already seen in this browser. Whether it should have shown is the tour's
    // own test's business, not every test's.
    return;
  }

  await page.getByTestId('skip-tour').click();
  await expect(tour).toBeHidden();
}

/** Resolve a demo scenario's invite URL from the demo home page. */
export async function portalHref(page: Page, scenario: string): Promise<string> {
  await page.goto('/');
  const href = await page
    .locator(`[data-testid="demo-scenario-card"][data-scenario="${scenario}"]`)
    .getByRole('link', { name: 'Open learner portal' })
    .getAttribute('href');
  expect(href, `no invite link for the ${scenario} scenario`).toBeTruthy();
  return href as string;
}

/**
 * Follow a demo invite through the editor-name step into the portal.
 *
 * The invite link does not drop straight into the form: every session carries a
 * name, so a team can see who changed what. The demo path runs through the same
 * step as production rather than around it.
 */
export async function openScenario(page: Page, scenario: string): Promise<void> {
  // Drop any session from a previous scenario, or the invite route would
  // redirect straight into the wrong team's portal.
  await page.context().clearCookies({ name: 'ohj_team_session' });
  await page.goto(await portalHref(page, scenario));
  await page.getByLabel('Your name').fill('Demo editor');
  await page.getByRole('button', { name: 'Open our submission' }).click();
  await expect(page).toHaveURL(/\/submit\/portal$/);
  await dismissTour(page);
}

/**
 * The draft team — its form is editable, so every step is reachable.
 *
 * Settles on the progress line rather than the step list: on a phone the six
 * steps are folded away behind a toggle, so waiting for them to be *visible*
 * would hang on exactly the viewport the mobile tests care about.
 */
export async function openDraftPortal(page: Page): Promise<void> {
  await openScenario(page, 'incomplete');
  await expect(page.getByTestId('percent-complete')).toBeVisible();
}

/** Move to one of the six steps by its position. */
export async function goToStep(page: Page, index: number): Promise<void> {
  await page.getByTestId('submission-stepper').first().getByRole('button').nth(index).click();
}
