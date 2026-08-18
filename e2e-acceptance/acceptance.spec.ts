import { expect, test, type BrowserContext } from '@playwright/test';
import {
  acceptanceCohort,
  acceptanceStore,
  clearLockout,
  group901IsDraft,
  codeVersions,
  issueCodeFor,
  liveSessionCount,
  setCohortStatus,
  signInAs,
  teamByGroup,
  verifyWithCode,
} from './support';

/**
 * The acceptance run, automated.
 *
 * Real browser contexts against the real acceptance server, backed by the real
 * Postgres project and real Supabase Storage. Nothing is mocked, because the
 * question being answered is whether the product works on the infrastructure it
 * will actually run on — which a fake store cannot tell us.
 *
 * Group 901 carries the acceptance submission and must survive intact. Group 902
 * is the disposable team: isolation, rotation and lifecycle writes go through it
 * wherever a test would otherwise disturb 901.
 *
 * Serial by necessity. These tests share one cohort and change its status.
 */

test.describe.configure({ mode: 'serial' });

/** Something distinctive from group 901's draft, used to detect leakage. */
const GROUP_901_MARKER = 'FitTrack';

// --------------------------------------------------------------------------
// 1. Post-restart persistence
// --------------------------------------------------------------------------

test.describe('1. persistence across a server restart', () => {
  test('group 901 is still a draft with everything it had', async () => {
    const store = await acceptanceStore();
    const team = await teamByGroup(901);
    const cohort = await acceptanceCohort();

    const submissions = await store.submissions.listSubmissions(cohort.id);
    const mine = submissions.find((s) => s.team.groupNumber === 901);

    expect(mine, 'group 901 must still have a submission').toBeDefined();
    // Draft before Batch 5, locked after. Both are healthy; what must never
    // happen is the submission disappearing or losing its team.
    expect(['draft', 'locked', 'submitted']).toContain(mine!.submission.status);
    expect(team.members.length).toBeGreaterThan(0);
  });

  test('the deck is attached exactly once and the object is really there', async () => {
    const store = await acceptanceStore();
    const cohort = await acceptanceCohort();
    const submissions = await store.submissions.listSubmissions(cohort.id);
    const mine = submissions.find((s) => s.team.groupNumber === 901)!;

    const detail = await store.submissions.getSubmissionDetail(mine.submission.id);
    const decks = detail!.artifacts.filter((a) => a.kind === 'deck_pdf');
    const videos = detail!.artifacts.filter((a) => a.kind === 'demo_video');

    expect(decks, 'exactly one deck, never a duplicate').toHaveLength(1);
    expect(videos, 'exactly one demo video').toHaveLength(1);
    expect(videos[0]!.externalUrl).toBeTruthy();

    // The bytes, not just the row. This is the check that would have caught the
    // upload defect found earlier in the acceptance run.
    const url = await store.resources.getSignedUrl(
      decks[0]!.storageBucket!,
      decks[0]!.storagePath!,
      120,
    );
    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(bytes.byteLength).toBe(decks[0]!.byteSize);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  test('the portal renders the saved work after the restart', async ({ browser }) => {
    const context = await browser.newContext();
    await signInAs(context, 901, 'Acceptance Bot');
    const page = await context.newPage();

    await page.goto('/submit/portal');
    // Content rather than visible text: the saved answers live in input values,
    // which `getByText` cannot see.
    expect(page.url()).toContain('/submit/portal');
    expect(await page.content()).toContain(GROUP_901_MARKER);

    await context.close();
  });
});

// --------------------------------------------------------------------------
// 2. Cross-team isolation
// --------------------------------------------------------------------------

test.describe('2. cross-team isolation', () => {
  test('group 902 sees nothing belonging to group 901', async ({ browser }) => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    await signInAs(a, 901, 'Alpha One');
    await signInAs(b, 902, 'Beta One');

    const pageA = await a.newPage();
    await pageA.goto('/submit/portal');
    expect(await pageA.content(), 'group 901 must see its own work').toContain(GROUP_901_MARKER);

    const pageB = await b.newPage();
    await pageB.goto('/submit/portal');
    const html = await pageB.content();

    expect(html, 'group 901 product name leaked into 902').not.toContain(GROUP_901_MARKER);
    expect(html, 'a 901 artifact filename leaked').not.toContain('AIAP_');
    expect(html, 'a 901 editor name leaked').not.toContain('Alpha One');
    expect(html, 'group 902 must be told which team it is').toContain('902');

    await a.close();
    await b.close();
  });

  test('the isolation check would notice a leak', async ({ browser }) => {
    // Guards the guard. If the marker never appears anywhere, the assertion
    // above passes for the wrong reason and proves nothing.
    const a = await browser.newContext();
    await signInAs(a, 901, 'Alpha One');
    const page = await a.newPage();
    await page.goto('/submit/portal');

    expect(await page.content(), 'the marker must be present for 901').toContain(GROUP_901_MARKER);
    await a.close();
  });

  test('no judging data reaches either team', async ({ browser }) => {
    for (const group of [901, 902]) {
      const context = await browser.newContext();
      await signInAs(context, group, 'Privacy Check');
      const page = await context.newPage();
      await page.goto('/submit/portal');
      const html = await page.content();

      for (const forbidden of ['shortlist', 'tiebreak', 'rubricScore', 'meanConfidence']) {
        expect(html.toLowerCase(), `group ${group} was shown "${forbidden}"`).not.toContain(
          forbidden.toLowerCase(),
        );
      }
      await context.close();
    }
  });
});

// --------------------------------------------------------------------------
// 3. Credentials
// --------------------------------------------------------------------------

test.describe('3. access codes', () => {
  // Issued once for the whole describe. Never logged, never written to disk.
  let code902: string;

  test.beforeAll(async () => {
    code902 = await issueCodeFor(902);
  });

  test('a genuine code is refused against another group', async ({ browser }) => {
    // The property reported during the manual run. A real, live code — used
    // against the wrong group number — must be rejected.
    for (const wrongGroup of [901, 999]) {
      const context = await browser.newContext();
      const result = await verifyWithCode(context, wrongGroup, code902);

      expect(result.accepted, `group ${wrongGroup} accepted group 902's code`).toBe(false);
      await context.close();
    }
  });

  test('the same code is accepted by its own group', async ({ browser }) => {
    // The suite has just submitted wrong codes on purpose, which is exactly what
    // the lockout is for. Clear it so the rate limiter does not mask the result.
    await clearLockout(902);
    const context = await browser.newContext();
    const result = await verifyWithCode(context, 902, code902, 'Beta One');

    expect(result.accepted, result.message).toBe(true);
    await context.close();
  });

  test('a wrong code and an unknown group give the same answer', async ({ browser }) => {
    const wrongCode = await (async () => {
      const context = await browser.newContext();
      const r = await verifyWithCode(context, 902, 'ZZZZ-ZZZZ-ZZZZ');
      await context.close();
      return r;
    })();

    const unknownGroup = await (async () => {
      const context = await browser.newContext();
      const r = await verifyWithCode(context, 777, 'ZZZZ-ZZZZ-ZZZZ');
      await context.close();
      return r;
    })();

    expect(wrongCode.accepted).toBe(false);
    expect(unknownGroup.accepted).toBe(false);
    expect(
      unknownGroup.message,
      'a different message for an unknown group would enumerate the cohort',
    ).toBe(wrongCode.message);
  });
});

// --------------------------------------------------------------------------
// 4. Same-team collaboration
// --------------------------------------------------------------------------

test.describe('4. two people editing one submission', () => {
  test('a stale write is refused rather than silently overwriting', async ({ browser }) => {
    // Describes an editable submission. After Batch 5 group 901 is locked and
    // every write is refused for a different, correct reason.
    test.skip(!(await group901IsDraft()), 'group 901 is final-submitted — conflict handling needs a draft');

    const store = await acceptanceStore();
    const cohort = await acceptanceCohort();
    const submissions = await store.submissions.listSubmissions(cohort.id);
    const mine = submissions.find((s) => s.team.groupNumber === 901)!;
    const before = await store.submissions.getSubmissionDetail(mine.submission.id);
    const original = before!.submission.knownLimitations ?? '';

    const a = await browser.newContext();
    const b = await browser.newContext();
    const alphaOne = await signInAs(a, 901, 'Alpha One');
    const alphaTwo = await signInAs(b, 901, 'Alpha Two');

    // Both read the same version — the situation two people in a room are in.
    const viewOne = await store.participant.resolveSession(alphaOne.token);
    const viewTwo = await store.participant.resolveSession(alphaTwo.token);
    const sharedVersion = viewOne!.submission.version;
    expect(viewTwo!.submission.version).toBe(sharedVersion);

    // Alpha Two saves first and wins.
    const winner = await store.participant.saveDraft(
      alphaTwo.token,
      { live: { knownLimitations: 'Written by Alpha Two during the acceptance run.' } },
      sharedVersion,
    );
    expect(winner.ok, 'the first writer must succeed').toBe(true);

    // Alpha One saves against the version they read, which is now stale.
    const loser = await store.participant.saveDraft(
      alphaOne.token,
      { live: { knownLimitations: 'Written by Alpha One and should NOT win.' } },
      sharedVersion,
    );

    expect(loser.ok, 'a stale write must not be accepted').toBe(false);
    expect(loser.conflict, 'the refusal must say it was a conflict').toBeTruthy();
    expect(
      loser.conflict!.message.length,
      'the conflict must explain itself to the person who lost the race',
    ).toBeGreaterThan(0);

    // The newer value survived.
    const after = await store.submissions.getSubmissionDetail(mine.submission.id);
    expect(after!.submission.knownLimitations).toContain('Alpha Two');

    // Both browsers converge on the same value once reloaded.
    for (const [context, label] of [
      [a, 'Alpha One'],
      [b, 'Alpha Two'],
    ] as [BrowserContext, string][]) {
      const page = await context.newPage();
      await page.goto('/submit/portal');
      expect(await page.content(), label).toContain('Alpha Two during the acceptance run');
      await page.close();
    }

    // Put the submission back the way the acceptance run left it.
    const latest = await store.participant.resolveSession(alphaTwo.token);
    const restored = await store.participant.saveDraft(
      alphaTwo.token,
      { live: { knownLimitations: original } },
      latest!.submission.version,
    );
    expect(restored.ok, 'the original value must be restorable').toBe(true);

    const final = await store.submissions.getSubmissionDetail(mine.submission.id);
    expect(final!.submission.knownLimitations).toBe(original);

    await a.close();
    await b.close();
  });

  test('the submission records who last changed it', async () => {
    // Depends on the conflict test above having run, which needs a draft.
    test.skip(!(await group901IsDraft()), 'group 901 is final-submitted — the last editor is now the submitter');

    // `saveDraft` stamps `lastEditedBy`, which is what tells a team who touched
    // their work last. Timeline entries are written separately by the web
    // action layer (`recordActivity`) and are covered by the hermetic e2e
    // suite — this test drives the store directly, so it asserts what the store
    // itself guarantees.
    const store = await acceptanceStore();
    const cohort = await acceptanceCohort();
    const submissions = await store.submissions.listSubmissions(cohort.id);
    const mine = submissions.find((s) => s.team.groupNumber === 901)!;

    const detail = await store.submissions.getSubmissionDetail(mine.submission.id);
    expect(detail!.submission.lastEditedBy, 'the winning editor must be recorded').toBe('Alpha Two');
  });
});

// --------------------------------------------------------------------------
// 5. Group 902 draft
// --------------------------------------------------------------------------

test.describe('5. group 902 draft', () => {
  test('is created and persists', async ({ browser }) => {
    const context = await browser.newContext();
    const { token } = await signInAs(context, 902, 'Beta One');
    const store = await acceptanceStore();

    const view = await store.participant.resolveSession(token);
    const saved = await store.participant.saveDraft(
      token,
      { product: { productName: 'Acceptance 902 Test' } },
      view!.submission.version,
    );
    expect(saved.ok).toBe(true);

    const reread = await store.participant.resolveSession(token);
    expect(reread!.submission.productName).toBe('Acceptance 902 Test');

    await context.close();
  });
});

// --------------------------------------------------------------------------
// 6. Cohort lifecycle
// --------------------------------------------------------------------------

test.describe('6. lifecycle', () => {
  test.afterAll(async () => {
    // Whatever happens, the cohort must be left usable.
    await setCohortStatus('open');
  });

  test('pausing blocks writes at the server, not just in the interface', async ({ browser }) => {
    const context = await browser.newContext();
    const { token } = await signInAs(context, 901, 'Alpha One');
    const store = await acceptanceStore();

    await setCohortStatus('paused');

    const view = await store.participant.resolveSession(token);
    expect(view, 'a paused cohort must still let a team read their work').not.toBeNull();
    expect(view!.canEdit).toBe(false);
    expect(view!.windowMessage.length, 'the refusal must explain itself').toBeGreaterThan(0);

    const blocked = await store.participant.saveDraft(
      token,
      { live: { knownLimitations: 'should not persist' } },
      view!.submission.version,
    );
    expect(blocked.ok, 'a write during a pause must be refused server-side').toBe(false);

    // And the draft is untouched.
    const after = await store.participant.resolveSession(token);
    expect(after!.submission.knownLimitations).toBe(view!.submission.knownLimitations);

    const page = await context.newPage();
    await page.goto('/submit/portal');
    expect(await page.content(), 'work stays readable while paused').toContain(GROUP_901_MARKER);

    await context.close();
  });

  test('resuming restores editing with nothing lost', async ({ browser }) => {
    test.skip(!(await group901IsDraft()), 'group 901 is final-submitted — editing is correctly closed');
    const context = await browser.newContext();
    const { token } = await signInAs(context, 901, 'Alpha One');
    const store = await acceptanceStore();

    await setCohortStatus('open');

    const view = await store.participant.resolveSession(token);
    expect(view!.canEdit).toBe(true);
    expect(view!.submission.productName).toBeTruthy();

    await context.close();
  });

  test('closing blocks both editing and final submit', async ({ browser }) => {
    const context = await browser.newContext();
    const { token } = await signInAs(context, 901, 'Alpha One');
    const store = await acceptanceStore();

    await setCohortStatus('closed');

    const view = await store.participant.resolveSession(token);
    expect(view!.canEdit).toBe(false);
    expect(view!.canSubmit, 'final submit must be refused once closed').toBe(false);

    const blockedSave = await store.participant.saveDraft(
      token,
      { live: { knownLimitations: 'should not persist' } },
      view!.submission.version,
    );
    expect(blockedSave.ok).toBe(false);

    const blockedSubmit = await store.participant.finaliseSubmission(token, { ipHash: null });
    expect(blockedSubmit.ok, 'a closed cohort must refuse a final submit').toBe(false);

    // Whatever the status was, the refused attempt did not change it.
    const after = await store.participant.resolveSession(token);
    expect(after!.submission.status).toBe(view!.submission.status);

    await context.close();
  });

  test('reopening restores everything', async ({ browser }) => {
    test.skip(!(await group901IsDraft()), 'group 901 is final-submitted — editing is correctly closed');
    const context = await browser.newContext();
    const { token } = await signInAs(context, 901, 'Alpha One');
    const store = await acceptanceStore();

    await setCohortStatus('open');

    const view = await store.participant.resolveSession(token);
    expect(view!.canEdit).toBe(true);
    expect(view!.submission.status).toBe('draft');
    expect(view!.artifacts.filter((a) => a.kind === 'deck_pdf')).toHaveLength(1);

    await context.close();
  });
});

// --------------------------------------------------------------------------
// 7. Code rotation
// --------------------------------------------------------------------------

test.describe('7. rotating one team code', () => {
  test('revokes that team only, and preserves their work', async ({ browser }) => {
    const before = await codeVersions();

    // A live session for 902, which rotation must end.
    const context = await browser.newContext();
    const { token } = await signInAs(context, 902, 'Beta One');
    const store = await acceptanceStore();
    expect(await store.participant.resolveSession(token), 'session must start valid').not.toBeNull();

    const oldCode = await issueCodeFor(902);
    const oldSessionsAfterFirst = await liveSessionCount(902);
    expect(oldSessionsAfterFirst, 'issuing a code signs the team out').toBe(0);

    // Sign back in with the code we just issued, then rotate again — this is the
    // rotation under test, with a session that was created from a real code.
    const signedIn = await browser.newContext();
    await clearLockout(902);
    const signInResult = await verifyWithCode(signedIn, 902, oldCode, 'Beta One');
    expect(signInResult.accepted, signInResult.message).toBe(true);

    const newCode = await issueCodeFor(902);

    const after = await codeVersions();
    expect(after[902], 'group 902 must advance').toBe(before[902]! + 2);
    expect(after[901], 'group 901 must not rotate').toBe(before[901]);
    expect(after[999], 'group 999 must not rotate').toBe(before[999]);

    // The old code no longer opens anything.
    const withOld = await browser.newContext();
    expect((await verifyWithCode(withOld, 902, oldCode)).accepted, 'a superseded code must fail').toBe(
      false,
    );
    await withOld.close();

    // The new one does.
    await clearLockout(902);
    const withNew = await browser.newContext();
    const withNewResult = await verifyWithCode(withNew, 902, newCode, 'Beta One');
    expect(withNewResult.accepted, withNewResult.message).toBe(true);
    await withNew.close();

    // And the work survived both rotations.
    const cohort = await acceptanceCohort();
    const submissions = await store.submissions.listSubmissions(cohort.id);
    const team902 = submissions.find((s) => s.team.groupNumber === 902);
    expect(team902, 'group 902 must still have its submission').toBeDefined();
    const detail = await store.submissions.getSubmissionDetail(team902!.submission.id);
    expect(detail!.submission.productName).toBe('Acceptance 902 Test');

    await context.close();
    await signedIn.close();
  });

  test('leaves group 901 able to work', async ({ browser }) => {
    // The point of rotating only one team: everyone else is undisturbed.
    test.skip(!(await group901IsDraft()), 'group 901 is final-submitted — editing is correctly closed');
    const context = await browser.newContext();
    const { token } = await signInAs(context, 901, 'Alpha One');
    const store = await acceptanceStore();

    const view = await store.participant.resolveSession(token);
    expect(view!.canEdit).toBe(true);
    expect(view!.submission.status).toBe('draft');

    await context.close();
  });
});

// --------------------------------------------------------------------------
// 8. Final state
// --------------------------------------------------------------------------

test.describe('8. the cohort is left usable', () => {
  test('is open, with group 901 intact', async () => {
    const cohort = await acceptanceCohort();
    expect(cohort.status).toBe('open');

    const store = await acceptanceStore();
    const submissions = await store.submissions.listSubmissions(cohort.id);
    const mine = submissions.find((s) => s.team.groupNumber === 901)!;

    expect(['draft', 'locked', 'submitted']).toContain(mine.submission.status);

    const detail = await store.submissions.getSubmissionDetail(mine.submission.id);
    expect(detail!.artifacts.filter((a) => a.kind === 'deck_pdf')).toHaveLength(1);
    expect(detail!.artifacts.filter((a) => a.kind === 'demo_video')).toHaveLength(1);
  });
});
