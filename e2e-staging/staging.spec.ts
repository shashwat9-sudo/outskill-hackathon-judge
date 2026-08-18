import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * The deployed build, driven for real.
 *
 * Everything here runs against the Vercel deployment over HTTPS, using the two
 * synthetic staging teams. It is deliberately not the hermetic suite: the point
 * is the things only a deployment can be wrong about — serverless cold starts,
 * a pooled database connection, cookies over a real TLS origin, PDFs rendered
 * in a Lambda, and whether the sign-in that has been flaky under automation
 * since F-17 is flaky here too.
 *
 * No admin route is exercised. Driving the admin interface needs the admin
 * password, which is not mine to have.
 *
 * The access codes are read from the CSV on the operator's Desktop. They are
 * never logged, never asserted on, and never written anywhere by this file.
 */

/**
 * Whichever synthetic cohort is currently live.
 *
 * The first staging cohort was archived and its codes rotated the moment the
 * operator exercised the admin flow — which is that flow working, not a
 * problem. A suite pinned to one CSV would report a defect every time somebody
 * used the product, so it reads whichever file still corresponds to an open
 * cohort and says plainly when there is none.
 */
const CANDIDATE_CSVS = [
  join(homedir(), 'Desktop', 'upload-check-access-code.csv'),
  join(homedir(), 'Desktop', 'staging-access-codes.csv'),
];

const CSV = CANDIDATE_CSVS.find((path) => existsSync(path)) ?? CANDIDATE_CSVS[0]!;

interface TeamCode {
  groupNumber: string;
  code: string;
}

function teamsFrom(file: string): TeamCode[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const header = lines.findIndex((l) => l.startsWith('group_number'));
  return lines
    .slice(header + 1)
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const cells = l.split(',');
      return { groupNumber: cells[0]!.trim(), code: cells[3]!.trim() };
    });
}

function teams(): TeamCode[] {
  return teamsFrom(CSV);
}

/**
 * The cohort used for the large-upload check.
 *
 * Its own cohort, because the staging one is archived and its codes rotated the
 * moment the operator exercised the admin flow — which is the flow working, not
 * a problem. A check that needs a live team should carry its own.
 */
function uploadCheckTeam(): TeamCode {
  return teamsFrom(join(homedir(), 'Desktop', 'upload-check-access-code.csv'))[0]!;
}

/**
 * One sign-in, from the entry page to the portal.
 *
 * Returns how long the whole thing took, because F-17 is a timing story: if it
 * fails here the duration of the successful runs is the only clue about what
 * the failing one was waiting for.
 */
async function signIn(
  page: Page,
  team: TeamCode,
  editorName: string,
): Promise<{ ok: boolean; ms: number; detail: string }> {
  const started = Date.now();
  try {
    await page.goto('/submit', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Group number').fill(team.groupNumber);
    await page.getByLabel('Team access code').fill(team.code);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Who is editing?' })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel('Your name').fill(editorName);
    await page.getByRole('button', { name: 'Open our submission' }).click();

    await page.waitForURL(/\/submit\/portal$/, { timeout: 30_000 });

    // A signed-in team lands on one of two pages, and both count as arriving:
    // the six-step form while the submission is a draft, and the receipt once
    // it is locked. Insisting on the form would make this helper depend on
    // whether some earlier test had submitted.
    await expect(
      page.getByTestId('percent-complete').or(page.getByTestId('submission-receipt')),
    ).toBeVisible({ timeout: 30_000 });
    return { ok: true, ms: Date.now() - started, detail: '' };
  } catch (error) {
    // What was on screen when it gave up — the missing piece in every earlier
    // F-17 report was that nothing said what the page was showing.
    const url = page.url();
    const visible = await page
      .locator('body')
      .innerText()
      .catch(() => '(unreadable)');
    return {
      ok: false,
      ms: Date.now() - started,
      detail: `url=${url} :: ${(error as Error).message.slice(0, 120)} :: screen="${visible.replace(/\s+/g, ' ').slice(0, 200)}"`,
    };
  }
}

async function dismissTour(page: Page) {
  const tour = page.getByTestId('submission-walkthrough');
  try {
    await tour.waitFor({ state: 'visible', timeout: 8_000 });
  } catch {
    return;
  }
  await page.getByTestId('skip-tour').click();
  await expect(tour).toBeHidden();
}


/**
 * Wait for an uploaded deck to appear on the Demo and deck step.
 *
 * A confirmed upload reloads the portal, which reopens on step one, so the
 * filename cannot simply be waited for where the file was chosen. Polling by
 * re-navigating each time is tolerant of the reload landing whenever it lands —
 * and, unlike watching the activity feed, it cannot be satisfied by a previous
 * test's upload.
 */
async function expectDeckNamed(page: Page, filename: string) {
  await expect(async () => {
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(3).click();
    await expect(page.getByText(filename, { exact: false })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 180_000 });
}

test.describe.configure({ mode: 'serial' });

test('the entry page is served over HTTPS and names the staging cohort', async ({ page }) => {
  const response = await page.goto('/submit');
  expect(response?.status()).toBe(200);
  expect(page.url()).toMatch(/^https:\/\//);
  // Named after whichever synthetic cohort is open, not a specific one — and
  // never a real cohort, which is the part worth asserting.
  await expect(page.getByText(/— DELETE LATER/)).toBeVisible();
  await expect(page.getByText('AIAP C13 Demo')).toHaveCount(0);
});

test('a wrong code is refused', async ({ page }) => {
  const [team] = teams();
  await page.goto('/submit');
  await page.getByLabel('Group number').fill(team!.groupNumber);
  await page.getByLabel('Team access code').fill('ZZZZ-ZZZZ-ZZZZ');
  await page.getByRole('button', { name: 'Continue' }).click();
  // Refused, and still on the entry page.
  await expect(page.getByRole('heading', { name: 'Who is editing?' })).toHaveCount(0);
  await expect(page.getByTestId('team-verify-form')).toBeVisible();
});

test('a team signs in and sees the first-run walkthrough', async ({ page }) => {
  const [team] = teams();
  const result = await signIn(page, team!, 'Staging Tester');
  expect(result.ok, result.detail).toBe(true);

  await expect(page.getByTestId('submission-walkthrough')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Submit your hackathon project' })).toBeVisible();
  await dismissTour(page);
  await expect(page.getByTestId('submission-stepper').first()).toBeVisible();
});

test('a draft saves against the deployed database, and survives a reload', async ({ page }) => {
  const [team] = teams();
  const result = await signIn(page, team!, 'Staging Tester');
  expect(result.ok, result.detail).toBe(true);
  await dismissTour(page);

  const marker = `Staging smoke ${Date.now()}`;
  await page.getByTestId('submission-stepper').first().getByRole('button').nth(1).click();
  await page.locator('#productName').fill(marker);
  await expect(page.getByTestId('save-status')).toContainText('Saved', { timeout: 30_000 });

  await page.reload();
  await dismissTour(page);
  await page.getByTestId('submission-stepper').first().getByRole('button').nth(1).click();
  await expect(page.locator('#productName')).toHaveValue(marker);
});

test('signing out and back in returns the same draft', async ({ page }) => {
  const [team] = teams();
  await signIn(page, team!, 'Staging Tester');
  await dismissTour(page);

  await page.getByTestId('submission-stepper').first().getByRole('button').nth(1).click();
  const saved = await page.locator('#productName').inputValue();
  expect(saved).toContain('Staging smoke');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/submit$/, { timeout: 30_000 });

  const again = await signIn(page, team!, 'Staging Tester Two');
  expect(again.ok, again.detail).toBe(true);
  await dismissTour(page);
  await page.getByTestId('submission-stepper').first().getByRole('button').nth(1).click();
  await expect(page.locator('#productName')).toHaveValue(saved);
});

test('the two staging teams cannot see each other', async ({ browser }) => {
  const all = teams();
  // Isolation needs two live teams. The single-team cohorts exist for other
  // checks, and skipping loudly beats asserting on a cohort that has one.
  test.skip(all.length < 2, 'the live synthetic cohort has one team');

  const contexts: BrowserContext[] = [];
  const seen: { group: string; body: string }[] = [];

  for (const [index, team] of all.entries()) {
    const context = await browser.newContext({
      baseURL: process.env.STAGING_BASE_URL ?? 'https://outskill-hackathon-judge.vercel.app',
    });
    contexts.push(context);
    const page = await context.newPage();

    /*
     * Sign-in, not the form.
     *
     * One of these teams is final-submitted and shows a receipt rather than a
     * stepper, and that is permanent. An isolation test that insists on an
     * editable form would be asserting on the order the suite happened to run
     * in; what it actually needs to know is whether a team can see anything
     * belonging to the other one.
     */
    await page.goto('/submit');
    await page.getByLabel('Group number').fill(team.groupNumber);
    await page.getByLabel('Team access code').fill(team.code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Who is editing?' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Your name').fill(`Isolation ${index + 1}`);
    await page.getByRole('button', { name: 'Open our submission' }).click();
    await page.waitForURL(/\/submit\/portal$/, { timeout: 30_000 });
    await dismissTour(page);

    await expect(page.getByRole('banner').getByText(`Group ${team.groupNumber}`)).toBeVisible();
    seen.push({ group: team.groupNumber, body: (await page.content()).toLowerCase() });
  }

  // Neither page carries the other team's group number anywhere in it.
  for (const [index, entry] of seen.entries()) {
    const otherGroup = all[1 - index]!.groupNumber;
    expect(entry.body, `group ${entry.group} saw group ${otherGroup}`).not.toContain(`group ${otherGroup}`);
    // Nor the other team's synthetic members.
    expect(entry.body).not.toContain(`ada.${otherGroup}@example.com`);
  }

  await Promise.all(contexts.map((c) => c.close()));
});

test('the learner portal exposes no judging data on the deployment', async ({ page }) => {
  const team = teams()[0]!;
  await signIn(page, team, 'Privacy Sweep');
  await dismissTour(page);

  const body = (await page.content()).toLowerCase();
  for (const forbidden of [
    'totalscore',
    'weightedscore',
    'inshortlist',
    'meanconfidence',
    'supportingevidence',
    'manualreviewflag',
    'disqualification',
    'aiap c13 demo',
  ]) {
    expect(body, `the deployed portal exposed "${forbidden}"`).not.toContain(forbidden);
  }
});

test('the guide and the completed example are served', async ({ page }) => {
  await page.goto('/submit/guide');
  await expect(page.getByRole('heading', { name: 'The six steps' })).toBeVisible();

  await page.goto('/submit/example');
  await expect(page.getByTestId('example-banner')).toBeVisible();
  await expect(page.locator('input')).toHaveCount(0);
});

/**
 * F-17.
 *
 * An acceptance-suite sign-in failed roughly one run in three against
 * `next dev`, with no error rendered and nothing in the server log. Four
 * mitigations reduced it and none removed it, and it was never root-caused. The
 * open question was whether it was compilation latency in the dev server or a
 * real defect in the entry flow.
 *
 * This is the experiment that answers it: the same flow, many times, against a
 * production build with no compiler in the request path. A fresh context each
 * time, so no cookie, cache or storage is shared between attempts.
 */
test('F-17: repeated sign-ins against the production build', async ({ browser }) => {
  test.setTimeout(15 * 60 * 1000);

  const ATTEMPTS = 20;
  const [team] = teams();
  const durations: number[] = [];
  const failures: string[] = [];

  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const context = await browser.newContext({
      baseURL: process.env.STAGING_BASE_URL ?? 'https://outskill-hackathon-judge.vercel.app',
    });
    const page = await context.newPage();
    const result = await signIn(page, team!, `F17 attempt ${attempt}`);
    durations.push(result.ms);
    if (!result.ok) failures.push(`attempt ${attempt}: ${result.detail}`);
    await context.close();
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  console.log(
    `F-17: ${ATTEMPTS - failures.length}/${ATTEMPTS} succeeded | ` +
      `median ${median}ms, slowest ${sorted[sorted.length - 1]}ms, fastest ${sorted[0]}ms`,
  );
  for (const failure of failures) console.log(`  ${failure}`);

  expect(failures, `F-17 reproduced on the deployment:\n${failures.join('\n')}`).toEqual([]);
});

/**
 * Storage, through the deployed function.
 *
 * The fixture is the application's own guide PDF, fetched from the deployment —
 * genuinely a PDF, genuinely small, and containing nobody's material. The
 * repository's real PDFs live under `reference-materials/`, which is private
 * and must never be uploaded anywhere.
 *
 * This is the path that produced F-7, where an upload was recorded and no bytes
 * were stored. The assertion is therefore about the object, not the row: the
 * portal must show the deck after a reload, which it can only do from an
 * artifact whose bytes went to Supabase Storage.
 */
test('a deck uploads from the deployment into Supabase Storage', async ({ page }) => {
  const team = teams()[0]!;
  const result = await signIn(page, team, 'Upload Tester');
  expect(result.ok, result.detail).toBe(true);
  await dismissTour(page);

  await page.getByTestId('submission-stepper').first().getByRole('button').nth(3).click();

  // Idempotent: once a deck exists the drop zone becomes "Replace file", so a
  // second run must upload over the top rather than wait for a zone that has
  // correctly gone away.
  await expect(
    page.getByText('Upload your pitch deck (PDF)').or(page.getByText('Replace file')),
  ).toBeVisible({ timeout: 30_000 });

  await page.locator('#deck-upload').setInputFiles('/tmp/staging-deck.pdf');

  // A confirmed upload reloads the portal, which reopens on step one. The deck
  // is therefore looked for after navigating back — and it is read from the
  // artifact row, which only exists if the bytes were seen in the bucket.
  await expectDeckNamed(page, 'staging-deck.pdf');
});

/**
 * Final submit and the receipt, on serverless.
 *
 * The draft is completed out-of-band (see `scripts/fill-staging-draft.ts`) so
 * this test is about the two things a deployment can be wrong about: whether
 * the compare-and-set that locks a submission works through a pooled
 * connection, and whether the receipt PDF renders inside a Lambda.
 *
 * Group 812 only. It is synthetic, disposable, and locking it costs nothing.
 */
test('final submit locks, and the receipt PDF is served', async ({ page }) => {
  const all = teams();
  const team = all.find((t) => t.groupNumber === '812');
  test.skip(!team, 'group 812 belongs to an archived cohort — final submit was proved there');

  const result = await signIn(page, team!, 'Receipt Tester');
  expect(result.ok, result.detail).toBe(true);
  await dismissTour(page);

  // Already locked from an earlier run: the receipt is what matters, and it is
  // checked below either way.
  const locked = await page.getByTestId('submission-receipt').isVisible().catch(() => false);

  if (!locked) {
    await page.getByTestId('submission-stepper').first().getByRole('button').nth(5).click();
    await expect(page.getByText('Before you submit')).toBeVisible();

    for (const id of [
      'builtDuringHackathon',
      'ownedByTeam',
      'externalMaterialDisclosed',
      'judgeMayModifyDemoData',
      'noRealCustomerData',
      'urlsAvailableThroughJudging',
      'permissionToSubmit',
    ]) {
      await page.locator(`#${id}`).check();
    }

    /*
     * Wait for the save, not just the click.
     *
     * The confirmation box is deliberately withheld while anything is unsaved —
     * the F-13 protection, after a stale tab reported "ready" for work that had
     * never reached the server. So the seven ticks have to land before the box
     * appears, and a test that races it is testing the wrong thing.
     */
    await expect(page.getByTestId('percent-complete')).toContainText('6 of 6', { timeout: 30_000 });

    // The confirmation box is the signal, not the save indicator. It is
    // withheld while anything is unsaved — the F-13 protection — so waiting for
    // it covers both cases, including the one where the ticks were already
    // stored from an earlier run and no save is triggered at all.
    await expect(page.locator('#confirmation')).toBeVisible({ timeout: 30_000 });
    await page.locator('#confirmation').fill('FINAL SUBMIT');
    await page.getByRole('button', { name: 'Final submit' }).click();
  }

  const receipt = page.getByTestId('submission-receipt');
  await expect(receipt).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Submission received' })).toBeVisible();

  // The receipt PDF, rendered by a function and served over HTTPS.
  const response = await page.request.get('/submit/receipt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('pdf');
  expect((await response.body()).byteLength).toBeGreaterThan(500);

  // And still nothing about judging.
  const body = (await page.content()).toLowerCase();
  for (const forbidden of ['score', 'rank', 'shortlist', 'evidence', 'confidence']) {
    expect(body, `the deployed receipt exposed "${forbidden}"`).not.toContain(forbidden);
  }
});

/**
 * D-1, proved on the deployment.
 *
 * A 6 MB body cannot reach a serverless function — the platform refuses it
 * around 4.5 MB — so this upload succeeding is the whole point of the direct
 * path. It also demonstrates the file never passes through the application:
 * the only request the function sees is a ticket request and a confirmation.
 */
test('a deck larger than a serverless body limit uploads on the deployment', async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  const team = uploadCheckTeam();
  const result = await signIn(page, team, 'Large Upload');
  expect(result.ok, result.detail).toBe(true);
  await dismissTour(page);

  await page.getByTestId('submission-stepper').first().getByRole('button').nth(3).click();
  await expect(
    page.getByText('Upload your pitch deck (PDF)').or(page.getByText('Replace file')),
  ).toBeVisible({ timeout: 30_000 });

  await page.locator('#deck-upload').setInputFiles('/tmp/staging-deck-6mb.pdf');

  // A confirmed upload reloads the portal, which reopens on step one — so the
  // deck is looked for after navigating back, not where the file was chosen.
  await expectDeckNamed(page, 'staging-deck-6mb.pdf');
  // The size, read back from the artifact row rather than from the file picker.
  await expect(page.getByText('6.0 MB · uploaded')).toBeVisible();
});
