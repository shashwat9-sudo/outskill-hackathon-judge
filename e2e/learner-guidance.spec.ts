import { expect, test, type Page } from '@playwright/test';
import { dismissTour, goToStep, openDraftPortal, openScenario, portalHref } from './learner-support';

/**
 * Could someone who has never seen this form finish it without asking us?
 *
 * That is the whole standard, and it is not something a unit test can answer.
 * These drive the real pages in a real browser: the tour on first entry, a
 * question explaining itself, the list of what is left, and the jump from that
 * list to the box that fixes it.
 *
 * Everything here runs against the hermetic demo server with fixture data. No
 * real cohort, no real team, nothing that touches the acceptance evidence.
 */

// --------------------------------------------------------------------------
// The tour
// --------------------------------------------------------------------------

test.describe('the first time a team arrives', () => {
  test('the walkthrough opens, before anything else', async ({ page }) => {
    await page.context().clearCookies({ name: 'ohj_team_session' });
    await page.goto(await portalHref(page, 'incomplete'));
    await page.getByLabel('Your name').fill('First timer');
    await page.getByRole('button', { name: 'Open our submission' }).click();

    const tour = page.getByTestId('submission-walkthrough');
    await expect(tour).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Submit your hackathon project' })).toBeVisible();
    await expect(tour.getByText('There are 6 simple steps')).toBeVisible();
  });

  test('it covers the six steps and ends on Final Submit', async ({ page }) => {
    await page.context().clearCookies({ name: 'ohj_team_session' });
    await page.goto(await portalHref(page, 'incomplete'));
    await page.getByLabel('Your name').fill('First timer');
    await page.getByRole('button', { name: 'Open our submission' }).click();
    await expect(page.getByTestId('submission-walkthrough')).toBeVisible();

    for (const title of [
      'Team',
      'Product idea',
      'Live product',
      'Demo and deck',
      'Learning evidence',
      'Review and submit',
    ]) {
      await page.getByTestId('tour-next').click();
      await expect(page.getByTestId('submission-walkthrough').getByRole('heading')).toHaveText(title);
    }

    await expect(page.getByText('Final Submit locks your submission')).toBeVisible();
    await page.getByTestId('tour-start').click();
    await expect(page.getByTestId('submission-walkthrough')).toBeHidden();
  });

  test('skipping it gets straight to the form', async ({ page }) => {
    await openDraftPortal(page);
    await expect(page.getByTestId('submission-walkthrough')).toBeHidden();
    await expect(page.getByTestId('submission-stepper').first()).toBeVisible();
  });

  test('it does not come back on a reload', async ({ page }) => {
    await openDraftPortal(page);
    await page.reload();
    await expect(page.getByTestId('submission-stepper').first()).toBeVisible();
    await expect(page.getByTestId('submission-walkthrough')).toBeHidden();
  });

  test('it can be replayed from the help menu', async ({ page }) => {
    await openDraftPortal(page);

    await page.getByTestId('need-help').click();
    await page.getByTestId('help-replay-tour').click();

    await expect(page.getByTestId('submission-walkthrough')).toBeVisible();
    // From the beginning, not from wherever it was abandoned.
    await expect(page.getByRole('heading', { name: 'Submit your hackathon project' })).toBeVisible();
  });
});

// --------------------------------------------------------------------------
// A question that explains itself
// --------------------------------------------------------------------------

test.describe('a confusing question', () => {
  test('is asked in plain English, with the rule visible before typing', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);

    await expect(page.getByText('Who is this product mainly for?')).toBeVisible();
    await expect(page.getByText('Be specific about the kind of person who would use it.')).toBeVisible();
    await expect(
      page.getByText('Write at least 10 characters — a few words is enough.').first(),
    ).toBeVisible();
    // The old field-name wording is gone.
    await expect(page.getByText('Primary user', { exact: true })).toHaveCount(0);
  });

  test('offers an example, and shows it in place', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);

    await expect(page.getByTestId('example-exactProblem')).toHaveCount(0);
    await page.getByTestId('see-example-exactProblem').click();
    await expect(page.getByTestId('example-exactProblem')).toContainText(
      'People set fitness goals but often lose track of their daily progress.',
    );
    await expect(page.getByTestId('example-exactProblem')).toContainText(
      'Write your answer about your own',
    );
  });

  test('viewing the example writes nothing into the field', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);

    const field = page.locator('#exactProblem');
    const before = await field.inputValue();

    await page.getByTestId('see-example-exactProblem').click();
    await expect(page.getByTestId('example-exactProblem')).toBeVisible();

    await expect(field).toHaveValue(before);
    // And no button anywhere that would put it there.
    for (const label of [/copy/i, /use this/i, /fill for me/i, /generate/i]) {
      await expect(page.getByRole('button', { name: label })).toHaveCount(0);
    }
  });

  test('the form never offers to write an answer with AI', async ({ page }) => {
    await openDraftPortal(page);
    for (let step = 0; step < 6; step += 1) {
      await goToStep(page, step);
      const body = (await page.content()).toLowerCase();
      for (const forbidden of [
        'generate answer',
        'write this with ai',
        'improve my answer',
        'fill for me',
        'use this answer',
        'copy example',
      ]) {
        expect(body, `step ${step} offered "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });
});

// --------------------------------------------------------------------------
// What's missing
// --------------------------------------------------------------------------

test.describe("what's missing", () => {
  test('counts what is left on a step, and lists it on request', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);

    const panel = page.getByTestId('missing-panel-product');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('missing-count-product')).toContainText(/\d+ things? left/);

    await panel.getByRole('button', { name: /What’s missing\?/ }).click();
    await expect(panel.getByRole('button').nth(1)).toBeVisible();
  });

  test('never shows raw validation language', async ({ page }) => {
    await openDraftPortal(page);

    for (let step = 0; step < 6; step += 1) {
      await goToStep(page, step);
      const panel = page.getByTestId(`missing-panel-${['team', 'product', 'live', 'artifacts', 'learning', 'review'][step]}`);
      if (!(await panel.isVisible().catch(() => false))) continue;
      await panel.getByRole('button', { name: /What’s missing\?/ }).click();

      const text = (await panel.textContent()) ?? '';
      for (const leak of ['Required', 'Expected', 'invalid_type', 'ZodError', 'undefined']) {
        expect(text, `step ${step} leaked "${leak}"`).not.toContain(leak);
      }
    }
  });

  test('a missing item takes you to the box that fixes it', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);

    await page
      .getByTestId('missing-panel-product')
      .getByRole('button', { name: /What’s missing\?/ })
      .click();
    await page.getByTestId('missing-item-whyAiNecessary').click();

    await expect(page.locator('#whyAiNecessary')).toBeFocused();
  });

  test('fixing something removes it from the list', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);

    const panel = page.getByTestId('missing-panel-product');
    await panel.getByRole('button', { name: /What’s missing\?/ }).click();
    const before = await panel.getByRole('button').count();

    await page
      .locator('#whyAiNecessary')
      .fill("AI looks at the user's progress and gives simple suggestions on what to do next.");

    await expect(async () => {
      expect(await panel.getByRole('button').count()).toBe(before - 1);
    }).toPass();
    await expect(page.getByTestId('missing-item-whyAiNecessary')).toHaveCount(0);
  });
});

// --------------------------------------------------------------------------
// Progress and save state
// --------------------------------------------------------------------------

test.describe('knowing where you are', () => {
  test('shows how many steps are done, and that work is saved automatically', async ({ page }) => {
    await openDraftPortal(page);
    await expect(page.getByTestId('percent-complete')).toContainText(/\d of 6 steps complete/);
    await expect(page.getByText('Your answers save automatically.')).toBeVisible();
  });

  test('marks each step complete, needing attention, or not started', async ({ page }) => {
    await openDraftPortal(page);
    const stepper = page.getByTestId('submission-stepper').first();

    const states = await stepper.locator('button').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('data-state')),
    );
    expect(states).toHaveLength(6);
    for (const state of states) {
      expect(['complete', 'attention', 'untouched']).toContain(state);
    }
    // The demo's incomplete team has started, so at least one step needs attention.
    expect(states).toContain('attention');
  });

  test('says Saving… and then Saved', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);

    await page.locator('#productName').fill('Fitness Goal Tracker');
    await expect(page.getByTestId('save-status')).toContainText('Saved', { timeout: 15_000 });
  });
});

// --------------------------------------------------------------------------
// Review
// --------------------------------------------------------------------------

test.describe('review', () => {
  test('reads as a checklist with a line per step', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 5);

    const checklist = page.getByTestId('review-checklist');
    for (const label of [
      'Team',
      'Product idea',
      'Live product',
      'Demo and deck',
      'Learning evidence',
    ]) {
      await expect(checklist.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test('lists the missing items and links each one', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 5);

    const row = page.getByTestId('review-row-live');
    await expect(row).toHaveAttribute('data-complete', 'false');
    await expect(row).toContainText(/things? missing/);

    // Long rows summarise the tail rather than reprinting the whole form: the
    // learning step is missing twelve things, and twelve bullets is the form.
    const learning = page.getByTestId('review-row-learning');
    await expect(learning.locator('[data-testid^="review-missing-"]')).toHaveCount(4);
    await expect(learning.getByTestId('review-more-learning')).toContainText('more on this step');

    await row.locator('[data-testid^="review-missing-"]').first().click();
    // Landed on the Live product step. `exact` because the step's own sections
    // are headed "Your live product", which matches loosely.
    await expect(page.getByRole('heading', { name: 'Live product', exact: true })).toBeVisible();
  });

  test('explains Final Submit before offering it', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 5);

    await expect(page.getByText('Before you submit')).toBeVisible();
    await expect(
      page.getByText(
        'You can edit your answers until you use Final Submit. After that, your submission is locked.',
      ),
    ).toBeVisible();
  });

  test('leaves every declaration unticked', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 5);

    const declarations = page.locator('#builtDuringHackathon, #ownedByTeam, #noRealCustomerData');
    await expect(declarations).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) {
      await expect(declarations.nth(i)).not.toBeChecked();
    }
  });
});

// --------------------------------------------------------------------------
// Help, the example, and the guide
// --------------------------------------------------------------------------

test.describe('the help menu', () => {
  test('holds five things and no more', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('need-help').click();

    const menu = page.getByTestId('help-menu');
    await expect(menu).toBeVisible();
    for (const label of [
      'How to fill this step',
      'See a completed example',
      'Replay submission tour',
      'Submission checklist',
      'Resources',
    ]) {
      await expect(menu.getByText(label, { exact: true })).toBeVisible();
    }
    // Five rows, and no sixth. A help centre is what this must not become.
    await expect(menu.locator('[data-help-row]')).toHaveCount(5);
  });

  test('explains the step you are actually on', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 4);

    await page.getByTestId('need-help').click();
    await page.getByRole('button', { name: 'How to fill this step' }).click();

    const panel = page.getByTestId('help-step-panel');
    await expect(panel).toContainText('Tell us what went wrong, what you fixed');
    await expect(panel).toContainText('Three bugs you found and fixed');
  });

  test('carries the checklist and the common mistakes', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('need-help').click();
    await page.getByRole('button', { name: 'Submission checklist' }).click();

    const panel = page.getByTestId('help-checklist');
    await expect(panel).toContainText('Your deck exported as a PDF');
    await expect(panel).toContainText('Mistakes that cost teams marks');
  });

  test('closes without losing anything typed', async ({ page }) => {
    await openDraftPortal(page);
    await goToStep(page, 1);
    await page.locator('#productName').fill('Half typed');

    await page.getByTestId('need-help').click();
    await page.getByTestId('close-help').click();

    await expect(page.locator('#productName')).toHaveValue('Half typed');
  });
});

test.describe('the completed example', () => {
  test('is clearly an example, from the top', async ({ page }) => {
    await page.goto('/submit/example');
    const banner = page.getByTestId('example-banner');
    await expect(banner).toContainText('Example only');
    await expect(banner).toContainText(
      'Use this to understand what we are asking. Write your answers about your own project.',
    );
    await expect(page.getByRole('heading', { name: 'Fitness Goal Tracker' })).toBeVisible();
  });

  test('shows a filled-in answer for every step', async ({ page }) => {
    await page.goto('/submit/example');
    for (const heading of [
      'Team',
      'Product idea',
      'Live product',
      'Demo and deck',
      'Learning evidence',
      'Review and submit',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(
      page.getByText('People set fitness goals but often lose track of their daily progress.'),
    ).toBeVisible();
  });

  test('has nothing to type into and nothing to submit', async ({ page }) => {
    await page.goto('/submit/example');
    await expect(page.locator('input')).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveCount(0);
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.locator('[type="checkbox"]')).toHaveCount(0);
  });

  test('offers no way to copy an answer across', async ({ page }) => {
    await page.goto('/submit/example');
    for (const label of [/copy/i, /use this/i, /fill/i, /apply/i, /insert/i]) {
      await expect(page.getByRole('button', { name: label })).toHaveCount(0);
      await expect(page.getByRole('link', { name: label })).toHaveCount(0);
    }
  });

  test('shows the declarations without ticking any of them', async ({ page }) => {
    await page.goto('/submit/example');
    await expect(page.getByText('Nothing is ever ticked for you')).toBeVisible();
    await expect(page.locator('[type="checkbox"]')).toHaveCount(0);
  });

  test('exposes nothing about judging', async ({ page }) => {
    await page.goto('/submit/example');
    const body = (await page.content()).toLowerCase();
    for (const forbidden of [
      'weightedscore',
      'totalscore',
      'rubricversion',
      'inshortlist',
      'meanconfidence',
      'supportingevidence',
      'disqualification',
    ]) {
      expect(body, `the example page leaked "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

test.describe('the written guide', () => {
  test('covers the six steps with the same words the form uses', async ({ page }) => {
    await page.goto('/submit/guide');
    await expect(page.getByRole('heading', { name: 'The six steps' })).toBeVisible();
    await expect(
      page.getByText('Tell us who built the project and what each person worked on.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Mistakes that cost teams marks' })).toBeVisible();
  });

  test('shows the same worked answers as the form', async ({ page }) => {
    await page.goto('/submit/guide');
    await expect(
      page.getByText('People set fitness goals but often lose track of their daily progress.'),
    ).toBeVisible();
  });

  test('links to the completed example and downloads as a PDF', async ({ page }) => {
    await page.goto('/submit/guide');
    await expect(page.getByTestId('guide-example-link')).toBeVisible();
    await expect(page.getByTestId('download-guide')).toBeVisible();

    const response = await page.request.get('/api/guide');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('pdf');
  });
});

// --------------------------------------------------------------------------
// Mobile
// --------------------------------------------------------------------------

test.describe('on a 360px phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  /** The step list is folded on a phone, so navigating means opening it first. */
  const toStep = async (page: Page, index: number) => {
    await page.getByTestId('toggle-steps').click();
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(index).click();
  };

  test('nothing overflows the screen, on any step', async ({ page }) => {
    await openDraftPortal(page);

    for (let step = 0; step < 6; step += 1) {
      await toStep(page, step);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `step ${step} scrolls sideways`).toBeLessThanOrEqual(1);
    }
  });

  test('the tour fits, and reads as a sheet from the bottom', async ({ page }) => {
    await page.context().clearCookies({ name: 'ohj_team_session' });
    await page.goto(await portalHref(page, 'incomplete'));
    await page.getByLabel('Your name').fill('Phone user');
    await page.getByRole('button', { name: 'Open our submission' }).click();

    const tour = page.getByTestId('submission-walkthrough');
    await expect(tour).toBeVisible();

    const panel = tour.locator('> div');
    const box = (await panel.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(360);
    // Anchored to the bottom of the viewport, not floating mid-screen.
    expect(box.y + box.height).toBeGreaterThan(740 - 4);

    await expect(page.getByTestId('tour-next')).toBeVisible();
    await expect(page.getByTestId('skip-tour')).toBeVisible();
    await dismissTour(page);
  });

  test('the step list folds away, and says where you are while folded', async ({ page }) => {
    await openDraftPortal(page);

    const toggle = page.getByTestId('toggle-steps');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Step 1 of 6 · Team');
    await expect(page.getByTestId('step-learning')).toBeHidden();

    await toggle.click();
    const stepper = page.getByTestId('submission-stepper').first();
    await expect(stepper.locator('li')).toHaveCount(6);

    // Every chip inside the screen, so none of the six is unreachable.
    const rights = await stepper.locator('li').evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().right),
    );
    for (const right of rights) expect(right).toBeLessThanOrEqual(360);
  });

  test('choosing a step closes the list and goes there', async ({ page }) => {
    await openDraftPortal(page);
    await page.getByTestId('toggle-steps').click();
    await page.getByTestId('step-artifacts').click();

    await expect(page.getByTestId('toggle-steps')).toContainText('Step 4 of 6 · Demo and deck');
    await expect(page.getByTestId('step-artifacts')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Demo and deck', exact: true })).toBeVisible();
  });

  test('the primary action is reachable without hunting', async ({ page }) => {
    await openDraftPortal(page);
    const next = page.getByRole('button', { name: 'Save and continue' });
    await expect(next).toBeInViewport();

    const box = (await next.boundingBox())!;
    expect(box.height, 'below a comfortable touch target').toBeGreaterThanOrEqual(40);
  });

  test('help is a bottom sheet, not a full-screen takeover', async ({ page }) => {
    await openDraftPortal(page);
    await expect(page.getByTestId('need-help')).toBeInViewport();

    await page.getByTestId('need-help').click();
    const menu = page.getByTestId('help-menu');
    await expect(menu).toBeVisible();

    const panel = menu.locator('> div');
    const box = (await panel.boundingBox())!;
    expect(box.height, 'a sheet, not the whole screen').toBeLessThanOrEqual(740 * 0.9);
  });

  test('an example expands under its question rather than covering it', async ({ page }) => {
    await openDraftPortal(page);
    await toStep(page, 1);

    await page.getByTestId('see-example-exactProblem').click();
    const example = page.getByTestId('example-exactProblem');
    await expect(example).toBeVisible();

    const field = (await page.locator('#exactProblem').boundingBox())!;
    const shown = (await example.boundingBox())!;
    expect(shown.y, 'the example covered the question it explains').toBeGreaterThan(field.y);
    expect(shown.width).toBeLessThanOrEqual(360);
  });

  test('a long answer does not break the layout', async ({ page }) => {
    await openDraftPortal(page);
    await toStep(page, 1);

    await page.locator('#briefDescription').fill('word '.repeat(300));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('the completed example reads on a phone', async ({ page }) => {
    await page.goto('/submit/example');
    await expect(page.getByTestId('example-banner')).toBeInViewport();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

// --------------------------------------------------------------------------
// Nothing about this feature changed what a learner may see
// --------------------------------------------------------------------------

test.describe('isolation is unchanged', () => {
  test('no judging data reaches the guidance surfaces', async ({ page }) => {
    for (const url of ['/submit/example', '/submit/guide']) {
      await page.goto(url);
      const body = (await page.content()).toLowerCase();
      for (const forbidden of [
        'totalscore',
        'weightedscore',
        'inshortlist',
        'tiebreakvector',
        'manualreviewflag',
        'privateguidance',
        'top 10',
      ]) {
        expect(body, `${url} leaked "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  test('a team still sees only their own submission', async ({ page }) => {
    await openScenario(page, 'incomplete');
    const header = page.getByRole('banner');
    await expect(header.getByText('Group 27')).toBeVisible();

    // A different team, reached through its own invite. The portal shows that
    // team and only that team — no trace of the previous one survives the
    // switch, which is the property the guidance work must not have weakened.
    await openScenario(page, 'login_required');
    await expect(header.getByText('Group 45')).toBeVisible();
    await expect(header.getByText('Group 27')).toHaveCount(0);
  });
});
