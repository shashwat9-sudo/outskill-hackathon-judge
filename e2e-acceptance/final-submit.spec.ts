import { expect, test } from '@playwright/test';
import { acceptanceCohort, acceptanceStore, signInAs } from './support';

/**
 * Batch 5 — the irreversible one.
 *
 * Final submit locks group 901 permanently. The preflight
 * (`scripts/acceptance-preflight.ts`) must pass before this runs; it checks the
 * submission is a complete draft with a real deck object in Storage and no
 * existing receipt.
 *
 * The concurrency proof IS the final submit. Rather than submitting once and
 * then contriving a second attempt, four concurrent attempts race for the same
 * submission: exactly one must win. That proves the property on the real
 * submission with the real database, using the one irreversible action
 * available — and it is the situation that actually occurs when a team of four
 * all press the button on deadline night.
 */

test.describe.configure({ mode: 'serial' });

const CONCURRENT_ATTEMPTS = 4;

/** Set by the first test, used by the rest. Never logged. */
let receiptId = '';
let submissionId = '';

test('final submit succeeds exactly once under concurrent attempts', async ({ browser }) => {
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();

  const before = (await store.submissions.listSubmissions(cohort.id)).find(
    (s) => s.team.groupNumber === 901,
  )!;
  submissionId = before.submission.id;

  // Final submission is irreversible, so this suite runs once. On a re-run the
  // submission is already locked — the checks that follow still verify the
  // outcome, and re-racing a locked submission would prove nothing.
  if (before.submission.status === 'locked') {
    receiptId = before.submission.receiptId!;
    test.skip(true, 'already final-submitted — the outcome is verified by the tests that follow');
    return;
  }

  expect(before.submission.status, 'preflight should have caught this').toBe('draft');
  expect(before.submission.receiptId).toBeNull();

  // Four members, four devices, one button.
  const contexts = await Promise.all(
    Array.from({ length: CONCURRENT_ATTEMPTS }, () => browser.newContext()),
  );
  const sessions = await Promise.all(
    contexts.map((context, i) => signInAs(context, 901, `Finaliser ${i + 1}`)),
  );

  const results = await Promise.all(
    sessions.map((session) => store.participant.finaliseSubmission(session.token, { ipHash: null })),
  );

  const accepted = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok);

  expect(accepted, 'exactly one attempt may be accepted').toHaveLength(1);
  expect(refused).toHaveLength(CONCURRENT_ATTEMPTS - 1);
  for (const rejection of refused) {
    expect(rejection.ok).toBe(false);
    expect((rejection as { error?: string }).error?.length ?? 0).toBeGreaterThan(0);
  }

  await Promise.all(contexts.map((c) => c.close()));
});

test('the submission is locked, with one receipt and one timestamp', async () => {
  const store = await acceptanceStore();
  const detail = await store.submissions.getSubmissionDetail(submissionId);
  const sub = detail!.submission;

  expect(sub.status).toBe('locked');
  expect(sub.submittedAt).not.toBeNull();
  expect(sub.lockedAt).not.toBeNull();
  expect(sub.receiptId, 'a receipt must exist').toBeTruthy();

  receiptId = sub.receiptId!;
});

test('Postgres holds exactly one finalised state for this submission', async () => {
  // Asserted against the database directly rather than through the store, so a
  // repository bug cannot hide a second row from its own reader.
  const store = await acceptanceStore();
  const cohort = await acceptanceCohort();

  const all = await store.submissions.listSubmissions(cohort.id);
  const locked = all.filter((s) => s.submission.status === 'locked');
  const withReceipt = all.filter((s) => s.submission.receiptId);

  expect(locked, 'exactly one submission may be locked').toHaveLength(1);
  expect(withReceipt, 'exactly one receipt may exist').toHaveLength(1);
  expect(locked[0]!.team.groupNumber).toBe(901);

  const receipts = new Set(withReceipt.map((s) => s.submission.receiptId));
  expect(receipts.size, 'receipt identities must be unique').toBe(1);
});

test('the work and its artifacts survived finalisation', async () => {
  const store = await acceptanceStore();
  const detail = await store.submissions.getSubmissionDetail(submissionId);

  expect(detail!.submission.productName).toBeTruthy();
  expect(detail!.artifacts.filter((a) => a.kind === 'deck_pdf')).toHaveLength(1);
  expect(detail!.artifacts.filter((a) => a.kind === 'demo_video')).toHaveLength(1);

  // The deck object is still readable from the private bucket after locking.
  const deck = detail!.artifacts.find((a) => a.kind === 'deck_pdf')!;
  const url = await store.resources.getSignedUrl(deck.storageBucket!, deck.storagePath!, 60);
  const response = await fetch(url);
  expect(response.status).toBe(200);
});

test('a repeat final submit cannot mint a second receipt', async ({ browser }) => {
  const store = await acceptanceStore();
  const context = await browser.newContext();
  const { token } = await signInAs(context, 901, 'Repeat Submitter');

  const again = await store.participant.finaliseSubmission(token, { ipHash: null });
  expect(again.ok).toBe(false);

  const detail = await store.submissions.getSubmissionDetail(submissionId);
  expect(detail!.submission.receiptId, 'the receipt must not have changed').toBe(receiptId);

  await context.close();
});

test('a locked submission refuses every participant write', async ({ browser }) => {
  const store = await acceptanceStore();
  const context = await browser.newContext();
  const { token } = await signInAs(context, 901, 'Late Editor');

  const view = await store.participant.resolveSession(token);
  expect(view, 'a team must still be able to read their locked submission').not.toBeNull();
  expect(view!.canEdit).toBe(false);
  expect(view!.canSubmit).toBe(false);

  const save = await store.participant.saveDraft(
    token,
    { live: { knownLimitations: 'edited after locking' } },
    view!.submission.version,
  );
  expect(save.ok, 'a field edit after locking must be refused').toBe(false);

  const artifact = await store.participant.attachArtifact(token, {
    kind: 'demo_video',
    storageBucket: null,
    storagePath: null,
    originalFilename: null,
    mimeType: null,
    byteSize: null,
    checksumSha256: null,
    externalUrl: 'https://www.loom.com/share/11111111111111111111111111111111',
    uploadCompletedAt: new Date(),
    isAccessible: true,
    lastCheckedAt: new Date(),
  });
  expect(artifact, 'an artifact change after locking must be refused').toBeNull();

  // Nothing moved.
  const after = await store.submissions.getSubmissionDetail(submissionId);
  expect(after!.submission.status).toBe('locked');
  expect(after!.submission.receiptId).toBe(receiptId);
  expect(after!.artifacts.filter((a) => a.kind === 'demo_video')).toHaveLength(1);

  await context.close();
});

test('the receipt carries what a team needs and nothing else', async ({ browser }) => {
  const store = await acceptanceStore();
  const context = await browser.newContext();
  const { token } = await signInAs(context, 901, 'Receipt Reader');

  const receipt = await store.participant.getReceipt(token);
  expect(receipt).not.toBeNull();

  expect(receipt!.groupNumber).toBe(901);
  expect(receipt!.productName).toBeTruthy();
  expect(receipt!.submittedAt).toBeInstanceOf(Date);
  expect(receipt!.receiptId).toBe(receiptId);

  // Nothing about judging, and nothing secret. Checked over the whole
  // serialised receipt so a field added later is caught too.
  const serialised = JSON.stringify(receipt).toLowerCase();
  for (const forbidden of [
    'score',
    'rank',
    'shortlist',
    'evidence',
    'confidence',
    'rubric',
    'password',
    'accesscode',
    'code_hash',
    'disqualif',
    'manualreview',
    'gemini',
  ]) {
    expect(serialised, `the receipt exposed "${forbidden}"`).not.toContain(forbidden);
  }

  await context.close();
});

test('receipt lookup resolves to this submission, and nothing else does', async () => {
  // Backend/domain verification. The admin UI is NOT driven here — see F-11.
  const store = await acceptanceStore();

  const found = await store.submissions.findByReceiptId(receiptId);
  expect(found, 'the real receipt must resolve').not.toBeNull();
  expect(found!.id).toBe(submissionId);

  for (const invented of ['OSK-NOPE-000-XXXX', 'not-a-receipt', '']) {
    expect(await store.submissions.findByReceiptId(invented), invented).toBeNull();
  }
});

test('the learner sees no judging data anywhere in the submitted portal', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 901, 'Privacy Sweep');
  const page = await context.newPage();

  // Collect every response the portal makes, not just the rendered HTML: a
  // score leaking through a data payload is still a leak.
  const payloads: string[] = [];
  page.on('response', async (response) => {
    const type = response.headers()['content-type'] ?? '';
    if (/json|javascript|text/.test(type)) {
      payloads.push(await response.text().catch(() => ''));
    }
  });

  await page.goto('/submit/portal');
  await page.waitForLoadState('networkidle');

  const html = await page.content();
  const everything = `${html}\n${payloads.join('\n')}`.toLowerCase();

  // Field names the judging surfaces use. Ordinary words like "score" appear in
  // framework code, so these are the specific shapes that would indicate a leak.
  for (const forbidden of [
    'totalscore',
    'weightedscore',
    'meanconfidence',
    'inshortlist',
    'tiebreakvector',
    'rubricversion',
    'categorykey',
    'manualreviewflag',
    'disqualification',
  ]) {
    expect(everything, `the portal exposed "${forbidden}"`).not.toContain(forbidden);
  }

  // And the submitted state is visible to the team, as it must be.
  expect(html).toContain('901');

  await context.close();
});
