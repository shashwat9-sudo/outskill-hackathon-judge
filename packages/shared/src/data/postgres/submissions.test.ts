import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildCohortStore } from './repositories/admin';
import { buildTeamStore } from './repositories/teams';
import { createInMemoryStorage } from './storage';
import { buildParticipantStore } from './repositories/participant';
import { buildSubmissionStore } from './repositories/submissions';
import type { AssessmentConfig } from '../types';
import type { CohortStore, ParticipantStore, SubmissionStore, TeamStore } from '../store';

/**
 * The submission lifecycle, end to end, against a real Postgres engine.
 *
 * The two tests that matter most are the concurrency proofs: a stale draft save
 * must be refused without losing the winner's work, and two simultaneous final
 * submits must produce exactly one receipt.
 */

let db: PgliteHandle;
let participant: ParticipantStore;
let submissions: SubmissionStore;
let cohorts: CohortStore;
let teams: TeamStore;

const CREDENTIAL_KEY = randomBytes(32).toString('base64');

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v1', 'Test', true)`,
  );
  participant = buildParticipantStore({
    db,
    storage: createInMemoryStorage(),
    sessionSecret: 'test-secret',
    credentialKey: CREDENTIAL_KEY,
    credentialKeyVersion: 1,
  });
  submissions = buildSubmissionStore({ db, credentialKey: CREDENTIAL_KEY });
  cohorts = buildCohortStore(db);
  teams = buildTeamStore(db);
});

const CONFIG: AssessmentConfig = {
  workerConcurrency: 4,
  browserBudgetMs: 480_000,
  maxAttempts: 3,
  retryBackoffMs: 60_000,
  gracePeriodMs: 3_600_000,
  consistencyTopN: 20,
  lowConfidenceThreshold: 0.6,
  modelVersion: 'test',
  promptVersion: 'test',
};

/** An open cohort, one team with a code, and an approved idea. */
async function scenario() {
  const cohort = await cohorts.createCohort({
    name: 'Test cohort',
    code: 'TEST',
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: new Date(Date.now() - 86_400_000),
    day13DeadlineAt: new Date(Date.now() + 86_400_000),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: 'rubric-v1',
    assessmentConfig: CONFIG,
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
  });
  await cohorts.setCohortStatus(cohort.id, 'open');

  const idea = await cohorts.createIdea({
    cohortId: cohort.id,
    title: 'Recipe sharing',
    slug: 'recipe-sharing',
    description: '',
    targetUser: '',
    expectedUseCase: '',
    minimumCoreFlow: [],
    expectedEntities: [],
    aiOpportunity: '',
    allowedScope: '',
    unsafeInterpretations: '',
    displayOrder: 1,
    isActive: true,
    definitionStatus: 'approved',
    definitionApprovedAt: new Date(),
    definitionApprovedBy: 'test',
  });

  await teams.importTeams(cohort.id, [
    { groupNumber: 12, leadName: 'Lead', leadEmail: 'a@example.invalid', leadPhone: '' },
  ]);
  const [code] = await teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });

  return { cohort, idea, code: code! };
}

async function signIn(groupNumber: number, code: string, name = 'Priya') {
  const verified = await participant.verifyTeamAccess({ groupNumber, code, ipHash: `ip-${name}` });
  if (!verified.ok) throw new Error('verification failed');
  const session = await participant.createSession({
    teamId: verified.teamId,
    editorName: name,
    editorRole: null,
    ipHash: null,
  });
  return session.token;
}

/** Fill in everything final submit requires. */
async function makeSubmittable(token: string, ideaId: string) {
  const view = await participant.resolveSession(token);
  await participant.saveDraft(
    token,
    {
      product: { ideaId, productName: 'ShiftLoop' },
      live: { productUrl: 'https://example.invalid/app' },
    },
    view!.submission.version,
  );

  await participant.attachArtifact(token, {
    kind: 'deck_pdf',
    storageBucket: 'submission-decks',
    storagePath: 'cohort/submission/deck.pdf',
    originalFilename: 'deck.pdf',
    mimeType: 'application/pdf',
    byteSize: 1024,
    checksumSha256: null,
    externalUrl: null,
    uploadCompletedAt: new Date(),
    isAccessible: true,
    lastCheckedAt: new Date(),
  });
  await participant.attachArtifact(token, {
    kind: 'demo_video',
    storageBucket: null,
    storagePath: null,
    originalFilename: null,
    mimeType: null,
    byteSize: null,
    checksumSha256: null,
    externalUrl: 'https://example.invalid/video',
    uploadCompletedAt: new Date(),
    isAccessible: null,
    lastCheckedAt: null,
  });
}

// --------------------------------------------------------------------------

describe('drafts', () => {
  it('creates one shared draft however many members open the portal', async () => {
    // The draft is created lazily on first load, not at sign-in, and two
    // members opening it at the same moment must not produce two rows.
    const { code } = await scenario();
    const tokenA = await signIn(12, code.code, 'A');
    const tokenB = await signIn(12, code.code, 'B');

    const [viewA, viewB] = await Promise.all([
      participant.resolveSession(tokenA),
      participant.resolveSession(tokenB),
    ]);

    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from submissions');
    expect(rows[0]?.n).toBe(1);
    expect(viewA!.submission.id).toBe(viewB!.submission.id);
  });

  it('saves each form section and promotes it to the judged columns', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    let view = await participant.resolveSession(token);

    const sections = [
      { product: { ideaId: idea.id, productName: 'ShiftLoop', primaryUser: 'Clinic managers' } },
      { live: { productUrl: 'https://example.invalid', loginRequired: true } },
      { learning: { majorTradeoff: 'Cut the reporting screen', builderStack: 'Next.js' } },
    ];

    for (const section of sections) {
      const result = await participant.saveDraft(token, section, view!.submission.version);
      expect(result.ok).toBe(true);
      view = await participant.resolveSession(token);
    }

    const stored = await submissions.getSubmission(view!.submission.id);
    expect(stored?.majorTradeoff).toBe('Cut the reporting screen');
    expect(stored?.builderStack).toBe('Next.js');
    expect(stored?.loginRequired).toBe(true);
  });

  it('keeps arrays and structured steps intact through a round trip', async () => {
    const { code } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);

    await participant.saveDraft(
      token,
      {
        product: { shouldHaveFeatures: ['Export', 'Reminders'] },
        live: { coreTestSteps: [{ action: 'Sign in', expectedResult: 'Dashboard loads' }] },
        learning: { bugsFixed: [{ description: 'Date parser', howFixed: 'Used UTC' }] },
      },
      view!.submission.version,
    );

    const stored = await submissions.getSubmission(view!.submission.id);
    expect(stored?.shouldHaveFeatures).toEqual(['Export', 'Reminders']);
    expect(stored?.coreTestSteps[0]?.expectedResult).toBe('Dashboard loads');
    expect(stored?.bugsFixed[0]?.howFixed).toBe('Used UTC');
  });
});

describe('optimistic concurrency', () => {
  it('refuses the stale write and keeps the winner intact', async () => {
    const { code } = await scenario();
    const tokenA = await signIn(12, code.code, 'A');
    const tokenB = await signIn(12, code.code, 'B');

    const readA = await participant.resolveSession(tokenA);
    const readB = await participant.resolveSession(tokenB);
    const version = readA!.submission.version;
    expect(readB!.submission.version).toBe(version);

    expect((await participant.saveDraft(tokenA, { product: { productName: 'A' } }, version)).ok).toBe(
      true,
    );

    const saveB = await participant.saveDraft(tokenB, { product: { productName: 'B' } }, version);
    expect(saveB.ok).toBe(false);
    expect(saveB.conflict?.currentVersion).toBe(version + 1);

    const after = await submissions.getSubmission(readA!.submission.id);
    expect(after?.productName).toBe('A');
    expect(after?.version).toBe(version + 1);
  });

  it('lets the loser succeed once it reloads', async () => {
    const { code } = await scenario();
    const tokenA = await signIn(12, code.code, 'A');
    const tokenB = await signIn(12, code.code, 'B');
    const version = (await participant.resolveSession(tokenA))!.submission.version;

    await participant.saveDraft(tokenA, { product: { productName: 'A' } }, version);
    await participant.saveDraft(tokenB, { product: { productName: 'B' } }, version);

    const reloaded = await participant.resolveSession(tokenB);
    const retry = await participant.saveDraft(
      tokenB,
      { product: { productName: 'B after reload' } },
      reloaded!.submission.version,
    );
    expect(retry.ok).toBe(true);
  });

  it('survives simultaneous saves at the same version, admitting exactly one', async () => {
    // The database is the arbiter, not a race between two application reads.
    const { code } = await scenario();
    const tokenA = await signIn(12, code.code, 'A');
    const tokenB = await signIn(12, code.code, 'B');
    const version = (await participant.resolveSession(tokenA))!.submission.version;

    const [first, second] = await Promise.all([
      participant.saveDraft(tokenA, { product: { productName: 'A' } }, version),
      participant.saveDraft(tokenB, { product: { productName: 'B' } }, version),
    ]);

    const winners = [first, second].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const { rows } = await db.query<{ version: number }>('select version from submissions');
    expect(Number(rows[0]?.version)).toBe(version + 1);
  });
});

describe('final submit', () => {
  it('refuses until every required piece is present', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);

    const noIdea = await participant.finaliseSubmission(token, { ipHash: null });
    expect(noIdea.ok).toBe(false);

    await participant.saveDraft(token, { product: { ideaId: idea.id } }, view!.submission.version);
    const noDeck = await participant.finaliseSubmission(token, { ipHash: null });
    expect(noDeck.ok).toBe(false);
    expect(noDeck.error).toMatch(/pitch deck/i);
  });

  it('locks the submission and mints a receipt', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code, 'Priya');
    await makeSubmittable(token, idea.id);

    const result = await participant.finaliseSubmission(token, { ipHash: 'ip' });
    expect(result.ok).toBe(true);
    expect(result.receiptId).toMatch(/^OSK-TEST-012-/);

    const view = await participant.resolveSession(token);
    expect(view?.submission.status).toBe('locked');
    expect(view?.submission.submittedAt).not.toBeNull();
    expect(view?.submission.submittedByName).toBe('Priya');
    expect(view?.canEdit).toBe(false);
  });

  it('produces exactly one receipt under two concurrent final submits', async () => {
    // Two members pressing submit at the same instant must not produce two
    // receipt states.
    const { code, idea } = await scenario();
    const tokenA = await signIn(12, code.code, 'A');
    const tokenB = await signIn(12, code.code, 'B');
    await makeSubmittable(tokenA, idea.id);

    const [first, second] = await Promise.all([
      participant.finaliseSubmission(tokenA, { ipHash: 'a' }),
      participant.finaliseSubmission(tokenB, { ipHash: 'b' }),
    ]);

    const succeeded = [first, second].filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);

    const { rows } = await db.query<{ receipt_id: string; status: string; n: number }>(
      'select receipt_id, status, count(*) over ()::int as n from submissions',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('locked');
    expect(rows[0]?.receipt_id).toBe(succeeded[0]!.receiptId);

    // And exactly one final_submitted event, not two.
    const events = await db.query<{ n: number }>(
      `select count(*)::int as n from submission_events where event_type = 'final_submitted'`,
    );
    expect(events.rows[0]?.n).toBe(1);
  });

  it('refuses a second final submit outright', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: null });

    const again = await participant.finaliseSubmission(token, { ipHash: null });
    expect(again.ok).toBe(false);
  });

  it('keeps the receipt id when reopened and resubmitted', async () => {
    // A team that has been given an identifier keeps it.
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    const first = await participant.finaliseSubmission(token, { ipHash: null });

    const view = await participant.resolveSession(token);
    await submissions.reopenSubmission(view!.submission.id, 'Approved exception');

    const second = await participant.finaliseSubmission(token, { ipHash: null });
    expect(second.ok).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);
  });

  it('refuses an idea that was deactivated after it was chosen', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await cohorts.deleteIdea(idea.id);

    const result = await participant.finaliseSubmission(token, { ipHash: null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer available/i);
  });

  it('is refused once the window closes, whatever the submission contains', async () => {
    const { cohort, code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await cohorts.closeSubmissions(cohort.id, 'manual');

    const result = await participant.finaliseSubmission(token, { ipHash: null });
    expect(result.ok).toBe(false);

    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from submissions where receipt_id is not null',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('stamps the declarations with when and from where they were accepted', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);
    await db.query(
      `insert into submission_declarations (submission_id, built_during_hackathon) values ($1, true)`,
      [view!.submission.id],
    );
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: 'hashed-ip' });

    const declarations = await submissions.getDeclarations(view!.submission.id);
    expect(declarations?.acceptedAt).not.toBeNull();
    expect(declarations?.acceptedIpHash).toBe('hashed-ip');
  });
});

describe('admin lifecycle', () => {
  it('reopens a locked submission so the team can edit again', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: null });

    const view = await participant.resolveSession(token);
    expect(view?.canEdit).toBe(false);

    const reopened = await submissions.reopenSubmission(view!.submission.id, 'Outage during upload');
    expect(reopened.status).toBe('reopened');
    expect(reopened.reopenedReason).toBe('Outage during upload');

    const after = await participant.resolveSession(token);
    expect(after?.canEdit).toBe(true);
  });

  it('does not let a reopened submission be edited while the cohort is closed', async () => {
    const { cohort, code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: null });

    const view = await participant.resolveSession(token);
    await submissions.reopenSubmission(view!.submission.id, 'Exception');
    await cohorts.closeSubmissions(cohort.id, 'manual');

    const after = await participant.resolveSession(token);
    expect(after?.canEdit).toBe(false);
  });

  it('records an event for every admin lifecycle action', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: null });
    const view = await participant.resolveSession(token);

    await submissions.reopenSubmission(view!.submission.id, 'r');
    await submissions.lockSubmission(view!.submission.id);
    await submissions.setLateException(view!.submission.id, true, 'Approved');

    const events = await submissions.listEvents(view!.submission.id);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('final_submitted');
    expect(types).toContain('reopened');
    expect(types).toContain('locked');
    expect(types).toContain('late_exception_granted');
  });

  it('computes lateness rather than storing it', async () => {
    const { cohort, code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: null });
    const view = await participant.resolveSession(token);

    expect((await submissions.getSubmission(view!.submission.id))?.isLate).toBe(false);

    // Move the deadline behind the submission: lateness follows immediately,
    // because it is derived on read (ADR-016).
    await db.query("update cohorts set day13_deadline_at = now() - interval '1 day' where id = $1", [
      cohort.id,
    ]);
    expect((await submissions.getSubmission(view!.submission.id))?.isLate).toBe(true);
  });

  it('finds a submission by the receipt id a team quotes, in any case', async () => {
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    const { receiptId } = await participant.finaliseSubmission(token, { ipHash: null });

    expect((await submissions.findByReceiptId(receiptId!))?.receiptId).toBe(receiptId);
    expect((await submissions.findByReceiptId(receiptId!.toLowerCase()))?.receiptId).toBe(receiptId);
    expect(await submissions.findByReceiptId('OSK-NOPE-000-XXXXXX')).toBeNull();
  });

  it('revokes every session for a team when asked', async () => {
    const { code } = await scenario();
    const tokenA = await signIn(12, code.code, 'A');
    const tokenB = await signIn(12, code.code, 'B');
    const view = await participant.resolveSession(tokenA);

    const revoked = await submissions.revokeTeamSessions(view!.team.id);
    expect(revoked).toBe(2);
    expect(await participant.resolveSession(tokenA)).toBeNull();
    expect(await participant.resolveSession(tokenB)).toBeNull();
  });
});

describe('the admin detail view', () => {
  it('renders fully while no assessment exists', async () => {
    // Phase A must be usable before judging is implemented.
    const { code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: null });
    const view = await participant.resolveSession(token);

    const detail = await submissions.getSubmissionDetail(view!.submission.id);
    expect(detail).not.toBeNull();
    expect(detail?.team.groupNumber).toBe(12);
    expect(detail?.idea?.title).toBe('Recipe sharing');
    expect(detail?.artifacts).toHaveLength(2);

    // Assessment sections are empty, not fabricated.
    expect(detail?.job).toBeNull();
    expect(detail?.scores).toEqual([]);
    expect(detail?.summary).toBeNull();
    expect(detail?.rank).toBeNull();
    expect(detail?.inShortlist).toBe(false);
  });

  it('lists submissions with no assessment data and no invented scores', async () => {
    const { cohort, code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);
    await participant.finaliseSubmission(token, { ipHash: null });

    const list = await submissions.listSubmissions(cohort.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.ideaTitle).toBe('Recipe sharing');
    expect(list[0]?.totalScore).toBeNull();
    expect(list[0]?.rank).toBeNull();
    expect(list[0]?.stage).toBeNull();
    expect(list[0]?.disqualificationStatus).toBe('none');
  });

  it('filters by status and searches by group number', async () => {
    const { cohort, code, idea } = await scenario();
    const token = await signIn(12, code.code);
    await makeSubmittable(token, idea.id);

    expect(await submissions.listSubmissions(cohort.id, { status: 'locked' })).toHaveLength(0);
    await participant.finaliseSubmission(token, { ipHash: null });
    expect(await submissions.listSubmissions(cohort.id, { status: 'locked' })).toHaveLength(1);

    expect(await submissions.listSubmissions(cohort.id, { search: '12' })).toHaveLength(1);
    expect(await submissions.listSubmissions(cohort.id, { search: 'nobody' })).toHaveLength(0);
  });
});

describe('credentials', () => {
  it('round-trips through encryption and reveals the original values', async () => {
    const { code } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);

    await participant.storeCredentials(token, {
      username: 'judge@demo.invalid',
      password: 'DemoReviewer!2026',
      loginInstructions: 'Use the demo account only.',
    });

    const revealed = await submissions.revealCredentials(view!.submission.id);
    expect(revealed?.username).toBe('judge@demo.invalid');
    expect(revealed?.password).toBe('DemoReviewer!2026');
    expect(revealed?.loginInstructions).toBe('Use the demo account only.');
  });

  it('stamps when credentials were last revealed', async () => {
    const { code } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);
    await participant.storeCredentials(token, { username: 'u', password: 'p' });

    expect((await submissions.getCredentials(view!.submission.id))?.lastRevealedAt).toBeNull();
    await submissions.revealCredentials(view!.submission.id);
    expect((await submissions.getCredentials(view!.submission.id))?.lastRevealedAt).not.toBeNull();
  });

  it('refuses a tampered ciphertext rather than returning rubbish', async () => {
    const { code } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);
    await participant.storeCredentials(token, { username: 'u', password: 'p' });

    // Flip the last character of the stored envelope.
    const { rows } = await db.query<{ c: Buffer }>(
      'select password_ciphertext as c from submission_credentials',
    );
    const tampered = rows[0]!.c.toString('utf8').slice(0, -1) + 'A';
    await db.query('update submission_credentials set password_ciphertext = $1', [
      Buffer.from(tampered, 'utf8'),
    ]);

    // GCM authenticates: a modified ciphertext fails to open.
    await expect(submissions.revealCredentials(view!.submission.id)).rejects.toThrow();
  });

  it('refuses a malformed envelope', async () => {
    const { code } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);
    await participant.storeCredentials(token, { username: 'u', password: 'p' });
    await db.query('update submission_credentials set password_ciphertext = $1', [
      Buffer.from('not-an-envelope', 'utf8'),
    ]);

    await expect(submissions.revealCredentials(view!.submission.id)).rejects.toThrow(/Malformed/i);
  });

  it('destroys the values on delete rather than hiding them', async () => {
    const { code } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);
    await participant.storeCredentials(token, { username: 'u', password: 'DemoReviewer!2026' });

    await submissions.deleteCredentials(view!.submission.id);

    expect(await submissions.getCredentials(view!.submission.id)).toBeNull();
    expect(await submissions.revealCredentials(view!.submission.id)).toBeNull();

    const { rows } = await db.query<{ c: Buffer | null }>(
      'select password_ciphertext as c from submission_credentials',
    );
    expect(rows[0]?.c).toBeNull();
  });

  it('never exposes plaintext through the record accessor', async () => {
    const { code } = await scenario();
    const token = await signIn(12, code.code);
    const view = await participant.resolveSession(token);
    await participant.storeCredentials(token, { username: 'u', password: 'DemoReviewer!2026' });

    const record = await submissions.getCredentials(view!.submission.id);
    expect(JSON.stringify(record)).not.toContain('DemoReviewer!2026');
  });
});
