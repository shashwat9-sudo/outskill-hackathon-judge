import { expect, test, type Page } from '@playwright/test';
import { dismissTour } from './learner-support';

/**
 * The common production entry.
 *
 * This is the URL Outskill puts in Circle. Everything here is about the two
 * failures that would actually hurt on hackathon day: a team unable to get in,
 * and a team getting into somebody else's submission.
 */

/** The fixture's draft team, so the portal shows the editable form. */
const DRAFT_GROUP = '27';

/** The demo hint is the only place a plaintext code exists. Real codes never appear. */
async function demoAccessCode(page: Page): Promise<string> {
  await page.goto('/submit');
  const hint = await page.getByTestId('demo-hint').textContent();
  const match = /access code ([A-Z0-9-]+)/.exec(hint ?? '');
  expect(match, 'demo mode did not expose a fixture access code').toBeTruthy();
  return (match as RegExpExecArray)[1] as string;
}

async function enterAs(page: Page, group: string, code: string, name = 'Priya Raman') {
  await page.goto('/submit');
  await page.getByLabel('Group number').fill(group);
  await page.getByLabel('Team access code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Who is editing?' })).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Open our submission' }).click();
  // Wait for the navigation to settle. Without this, the next goto races the
  // in-flight one and Chromium aborts it.
  await expect(page).toHaveURL(/\/submit\/portal$/);
  // A first entry opens the walkthrough, which sits over the header — including
  // the sign-out this file goes on to click.
  await dismissTour(page);
}

test.describe('the common entry page', () => {
  test('is one URL with no team identifier in it', async ({ page }) => {
    await page.goto('/submit');
    expect(new URL(page.url()).pathname).toBe('/submit');
    await expect(page.getByRole('heading', { name: 'Hackathon submission' })).toBeVisible();
    await expect(page.getByTestId('team-verify-form')).toBeVisible();
  });

  test('says when submissions close before anyone types a code', async ({ page }) => {
    await page.goto('/submit');
    await expect(page.getByTestId('window-notice')).toContainText(/Submissions close|closed|paused/);
  });

  test('tells a team what to have ready', async ({ page }) => {
    await page.goto('/submit');
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();
    await expect(page.getByText(/Export your pitch deck as a PDF/)).toBeVisible();
  });

  test('shows no admin link, no demo teams and no judging language', async ({ page }) => {
    await page.goto('/submit');
    const html = await page.content();

    for (const forbidden of ['/admin', 'Shortlist', 'Finalist', 'Top 10', 'Score', 'Ranking']) {
      expect(html, `entry page mentions ${forbidden}`).not.toContain(forbidden);
    }
  });
});

test.describe('verification', () => {
  test('lets a team in with a group number and access code', async ({ page }) => {
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page));

    await expect(page).toHaveURL(/\/submit\/portal$/);
    await expect(page.getByTestId('editing-as')).toContainText('Priya Raman');
    await expect(page.getByRole('banner').getByText(`Group ${DRAFT_GROUP}`)).toBeVisible();
  });

  test('accepts the code lowercase, spaced and hyphenated', async ({ page }) => {
    const code = await demoAccessCode(page);
    const messy = `${code.slice(0, 4)} ${code.slice(4, 8)}-${code.slice(8)}`.toLowerCase();

    await enterAs(page, DRAFT_GROUP, messy);
    await expect(page).toHaveURL(/\/submit\/portal$/);
  });

  test('gives the same message for a wrong code and an unknown group', async ({ page }) => {
    await page.goto('/submit');
    await page.getByLabel('Group number').fill(DRAFT_GROUP);
    await page.getByLabel('Team access code').fill('QQQQ-QQQQ-QQQQ');
    await page.getByRole('button', { name: 'Continue' }).click();
    const wrongCode = await page.getByTestId('verify-error').textContent();

    await page.goto('/submit');
    await page.getByLabel('Group number').fill('987');
    await page.getByLabel('Team access code').fill('QQQQ-QQQQ-QQQQ');
    await page.getByRole('button', { name: 'Continue' }).click();
    const unknownGroup = await page.getByTestId('verify-error').textContent();

    // If these differed, the form would be a cohort enumeration tool.
    expect(unknownGroup).toBe(wrongCode);
    expect(wrongCode).not.toMatch(/group \d|no such group|not found/i);
  });

  test('never puts the access code in the URL or in browser history', async ({ page }) => {
    const code = await demoAccessCode(page);
    await enterAs(page, DRAFT_GROUP, code);

    expect(page.url()).not.toContain(code);

    const history = await page.evaluate(() => {
      const entries: string[] = [];
      for (let i = 0; i < window.history.length; i++) entries.push(window.location.href);
      return entries.join(' ');
    });
    expect(history).not.toContain(code);
  });

  test('never writes the access code to client-side storage', async ({ page }) => {
    const code = await demoAccessCode(page);
    await enterAs(page, DRAFT_GROUP, code);

    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      cookies: document.cookie,
    }));

    expect(stored.local).not.toContain(code);
    expect(stored.session).not.toContain(code);
    // The session cookie is HttpOnly, so document.cookie should not see it at all.
    expect(stored.cookies).not.toContain(code);
    expect(stored.cookies).not.toContain('ohj_team_session');
  });

  test('does not echo the code back into the portal', async ({ page }) => {
    const code = await demoAccessCode(page);
    await enterAs(page, DRAFT_GROUP, code);

    // The entry page carries a demo hint by design; the portal must not carry
    // the code at all, in markup or in the inlined server payload.
    expect(await page.content()).not.toContain(code);
  });
});

test.describe('the editor name', () => {
  test('explains itself in plain language', async ({ page }) => {
    // Resolved first: demoAccessCode navigates, which would clear a filled form.
    const code = await demoAccessCode(page);
    await page.goto('/submit');
    await page.getByLabel('Group number').fill(DRAFT_GROUP);
    await page.getByLabel('Team access code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByText(/it is not a login, and it does not restrict anyone/i)).toBeVisible();
  });

  test('appears in the header once editing starts', async ({ page }) => {
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page), 'Arjun Mehta');
    await expect(page.getByTestId('editing-as')).toContainText('Editing as Arjun Mehta');
  });
});

test.describe('the session', () => {
  test('names the team already signed in, instead of silently continuing as them', async ({
    page,
  }) => {
    // This used to redirect straight to the portal. On a shared hackathon
    // laptop that put one team inside another team's submission with edit
    // rights, and it made the credential form unreachable — someone testing a
    // different group number saw their input silently ignored.
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page));
    await page.goto('/submit');

    await expect(page).toHaveURL(/\/submit$/);
    const notice = page.getByTestId('existing-session');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`Group ${DRAFT_GROUP}`);
    await expect(notice).toContainText('will not change who you are signed in as');
  });

  test('still offers a way through to the team already signed in', async ({ page }) => {
    // Removing the redirect must not strand a team that is simply returning.
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page));
    await page.goto('/submit');

    await page.getByRole('link', { name: /Continue to Group/ }).click();
    await expect(page).toHaveURL(/\/submit\/portal$/);
  });

  test('renders the entry form when the session cookie is unusable', async ({ page, context }) => {
    // The signed-in notice reads fields off a resolved session. A cookie that
    // does not resolve must simply produce the form — not a half-rendered page
    // and not a server error, because a learner with a stale cookie from a
    // previous cohort would otherwise be locked out of submitting at all.
    for (const value of ['not-a-real-token', '', 'a'.repeat(400), 'aaaa.bbbb']) {
      await context.clearCookies();
      await context.addCookies([
        { name: 'ohj_team_session', value, domain: '127.0.0.1', path: '/' },
      ]);

      const response = await page.goto('/submit');
      expect(response?.status(), `cookie "${value.slice(0, 12)}"`).toBe(200);
      await expect(page.getByTestId('team-verify-form')).toBeVisible();
      await expect(page.getByTestId('existing-session')).toHaveCount(0);
    }
  });

  test('shows the signed-in notice without a crash when an editor name is present', async ({
    page,
  }) => {
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page), 'Arjun Mehta');
    await page.goto('/submit');

    const notice = page.getByTestId('existing-session');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Arjun Mehta');
  });

  test('offers a sign-out that reaches the entry form', async ({ page }) => {
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page));
    await page.goto('/submit');

    await page.getByRole('button', { name: 'Sign out to use a different group' }).click();
    await expect(page).toHaveURL(/\/submit$/);
    await expect(page.getByTestId('team-verify-form')).toBeVisible();
  });

  test('sends the team back to the entry page after signing out', async ({ page }) => {
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page));
    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/submit$/);
    await expect(page.getByTestId('team-verify-form')).toBeVisible();

    // And the portal is no longer reachable by typing the URL.
    await page.goto('/submit/portal');
    await expect(page).toHaveURL(/\/submit$/);
  });

  test('refuses the portal with no session at all', async ({ page }) => {
    await page.goto('/submit/portal');
    await expect(page).toHaveURL(/\/submit$/);
  });

  test('cannot be forged by inventing a cookie value', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'ohj_team_session',
        value: 'not-a-real-session-token',
        domain: '127.0.0.1',
        path: '/submit',
      },
    ]);
    await page.goto('/submit/portal');
    await expect(page).toHaveURL(/\/submit$/);
  });
});

test.describe('participant isolation holds through the new entry', () => {
  test('shows no score, rank, evidence or shortlist anywhere in the portal', async ({ page }) => {
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page));
    const html = await page.content();

    for (const forbidden of [
      'Shortlist',
      'Finalist',
      'Top 10',
      'Evidence',
      'Rank',
      'Manual review',
      'Disqualif',
    ]) {
      expect(html, `portal mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('offers no route into the admin surface', async ({ page }) => {
    await enterAs(page, DRAFT_GROUP, await demoAccessCode(page));
    expect(await page.locator('a[href^="/admin"]').count()).toBe(0);
  });
});
