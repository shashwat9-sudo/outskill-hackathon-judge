import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataStore } from './store';
import { RUBRIC_CATEGORIES } from '../../rubric/index';
import { DEMO_COHORT_ID, demoSubmissionId, demoTeamId } from '../../fixtures/demo';

let store: MemoryDataStore;

beforeEach(() => {
  store = new MemoryDataStore();
});

/** Verify a demo team and open a session, the way /submit does. */
async function openSession(
  target: MemoryDataStore,
  groupNumber: number,
  editorName = 'Priya (editing)',
): Promise<string> {
  await target.whenReady();
  const verified = await target.participant.verifyTeamAccess({
    groupNumber,
    code: target.getDemoAccessCode(groupNumber),
    ipHash: `ip-${editorName}`,
  });
  expect(verified.ok, `group ${groupNumber} failed verification`).toBe(true);
  if (!verified.ok) throw new Error('unreachable');

  const session = await target.participant.createSession({
    teamId: verified.teamId,
    editorName,
    editorRole: null,
    ipHash: `ip-${editorName}`,
  });
  return session.token;
}

// --------------------------------------------------------------------------
// Participant isolation — the requirement most damaging to get wrong
// --------------------------------------------------------------------------

describe('participant isolation', () => {
  it('exposes no method that can reach assessment data', () => {
    // The capability is absent, not guarded (ADR-010).
    const participantMethods = Object.keys(store.participant);
    const forbidden = [
      'score',
      'rank',
      'evidence',
      'assessment',
      'feedback',
      'shortlist',
      'disqualif',
      'consistency',
    ];

    for (const method of participantMethods) {
      for (const word of forbidden) {
        expect(method.toLowerCase(), `participant.${method} must not exist`).not.toContain(word);
      }
    }
  });

  it('never includes scores, rank, evidence or feedback in the participant view', async () => {
    const token = await openSession(store, 12);
    const serialised = JSON.stringify(await store.participant.resolveSession(token));

    for (const term of [
      'weightedScore',
      'rawScore',
      'supportingEvidence',
      'contradictoryEvidence',
      'consistencyReview',
      'disqualification',
      'privateGuidance',
      'tiebreak',
      'inShortlist',
    ]) {
      expect(serialised, `participant view leaked "${term}"`).not.toContain(term);
    }
  });

  it('never exposes credential plaintext or ciphertext to a participant', async () => {
    const token = await openSession(store, 45);
    const view = await store.participant.resolveSession(token);

    expect(view?.hasStoredCredentials).toBe(true);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('DemoReviewer!2026');
    expect(serialised).not.toContain('usernameCiphertext');
  });

  it('resolves a session only to its own team', async () => {
    const token = await openSession(store, 12);
    const view = await store.participant.resolveSession(token);
    expect(view?.team.groupNumber).toBe(12);
    expect(view?.submission.id).toBe(demoSubmissionId(12));
    expect(view?.submission.id).not.toBe(demoSubmissionId(45));
  });

  it('rejects an unknown session token', async () => {
    await store.whenReady();
    expect(await store.participant.resolveSession('not-a-real-session')).toBeNull();
  });

  it('ends a session without affecting other members', async () => {
    const ana = await openSession(store, 27, 'Ana');
    const ben = await openSession(store, 27, 'Ben');

    await store.participant.endSession(ana);
    expect(await store.participant.resolveSession(ana)).toBeNull();
    expect(await store.participant.resolveSession(ben)).not.toBeNull();
  });
});

// --------------------------------------------------------------------------
// Team access verification
// --------------------------------------------------------------------------

describe('team access verification', () => {
  it('accepts the right group and code', async () => {
    await store.whenReady();
    const result = await store.participant.verifyTeamAccess({
      groupNumber: 12,
      code: store.getDemoAccessCode(12),
      ipHash: 'ip-a',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a formatted or lowercase code', async () => {
    await store.whenReady();
    const raw = store.getDemoAccessCode(12);
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`.toLowerCase();

    const result = await store.participant.verifyTeamAccess({
      groupNumber: 12,
      code: formatted,
      ipHash: 'ip-format',
    });
    expect(result.ok).toBe(true);
  });

  it('gives one generic message for a wrong code and for an unknown group', async () => {
    await store.whenReady();
    const wrongCode = await store.participant.verifyTeamAccess({
      groupNumber: 12,
      code: 'ZZZZZZZZZZZZ',
      ipHash: 'ip-b',
    });
    const unknownGroup = await store.participant.verifyTeamAccess({
      groupNumber: 999,
      code: store.getDemoAccessCode(12),
      ipHash: 'ip-c',
    });

    expect(wrongCode.ok).toBe(false);
    expect(unknownGroup.ok).toBe(false);
    // Identical wording, so the form cannot be used to enumerate group numbers.
    if (!wrongCode.ok && !unknownGroup.ok) {
      expect(wrongCode.message).toBe(unknownGroup.message);
      expect(wrongCode.message).toMatch(/could not verify those team access details/i);
    }
  });

  it('rate-limits repeated failures, without locking out other clients', async () => {
    await store.whenReady();
    for (let i = 0; i < 8; i++) {
      await store.participant.verifyTeamAccess({
        groupNumber: 12,
        code: 'ZZZZZZZZZZZZ',
        ipHash: 'ip-attacker',
      });
    }

    const blocked = await store.participant.verifyTeamAccess({
      groupNumber: 12,
      code: store.getDemoAccessCode(12),
      ipHash: 'ip-attacker',
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('rate_limited');

    // The real team, from a different client, is unaffected.
    const other = await store.participant.verifyTeamAccess({
      groupNumber: 12,
      code: store.getDemoAccessCode(12),
      ipHash: 'ip-innocent',
    });
    expect(other.ok).toBe(true);
  });

  it('lets an admin clear a lockout', async () => {
    await store.whenReady();
    for (let i = 0; i < 8; i++) {
      await store.participant.verifyTeamAccess({ groupNumber: 27, code: 'BAD', ipHash: 'ip-locked' });
    }
    await store.teams.clearVerificationLockout(DEMO_COHORT_ID, 27);

    const result = await store.participant.verifyTeamAccess({
      groupNumber: 27,
      code: store.getDemoAccessCode(27),
      ipHash: 'ip-locked',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a revoked access code', async () => {
    await store.whenReady();
    await store.teams.revokeAccessCode(demoTeamId(27));

    const result = await store.participant.verifyTeamAccess({
      groupNumber: 27,
      code: store.getDemoAccessCode(27),
      ipHash: 'ip-revoked',
    });
    expect(result.ok).toBe(false);
  });
});

describe('access code generation', () => {
  it('only issues codes to teams that lack one, unless regeneration is explicit', async () => {
    await store.whenReady();
    const first = await store.teams.generateAccessCodes({
      cohortId: DEMO_COHORT_ID,
      regenerate: false,
    });
    // Every demo team already has a seeded code, so nothing is reissued.
    expect(first).toHaveLength(0);

    const regenerated = await store.teams.generateAccessCodes({
      cohortId: DEMO_COHORT_ID,
      teamIds: [demoTeamId(12)],
      regenerate: true,
    });
    expect(regenerated).toHaveLength(1);
    expect(regenerated[0]?.regenerated).toBe(true);
    expect(regenerated[0]?.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('invalidates existing sessions when a code is regenerated', async () => {
    const token = await openSession(store, 12);
    expect(await store.participant.resolveSession(token)).not.toBeNull();

    await store.teams.generateAccessCodes({
      cohortId: DEMO_COHORT_ID,
      teamIds: [demoTeamId(12)],
      regenerate: true,
    });

    // The old session dies with the old code, without having to find it.
    expect(await store.participant.resolveSession(token)).toBeNull();
  });

  it('never returns a stored code or hash back to a caller', async () => {
    await store.whenReady();
    const status = await store.teams.listAccessCodeStatus(DEMO_COHORT_ID);
    const serialised = JSON.stringify(status);

    expect(status).toHaveLength(6);
    expect(status[0]?.hasCode).toBe(true);
    expect(serialised).not.toContain(store.getDemoAccessCode(12));
    expect(serialised).not.toContain('codeHash');
    expect(serialised).not.toContain('$argon2');
  });

  it('revoking access ends live sessions', async () => {
    const token = await openSession(store, 27);
    await store.teams.revokeAccessCode(demoTeamId(27));
    expect(await store.participant.resolveSession(token)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Shared editing and optimistic concurrency
// --------------------------------------------------------------------------

describe('shared team editing', () => {
  it('lets two members hold sessions with the same code', async () => {
    const first = await openSession(store, 27, 'Ana');
    const second = await openSession(store, 27, 'Ben');

    expect(first).not.toBe(second);
    expect((await store.participant.resolveSession(first))?.editorName).toBe('Ana');
    expect((await store.participant.resolveSession(second))?.editorName).toBe('Ben');
  });

  it('records the editor name on a save', async () => {
    const token = await openSession(store, 27, 'Ana');
    const view = await store.participant.resolveSession(token);

    const result = await store.participant.saveDraft(
      token,
      { product: { productName: 'Renamed by Ana' } },
      view?.submission.version ?? 1,
    );
    expect(result.ok).toBe(true);
    expect(result.submission?.lastEditedBy).toBe('Ana');
    expect(result.submission?.productName).toBe('Renamed by Ana');
  });

  it('refuses a stale write instead of silently overwriting a teammate', async () => {
    const ana = await openSession(store, 27, 'Ana');
    const ben = await openSession(store, 27, 'Ben');
    const startingVersion = (await store.participant.resolveSession(ana))?.submission.version ?? 1;

    const anaSave = await store.participant.saveDraft(
      ana,
      { product: { productName: 'Ana version' } },
      startingVersion,
    );
    expect(anaSave.ok).toBe(true);

    // Ben still holds the version he read before Ana saved.
    const benSave = await store.participant.saveDraft(
      ben,
      { product: { productName: 'Ben version' } },
      startingVersion,
    );

    expect(benSave.ok).toBe(false);
    expect(benSave.conflict?.message).toMatch(/Another team member updated this submission/);
    // Ana's work survives.
    expect((await store.participant.resolveSession(ana))?.submission.productName).toBe('Ana version');
  });

  it('lets the second member save once they reload the latest version', async () => {
    const ana = await openSession(store, 27, 'Ana');
    const ben = await openSession(store, 27, 'Ben');
    const startingVersion = (await store.participant.resolveSession(ana))?.submission.version ?? 1;

    await store.participant.saveDraft(ana, { product: { productName: 'Ana version' } }, startingVersion);

    const reloaded = await store.participant.resolveSession(ben);
    const retry = await store.participant.saveDraft(
      ben,
      { product: { productName: 'Ben version' } },
      reloaded?.submission.version ?? 0,
    );

    expect(retry.ok).toBe(true);
    expect(retry.submission?.productName).toBe('Ben version');
  });

  it('refuses an unversioned write', async () => {
    const token = await openSession(store, 27);
    expect((await store.participant.saveDraft(token, {}, -1)).ok).toBe(false);
  });

  it('shows learner-safe team activity', async () => {
    const token = await openSession(store, 27, 'Ana');
    await store.participant.recordActivity(token, 'section_saved', 'Product idea');

    const view = await store.participant.resolveSession(token);
    expect(view?.recentActivity.length).toBeGreaterThan(0);
    expect(view?.recentActivity[0]?.editorName).toBe('Ana');
    expect(view?.recentActivity[0]?.section).toBe('Product idea');
  });
});

// --------------------------------------------------------------------------
// Submission window and final lock
// --------------------------------------------------------------------------

describe('submission window enforcement', () => {
  it('blocks writes once the cohort is paused, and allows them again on resume', async () => {
    const token = await openSession(store, 27);
    const version = (await store.participant.resolveSession(token))?.submission.version ?? 1;

    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'paused');
    const paused = await store.participant.saveDraft(token, { product: { productName: 'x' } }, version);
    expect(paused.ok).toBe(false);
    expect(paused.error).toMatch(/paused/i);

    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'open');
    const resumed = await store.participant.saveDraft(token, { product: { productName: 'x' } }, version);
    expect(resumed.ok).toBe(true);
  });

  it('blocks writes after a manual close, and preserves the draft', async () => {
    const token = await openSession(store, 27);
    const before = await store.participant.resolveSession(token);

    await store.cohorts.closeSubmissions(DEMO_COHORT_ID, 'manual');

    const blocked = await store.participant.saveDraft(token, { product: { productName: 'y' } }, 99);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/closed/i);

    // The draft is still readable and unchanged.
    const after = await store.participant.resolveSession(token);
    expect(after?.submission.productName).toBe(before?.submission.productName);
  });

  it('blocks writes once the deadline passes, even while the status still says open', async () => {
    const token = await openSession(store, 27);
    const cohort = await store.cohorts.getCohort(DEMO_COHORT_ID);

    // Move the deadline into the past without touching the stored status.
    await store.cohorts.updateCohort(DEMO_COHORT_ID, {
      day13DeadlineAt: new Date(Date.now() - 60_000),
    });
    expect((await store.cohorts.getCohort(DEMO_COHORT_ID))?.status).toBe('open');

    const view = await store.participant.resolveSession(token);
    expect(view?.canEdit).toBe(false);
    expect(view?.windowMessage).toMatch(/closed/i);

    const result = await store.participant.saveDraft(token, {}, view?.submission.version ?? 1);
    expect(result.ok).toBe(false);

    await store.cohorts.updateCohort(DEMO_COHORT_ID, {
      day13DeadlineAt: cohort?.day13DeadlineAt as Date,
    });
  });

  it('reconciles an overdue cohort to closed, without acceptance depending on it', async () => {
    await store.cohorts.updateCohort(DEMO_COHORT_ID, {
      day13DeadlineAt: new Date(Date.now() - 60_000),
    });
    const result = await store.cohorts.reconcileDeadlines();

    expect(result.closed).toContain(DEMO_COHORT_ID);
    const cohort = await store.cohorts.getCohort(DEMO_COHORT_ID);
    expect(cohort?.status).toBe('closed');
    expect(cohort?.closureType).toBe('deadline');
  });

  it('refuses to reopen past the deadline without an extension', async () => {
    await store.cohorts.updateCohort(DEMO_COHORT_ID, {
      day13DeadlineAt: new Date(Date.now() - 60_000),
    });
    await store.cohorts.closeSubmissions(DEMO_COHORT_ID, 'deadline');

    await expect(
      store.cohorts.reopenSubmissions(DEMO_COHORT_ID, { reason: 'Team reported an upload failure.' }),
    ).rejects.toThrow(/needs either a new deadline or an explicit acceptance/i);
  });

  it('reopens with an acceptance window and accepts writes again', async () => {
    const token = await openSession(store, 27);
    await store.cohorts.updateCohort(DEMO_COHORT_ID, {
      day13DeadlineAt: new Date(Date.now() - 60_000),
    });
    await store.cohorts.closeSubmissions(DEMO_COHORT_ID, 'deadline');

    await store.cohorts.reopenSubmissions(DEMO_COHORT_ID, {
      reason: 'Approved exception for a genuine upload failure.',
      acceptingUntil: new Date(Date.now() + 3_600_000),
    });

    const view = await store.participant.resolveSession(token);
    expect(view?.canEdit).toBe(true);

    const result = await store.participant.saveDraft(
      token,
      { product: { productName: 'after reopen' } },
      view?.submission.version ?? 1,
    );
    expect(result.ok).toBe(true);
  });
});

describe('final submission', () => {
  it('locks the submission, issues a receipt and records who submitted', async () => {
    const token = await openSession(store, 12, 'Ana');
    // Group 12 already holds a complete submission, but is locked; reopen it.
    await store.submissions.reopenSubmission(demoSubmissionId(12), 'Test reopen.');

    const result = await store.participant.finaliseSubmission(token, { ipHash: 'ip-final' });
    expect(result.ok).toBe(true);
    expect(result.receiptId).toMatch(/^OSK-AIAPD1-012-/);

    const view = await store.participant.resolveSession(token);
    expect(view?.submission.status).toBe('locked');
    expect(view?.submission.submittedByName).toBe('Ana');
  });

  it('blocks every member once the submission is final', async () => {
    const ana = await openSession(store, 12, 'Ana');
    const ben = await openSession(store, 12, 'Ben');

    const view = await store.participant.resolveSession(ben);
    expect(view?.canEdit).toBe(false);

    const anaWrite = await store.participant.saveDraft(ana, {}, view?.submission.version ?? 1);
    const benWrite = await store.participant.saveDraft(ben, {}, view?.submission.version ?? 1);
    expect(anaWrite.ok).toBe(false);
    expect(benWrite.ok).toBe(false);
  });

  it('refuses a second final submission', async () => {
    const token = await openSession(store, 12);
    const result = await store.participant.finaliseSubmission(token, { ipHash: null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already been finalised|locked/i);
  });

  it('returns receipt data with no code, credential or internal id', async () => {
    const token = await openSession(store, 12);
    const receipt = await store.participant.getReceipt(token);

    expect(receipt?.receiptId).toMatch(/^OSK-AIAPD1-012-/);
    expect(receipt?.groupNumber).toBe(12);

    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toContain(store.getDemoAccessCode(12));
    expect(serialised).not.toContain(demoSubmissionId(12));
    expect(serialised).not.toContain(demoTeamId(12));
  });

  it('lets an admin find a submission by its receipt ID', async () => {
    const token = await openSession(store, 12);
    const receipt = await store.participant.getReceipt(token);

    const found = await store.submissions.findByReceiptId(receipt?.receiptId as string);
    expect(found?.id).toBe(demoSubmissionId(12));
  });

  it('keeps the receipt reachable after submissions close', async () => {
    const token = await openSession(store, 12);
    await store.cohorts.closeSubmissions(DEMO_COHORT_ID, 'manual');

    const receipt = await store.participant.getReceipt(token);
    expect(receipt?.receiptId).toBeTruthy();
  });
});

describe('demo fixtures', () => {
  it('seeds one cohort, eight ideas, and six teams', async () => {
    expect(await store.cohorts.listCohorts()).toHaveLength(1);
    expect(await store.cohorts.listIdeas(DEMO_COHORT_ID)).toHaveLength(8);
    expect(await store.teams.listTeams(DEMO_COHORT_ID)).toHaveLength(6);
  });

  it('covers every required scenario', async () => {
    const submissions = await store.submissions.listSubmissions(DEMO_COHORT_ID);
    expect(submissions).toHaveLength(6);

    const stages = submissions.map((s) => s.stage);
    expect(stages).toContain('completed');
    expect(stages).toContain('failed');
    expect(stages).toContain('manual_review');

    expect(submissions.some((s) => s.submission.status === 'draft')).toBe(true);
    expect(submissions.some((s) => s.lowConfidence)).toBe(true);
    expect(submissions.some((s) => s.submission.loginRequired)).toBe(true);
  });

  it('seeds one access code per team', async () => {
    await store.whenReady();
    const status = await store.teams.listAccessCodeStatus(DEMO_COHORT_ID);
    expect(status.every((s) => s.hasCode)).toBe(true);
  });

  it('contains no personally identifiable information', async () => {
    const detail = await store.submissions.getSubmissionDetail(demoSubmissionId(12));
    const serialised = JSON.stringify(detail);

    // Demo contacts use reserved, unroutable values only.
    expect(serialised).toMatch(/demo\.invalid/);
    expect(serialised).not.toMatch(/@gmail\.com|@outlook\.com|@yahoo\.com/);
    expect(serialised).toMatch(/\+1 555 01/);
  });

  it('leaves the final four empty — no system process may fill them', async () => {
    expect(await store.ranking.listFinalSelections(DEMO_COHORT_ID)).toHaveLength(0);
  });

  it('produces the same data on every run', async () => {
    const a = new MemoryDataStore();
    const b = new MemoryDataStore();
    const detailA = await a.submissions.getSubmissionDetail(demoSubmissionId(12));
    const detailB = await b.submissions.getSubmissionDetail(demoSubmissionId(12));
    expect(detailA?.summary?.totalScore).toBe(detailB?.summary?.totalScore);
    expect(detailA?.scores.map((s) => s.rawScore)).toEqual(detailB?.scores.map((s) => s.rawScore));
  });
});

// --------------------------------------------------------------------------
// Assessment
// --------------------------------------------------------------------------

describe('assessment data', () => {
  it('gives every score supporting, contradictory, or missing evidence', async () => {
    const detail = await store.submissions.getSubmissionDetail(demoSubmissionId(12));
    expect(detail?.scores).toHaveLength(RUBRIC_CATEGORIES.length);

    for (const score of detail?.scores ?? []) {
      const evidenceCount =
        score.supportingEvidence.length + score.contradictoryEvidence.length + score.missingEvidence.length;
      expect(evidenceCount, `${score.categoryKey} has no evidence`).toBeGreaterThan(0);
      expect(score.rationale.length).toBeGreaterThan(0);
      expect(score.confidence).toBeGreaterThan(0);
      expect(score.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('records evidence rows so "every score has evidence" is queryable', async () => {
    const job = await store.assessment.getJobBySubmission(demoSubmissionId(12));
    const evidence = await store.assessment.listEvidence(job?.id as string);
    const categoriesWithEvidence = new Set(evidence.map((e) => e.categoryKey));
    expect(categoriesWithEvidence.size).toBe(RUBRIC_CATEGORIES.length);
  });

  it('flags low confidence rather than hiding it', async () => {
    const detail = await store.submissions.getSubmissionDetail(demoSubmissionId(61));
    expect(detail?.summary?.lowConfidence).toBe(true);
    expect(detail?.manualReviewFlags.some((f) => f.status === 'open')).toBe(true);
  });

  it('marks the video as unanalysable rather than inventing content', async () => {
    const detail = await store.submissions.getSubmissionDetail(demoSubmissionId(61));
    expect(detail?.artifactAnalysis?.videoAnalysisLimited).toBe(true);
    expect(detail?.artifactAnalysis?.videoLimitationReason).toMatch(/No video content has been inferred/);
  });

  it('records every preflight attempt, not just the last one', async () => {
    const detail = await store.submissions.getSubmissionDetail(demoSubmissionId(33));
    const dnsChecks = detail?.preflight.filter((p) => p.checkKey === 'dns_resolves') ?? [];
    expect(dnsChecks).toHaveLength(3);
    expect(dnsChecks.map((c) => c.attemptNumber)).toEqual([1, 2, 3]);
    expect(dnsChecks.every((c) => c.failureClass === 'dns')).toBe(true);
  });

  it('proposes but does not confirm disqualification for an unreachable product', async () => {
    const detail = await store.submissions.getSubmissionDetail(demoSubmissionId(33));
    const dq = detail?.disqualifications[0];
    expect(dq?.status).toBe('proposed');
    expect(dq?.reasonCode).toBe('artifact_inaccessible_after_retries');
    expect(dq?.proposedBy).toBe('system');
  });
});

describe('queue claiming', () => {
  it('leases jobs so two workers never claim the same one', async () => {
    // Re-queue an already-final submission: the fixture cohort's jobs are all
    // resolved, so there is nothing claimable until something is queued.
    await store.assessment.enqueueSubmission(demoSubmissionId(12));

    const first = await store.assessment.claimJobs({ workerId: 'worker-a', limit: 10, leaseSeconds: 60 });
    const second = await store.assessment.claimJobs({ workerId: 'worker-b', limit: 10, leaseSeconds: 60 });

    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
    const overlap = first.filter((job) => second.some((other) => other.id === job.id));
    expect(overlap).toHaveLength(0);
  });

  it('reclaims a crashed worker’s jobs once the lease expires', async () => {
    await store.assessment.enqueueSubmission(demoSubmissionId(12));

    const claimed = await store.assessment.claimJobs({ workerId: 'crashed', limit: 1, leaseSeconds: -1 });
    expect(claimed).toHaveLength(1);

    const reclaimed = await store.assessment.reclaimExpiredLeases();
    expect(reclaimed).toBeGreaterThan(0);

    const reclaimable = await store.assessment.claimJobs({ workerId: 'worker-b', limit: 1, leaseSeconds: 60 });
    expect(reclaimable).toHaveLength(1);
  });

  it('does not claim jobs already parked in a holding state', async () => {
    const claimed = await store.assessment.claimJobs({ workerId: 'w', limit: 20, leaseSeconds: 60 });
    // The fixture cohort's jobs are all completed/failed/manual_review.
    expect(claimed).toHaveLength(0);
  });

  it('reports queue statistics for the operator dashboard', async () => {
    const stats = await store.assessment.getQueueStats(DEMO_COHORT_ID);
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.byStage.completed).toBeGreaterThan(0);
    expect(stats.browserMinutesUsed).toBeGreaterThan(0);
    expect(stats.aiCallCount).toBeGreaterThan(0);
  });
});

describe('score override', () => {
  it('preserves the model’s original score alongside the human’s', async () => {
    const job = await store.assessment.getJobBySubmission(demoSubmissionId(12));
    const before = (await store.assessment.listScores(job?.id as string)).find(
      (s) => s.categoryKey === 'core_workflow',
    );

    const after = await store.assessment.overrideScore({
      jobId: job?.id as string,
      categoryKey: 'core_workflow',
      rawScore: 20,
      reason: 'Reviewer confirmed the share flow works manually.',
      actor: 'shared-admin',
    });

    expect(after.rawScore).toBe(20);
    expect(after.isOverridden).toBe(true);
    // The machine's answer survives, so disagreement stays measurable (ADR-012).
    expect(after.originalRawScore).toBe(before?.rawScore);
    expect(after.overrideReason).toMatch(/Reviewer confirmed/);
  });

  it('refuses an override with no reason', async () => {
    const job = await store.assessment.getJobBySubmission(demoSubmissionId(12));
    await expect(
      store.assessment.overrideScore({
        jobId: job?.id as string,
        categoryKey: 'core_workflow',
        rawScore: 25,
        reason: '   ',
        actor: 'shared-admin',
      }),
    ).rejects.toThrow(/reason/i);
  });

  it('recomputes the total after an override', async () => {
    const job = await store.assessment.getJobBySubmission(demoSubmissionId(12));
    const before = await store.assessment.getSummary(job?.id as string);

    await store.assessment.overrideScore({
      jobId: job?.id as string,
      categoryKey: 'core_workflow',
      rawScore: 10,
      reason: 'Core flow could not be reproduced on review.',
      actor: 'shared-admin',
    });

    const after = await store.assessment.getSummary(job?.id as string);
    expect(after?.totalScore).toBeLessThan(before?.totalScore as number);
  });
});

describe('ranking and final selection', () => {
  it('ranks only completed, fully-scored, non-disqualified submissions', async () => {
    const snapshot = await store.ranking.getCurrentSnapshot(DEMO_COHORT_ID);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.entries.length).toBe(3);
    expect(snapshot?.entries[0]?.entry.rank).toBe(1);
    // The unreachable, manual-review, and draft submissions are excluded.
    expect(snapshot?.entries.map((e) => e.groupNumber)).not.toContain(33);
    expect(snapshot?.entries.map((e) => e.groupNumber)).not.toContain(58);
    expect(snapshot?.entries.map((e) => e.groupNumber)).not.toContain(27);
  });

  it('puts the strongest submission first', async () => {
    const snapshot = await store.ranking.getCurrentSnapshot(DEMO_COHORT_ID);
    expect(snapshot?.entries[0]?.groupNumber).toBe(12);
  });

  it('regenerates a snapshot after an override, keeping the old one', async () => {
    const before = await store.ranking.listSnapshots(DEMO_COHORT_ID);
    await store.ranking.generateSnapshot(DEMO_COHORT_ID, 'After manual review.');
    const after = await store.ranking.listSnapshots(DEMO_COHORT_ID);

    expect(after.length).toBe(before.length + 1);
    expect(after.filter((s) => s.isCurrent)).toHaveLength(1);
    expect(after[0]?.notes).toBe('After manual review.');
  });

  it('requires exactly four winners', async () => {
    const snapshot = await store.ranking.getCurrentSnapshot(DEMO_COHORT_ID);
    const ids = snapshot?.entries.map((e) => e.submissionId) ?? [];

    await expect(
      store.ranking.setFinalSelection(
        DEMO_COHORT_ID,
        ids.slice(0, 2).map((submissionId, i) => ({ submissionId, position: i + 1, reason: 'x' })),
        'shared-admin',
      ),
    ).rejects.toThrow(/Exactly 4/);
  });

  it('records who selected the final four', async () => {
    const selections = [
      { submissionId: demoSubmissionId(12), position: 1, reason: 'Strongest working product.' },
      { submissionId: demoSubmissionId(45), position: 2, reason: 'Strong despite the share bug.' },
      { submissionId: demoSubmissionId(61), position: 3, reason: 'Good core idea.' },
      { submissionId: demoSubmissionId(33), position: 4, reason: 'Reinstated after review.' },
    ];
    const result = await store.ranking.setFinalSelection(DEMO_COHORT_ID, selections, 'shared-admin');

    expect(result).toHaveLength(4);
    expect(result.every((r) => r.selectedBy === 'shared-admin')).toBe(true);
    expect(result.map((r) => r.position).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('credentials', () => {
  it('stores only ciphertext and decrypts on an explicit reveal', async () => {
    const stored = await store.submissions.getCredentials(demoSubmissionId(45));
    expect(stored?.usernameCiphertext).toBeTruthy();
    expect(stored?.usernameCiphertext).not.toContain('demo.reviewer');

    const revealed = await store.submissions.revealCredentials(demoSubmissionId(45));
    expect(revealed?.username).toBe('demo.reviewer@demo.invalid');
    expect(revealed?.password).toBe('DemoReviewer!2026');
  });

  it('records when credentials were last revealed', async () => {
    await store.submissions.revealCredentials(demoSubmissionId(45));
    const stored = await store.submissions.getCredentials(demoSubmissionId(45));
    expect(stored?.lastRevealedAt).not.toBeNull();
  });

  it('destroys credential values on deletion but keeps the record', async () => {
    await store.submissions.deleteCredentials(demoSubmissionId(45));
    const stored = await store.submissions.getCredentials(demoSubmissionId(45));
    expect(stored).toBeNull();
    expect(await store.submissions.revealCredentials(demoSubmissionId(45))).toBeNull();
  });
});

describe('team import', () => {
  it('creates teams and issues one invite each', async () => {
    const result = await store.teams.importTeams(DEMO_COHORT_ID, [
      { groupNumber: 101, leadName: 'Lead A', leadEmail: 'a@example.com', leadPhone: '+1 555 0199' },
      { groupNumber: 102, leadName: 'Lead B', leadEmail: 'b@example.com', leadPhone: '+1 555 0198' },
    ]);

    expect(result.created).toHaveLength(2);
    expect(result.invites).toHaveLength(2);
    expect(result.invites[0]?.token).toBeTruthy();
  });

  it('skips duplicates and invalid rows with a stated reason', async () => {
    const result = await store.teams.importTeams(DEMO_COHORT_ID, [
      { groupNumber: 12, leadName: 'Duplicate', leadEmail: 'dup@example.com', leadPhone: '1' },
      { groupNumber: 9999, leadName: 'Out of range', leadEmail: 'x@example.com', leadPhone: '1' },
      { groupNumber: 103, leadName: 'Bad email', leadEmail: 'not-an-email', leadPhone: '1' },
    ]);

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped[0]?.reason).toMatch(/already exists/);
    expect(result.skipped[1]?.reason).toMatch(/between 1 and 999/);
    expect(result.skipped[2]?.reason).toMatch(/valid address/);
  });

  it('invalidates the old token when an invite is regenerated', async () => {
    await store.whenReady();
    const teamId = demoTeamId(12);
    const oldToken = store.getDemoInviteToken(teamId) as string;
    await store.teams.generateInvite(teamId);

    // The demo/invite shortcut mints a session; a revoked token cannot.
    expect(
      await store.participant.redeemInviteToken(oldToken, { name: 'Ana', role: null }),
    ).toBeNull();
    const newToken = store.getDemoInviteToken(teamId) as string;
    expect(
      await store.participant.redeemInviteToken(newToken, { name: 'Ana', role: null }),
    ).not.toBeNull();
  });
});
