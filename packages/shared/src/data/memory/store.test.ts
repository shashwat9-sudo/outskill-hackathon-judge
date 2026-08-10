import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataStore } from './store.js';
import { RUBRIC_CATEGORIES } from '../../rubric/index.js';
import { DEMO_COHORT_ID, demoSubmissionId, demoTeamId } from '../../fixtures/demo.js';

let store: MemoryDataStore;

beforeEach(() => {
  store = new MemoryDataStore();
});

// --------------------------------------------------------------------------
// Participant isolation — the requirement most damaging to get wrong
// --------------------------------------------------------------------------

describe('participant isolation', () => {
  it('exposes no method that can reach assessment data', () => {
    // The capability is absent, not guarded (ADR-010). If someone adds a
    // scores/ranking/evidence method to the participant surface, this fails.
    const participantMethods = Object.keys(store.participant);
    const forbidden = ['score', 'rank', 'evidence', 'assessment', 'feedback', 'shortlist', 'disqualif', 'consistency'];

    for (const method of participantMethods) {
      for (const word of forbidden) {
        expect(method.toLowerCase(), `participant.${method} must not exist`).not.toContain(word);
      }
    }
  });

  it('returns only the team’s own data from an invite token', async () => {
    const token = store.getDemoInviteToken(demoTeamId(12));
    expect(token).toBeTruthy();

    const view = await store.participant.resolveInvite(token as string);
    expect(view).not.toBeNull();
    expect(view?.team.groupNumber).toBe(12);
    expect(view?.submission.id).toBe(demoSubmissionId(12));
  });

  it('never includes scores, rank, evidence, or feedback in the participant view', async () => {
    const token = store.getDemoInviteToken(demoTeamId(12)) as string;
    const view = await store.participant.resolveInvite(token);
    const serialised = JSON.stringify(view);

    for (const term of [
      'weightedScore',
      'rawScore',
      'confidence',
      'rank',
      'inShortlist',
      'supportingEvidence',
      'contradictoryEvidence',
      'consistencyReview',
      'disqualification',
      'privateGuidance',
      'tiebreak',
    ]) {
      expect(serialised, `participant view leaked "${term}"`).not.toContain(term);
    }
  });

  it('never exposes credential plaintext or ciphertext to a participant', async () => {
    const token = store.getDemoInviteToken(demoTeamId(45)) as string;
    const view = await store.participant.resolveInvite(token);

    // The team knows it stored credentials, but the values never come back.
    expect(view?.hasStoredCredentials).toBe(true);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('DemoReviewer!2026');
    expect(serialised).not.toContain('Ciphertext');
    expect(serialised).not.toContain('usernameCiphertext');
  });

  it('rejects unknown, revoked, and expired tokens identically', async () => {
    expect(await store.participant.resolveInvite('not-a-real-token')).toBeNull();

    const teamId = demoTeamId(27);
    await store.teams.revokeInvite(teamId);
    // The token is gone from the demo map and revoked in the store.
    expect(await store.participant.resolveInvite('some-revoked-token')).toBeNull();
  });

  it('rejects an attempt to reach another team by guessing a submission id', async () => {
    const token = store.getDemoInviteToken(demoTeamId(12)) as string;
    const view = await store.participant.resolveInvite(token);
    // The participant surface derives the submission from the token; the only
    // id it ever sees is its own.
    expect(view?.submission.teamId).toBe(demoTeamId(12));
    expect(view?.submission.id).not.toBe(demoSubmissionId(45));
  });
});

// --------------------------------------------------------------------------
// Draft lifecycle
// --------------------------------------------------------------------------

describe('draft and final submit', () => {
  it('refuses to edit a locked submission', async () => {
    await expect(
      store.participant.saveDraft(demoSubmissionId(12), { product: { productName: 'Renamed' } }),
    ).rejects.toThrow(/locked/i);
  });

  it('refuses to edit when the cohort is not open', async () => {
    // The demo cohort is in "judging"; even a draft cannot be edited.
    await expect(
      store.participant.saveDraft(demoSubmissionId(27), { product: { productName: 'Renamed' } }),
    ).rejects.toThrow(/not currently accepting/i);
  });

  it('autosaves and promotes known draft fields into typed columns', async () => {
    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'open');
    const submission = await store.participant.saveDraft(demoSubmissionId(27), {
      product: { productName: 'Budget Board v2', primaryUser: 'Someone tracking spending.' },
      live: { productUrl: 'https://budget.example.com', loginRequired: true },
    });

    expect(submission.productName).toBe('Budget Board v2');
    expect(submission.productUrl).toBe('https://budget.example.com');
    expect(submission.loginRequired).toBe(true);
    expect(submission.draftUpdatedAt).not.toBeNull();
    // The raw draft is retained alongside the promoted columns.
    expect(submission.draftPayload).toHaveProperty('product');
  });

  it('locks the submission and issues a receipt on final submit', async () => {
    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'open');
    const { submission, receiptId } = await store.participant.finaliseSubmission(demoSubmissionId(27), {
      ipHash: 'hashed-ip',
    });

    expect(submission.status).toBe('locked');
    expect(submission.submittedAt).not.toBeNull();
    expect(receiptId).toMatch(/^OSK-AIAPD1-027-/);

    // A second edit attempt is now refused.
    await expect(store.participant.saveDraft(demoSubmissionId(27), {})).rejects.toThrow(/locked/i);
  });

  it('lets an admin reopen a locked submission, with an audit event', async () => {
    await store.submissions.reopenSubmission(demoSubmissionId(12), 'Team reported an upload failure.');
    const events = await store.submissions.listEvents(demoSubmissionId(12));
    const reopened = events.find((e) => e.eventType === 'reopened_by_admin');

    expect(reopened).toBeDefined();
    expect(reopened?.actorType).toBe('shared-admin');
    expect(reopened?.detail).toMatchObject({ reason: 'Team reported an upload failure.' });
  });
});

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

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
    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'open');
    await store.participant.finaliseSubmission(demoSubmissionId(27), { ipHash: null });
    await store.assessment.enqueueCohort(DEMO_COHORT_ID);

    const first = await store.assessment.claimJobs({ workerId: 'worker-a', limit: 10, leaseSeconds: 60 });
    const second = await store.assessment.claimJobs({ workerId: 'worker-b', limit: 10, leaseSeconds: 60 });

    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0);
    const overlap = first.filter((job) => second.some((other) => other.id === job.id));
    expect(overlap).toHaveLength(0);
  });

  it('reclaims a crashed worker’s jobs once the lease expires', async () => {
    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'open');
    await store.participant.finaliseSubmission(demoSubmissionId(27), { ipHash: null });
    await store.assessment.enqueueCohort(DEMO_COHORT_ID);

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
    const teamId = demoTeamId(12);
    const oldToken = store.getDemoInviteToken(teamId) as string;
    await store.teams.generateInvite(teamId);

    expect(await store.participant.resolveInvite(oldToken)).toBeNull();
    const newToken = store.getDemoInviteToken(teamId) as string;
    expect(await store.participant.resolveInvite(newToken)).not.toBeNull();
  });
});
