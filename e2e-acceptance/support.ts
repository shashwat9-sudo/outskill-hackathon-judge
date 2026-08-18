import { readFileSync } from 'node:fs';
import { expect, type BrowserContext } from '@playwright/test';
import { createPostgresDataStore, type CapableDataStore } from '../packages/shared/src/data/postgres/store';
import { PARTICIPANT_SESSION_COOKIE } from '../packages/shared/src/security/participant-session';

/**
 * Talking to the real acceptance environment.
 *
 * These helpers reach the same Postgres and Supabase project the running server
 * uses. Nothing here is a mock: the point of the acceptance suite is to prove
 * the product against the infrastructure it will run on, so a fake store would
 * defeat it entirely.
 *
 * **Secrets never leave this process.** Access codes exist in memory only for as
 * long as a test needs them, are never written to disk, and are never logged.
 * Where a test must show that a code was used, it asserts on the outcome rather
 * than the value.
 */

let cached: CapableDataStore | null = null;

function loadEnvOnce(): void {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key) process.env[key] ??= (value ?? '').trim();
  }
}

export async function acceptanceStore(): Promise<CapableDataStore> {
  if (cached) return cached;
  loadEnvOnce();
  cached = await createPostgresDataStore({
    databaseUrl: process.env.DATABASE_URL!,
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY!,
    sessionSecret: process.env.ADMIN_SESSION_SECRET!,
    credentialKey: process.env.CREDENTIAL_ENCRYPTION_KEY!,
    credentialKeyVersion: Number(process.env.CREDENTIAL_KEY_VERSION ?? 1),
    maxConnections: 4,
  });
  return cached;
}

/** The cohort under test: the single learner-facing one. */
export async function acceptanceCohort() {
  const store = await acceptanceStore();
  const cohort = await store.cohorts.findActiveCohort();
  if (!cohort) throw new Error('No learner-facing cohort — the acceptance suite has nothing to test.');
  return cohort;
}

export async function teamByGroup(groupNumber: number) {
  const cohort = await acceptanceCohort();
  const teams = await (await acceptanceStore()).teams.listTeams(cohort.id);
  const team = teams.find((t) => t.groupNumber === groupNumber);
  if (!team) throw new Error(`Group ${groupNumber} does not exist in ${cohort.name}.`);
  return team;
}

/**
 * Sign a browser context in as a team, without its access code.
 *
 * The plaintext code cannot be recovered — only an Argon2id hash is stored, by
 * design — so a suite that needs a signed-in browser has two honest options:
 * rotate the code to learn a new one, or mint the session the login flow would
 * have minted. This does the second, because rotating group 901's code to run a
 * test would invalidate the sheet already issued for it.
 *
 * The session is created through the production store, so it is indistinguishable
 * from one produced by signing in. Code VERIFICATION is tested separately, with
 * real codes, in `verifyWithCode`.
 */
export async function signInAs(
  context: BrowserContext,
  groupNumber: number,
  editorName: string,
): Promise<{ token: string; teamId: string }> {
  const store = await acceptanceStore();
  const team = await teamByGroup(groupNumber);

  const session = await store.participant.createSession({
    teamId: team.id,
    editorName,
    editorRole: null,
    ipHash: null,
  });

  await context.addCookies([
    {
      name: PARTICIPANT_SESSION_COOKIE,
      value: session.token,
      domain: 'localhost',
      path: '/submit',
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 8,
    },
  ]);

  return { token: session.token, teamId: team.id };
}

/**
 * Issue a fresh access code for a team and return it.
 *
 * The only way to obtain a usable plaintext code: generation is the one moment
 * it exists. Used for the credential tests, and for the rotation test where
 * replacing the code IS the behaviour under examination.
 *
 * The returned value is a live credential. Keep it in a variable, pass it to a
 * form, and never write it anywhere.
 */
export async function issueCodeFor(groupNumber: number): Promise<string> {
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();
  const team = await teamByGroup(groupNumber);

  const [issued] = await store.teams.generateAccessCodes({
    cohortId: cohort.id,
    teamIds: [team.id],
    regenerate: true,
  });
  if (!issued) throw new Error(`Could not issue a code for group ${groupNumber}.`);
  return issued.code;
}

/** Live code version per group, for asserting that only the intended team rotated. */
export async function codeVersions(): Promise<Record<number, number>> {
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();
  const status = await store.teams.listAccessCodeStatus(cohort.id);
  return Object.fromEntries(status.map((s) => [s.groupNumber, s.version]));
}

/** How many live sessions a team has. Used to prove rotation revoked them. */
export async function liveSessionCount(groupNumber: number): Promise<number> {
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();
  const status = await store.teams.listAccessCodeStatus(cohort.id);
  return status.find((s) => s.groupNumber === groupNumber)?.activeSessions ?? 0;
}

/**
 * Drive the real two-step entry form.
 *
 * Used where the credential path itself is under test. The code is typed into
 * the page and never appears in a log or an assertion message.
 */
export async function verifyWithCode(
  context: BrowserContext,
  groupNumber: number,
  code: string,
  editorName?: string,
): Promise<{ accepted: boolean; message: string }> {
  /**
   * Clear the lockout when the caller expects to get in.
   *
   * This suite submits wrong codes deliberately, and eight in fifteen minutes
   * locks a group out — the limiter working exactly as designed. Across a full
   * run those attempts accumulate on one IP and one group, so whichever test
   * happens to need a successful sign-in next fails for a reason that has
   * nothing to do with it. The failure moved between tests on consecutive runs,
   * which is what gave it away.
   *
   * Only the success path clears it. Attempts that assert a rejection are
   * untouched, so the limiter is still exercised by the tests that care about
   * it.
   */
  if (editorName) await clearLockout(groupNumber);

  const page = await context.newPage();
  try {
    await page.goto('/submit');

    // A context may already hold a session; the form only renders when signed out.
    const signOut = page.getByRole('button', { name: /Sign out to use a different group/i });
    if (await signOut.count()) {
      await signOut.click();
      await page.waitForURL(/\/submit$/);
    }

    await page.getByLabel('Group number').fill(String(groupNumber));
    await page.getByLabel('Team access code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();

    const nameField = page.getByLabel('Your name');
    const accepted = await nameField
      // Generous, because this runs against `next dev`: the first request to a
      // route compiles it, and a short wait turns that into a false rejection.
      .waitFor({ state: 'visible', timeout: 25_000 })
      .then(() => true)
      .catch(() => false);

    if (!accepted) {
      const alert = page.getByRole('alert').first();
      const message = (await alert.count()) ? ((await alert.textContent()) ?? '') : '';
      return { accepted: false, message: message.trim() };
    }

    if (editorName) {
      await nameField.fill(editorName);
      // Confirm React committed the value before submitting. Filling and
      // clicking in the same tick can submit an empty name, which the server
      // rejects — and the form then sits on the editor step looking idle.
      await expect(nameField).toHaveValue(editorName, { timeout: 10_000 });

      const open = page.getByRole('button', { name: 'Open our submission' });
      await expect(open).toBeEnabled({ timeout: 10_000 });
      await open.click();

      const reachedPortal = await page
        .waitForURL(/\/submit\/portal/, { timeout: 45_000 })
        .then(() => true)
        .catch(() => false);

      if (!reachedPortal) {
        // The alert the form renders on a failed editor step, which is the only
        // place the reason appears.
        const alertText = await page
          .locator('[role="alert"], .text-danger')
          .first()
          .textContent()
          .catch(() => null);
        if (alertText) {
          return { accepted: false, message: `editor step refused: ${alertText.trim()}` };
        }
        // Report why rather than timing out blind: the editor step has its own
        // failure modes (an expired verification handle, a closed window) and a
        // bare timeout hides which one occurred.
        const body = ((await page.locator('body').innerText()) ?? '').replace(/\s+/g, ' ').trim();
        return {
          accepted: false,
          message: `verified, but the editor step did not open the portal. Page said: "${body.slice(0, 400)}"`,
        };
      }
    }
    return { accepted: true, message: '' };
  } finally {
    await page.close();
  }
}

/**
 * Is group 901 still editable?
 *
 * The acceptance suite is a one-way sequence: several tests describe the state
 * before final submission, and final submission is irreversible. Once it has
 * happened those tests are not failing — they are no longer applicable, and a
 * red result would say something untrue about the product.
 */
export async function group901IsDraft(): Promise<boolean> {
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();
  const submissions = await store.submissions.listSubmissions(cohort.id);
  return submissions.find((s) => s.team.groupNumber === 901)?.submission.status === 'draft';
}

/**
 * Clear a verification lockout.
 *
 * Eight wrong codes in fifteen minutes locks a group out — correct behaviour,
 * and this suite deliberately submits wrong codes, so it locks itself out. This
 * is the same operator action the admin screen offers, and calling it before an
 * attempt that must succeed keeps the rate limiter from masking a real result.
 */
export async function clearLockout(groupNumber: number): Promise<void> {
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();
  await store.teams.clearVerificationLockout(cohort.id, groupNumber);
}

/** Set the cohort status through the store, mirroring what the admin control does. */
export async function setCohortStatus(status: 'open' | 'paused' | 'closed'): Promise<void> {
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();
  await store.cohorts.setCohortStatus(cohort.id, status);
}

export async function closeStore(): Promise<void> {
  cached = null;
}
