import { createInMemoryStorage } from './storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { buildRankingStore } from './repositories/ranking';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';
import type { AssessmentStore, RankingStore } from '../store';
import type { CategoryScore, Cohort, Submission } from '../types';

/**
 * Ranking, the private shortlist, and the final four.
 *
 * Two things are being protected here. The first is that ranking is a *record*,
 * not a live calculation: two people looking at the Top 10 on the same evening
 * must see the same ten. The second is that the system never declares a winner
 * — it produces an ordering, and people choose from it.
 */

let db: PgliteHandle;
let assessment: AssessmentStore;
let ranking: RankingStore;
let cohort: Cohort;
let submissions: Submission[];

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Test rubric', true)`,
  );
  const seeded = await seedCohortWithSubmissions(db, 14);
  cohort = seeded.cohort;
  submissions = seeded.submissions;
  assessment = buildAssessmentStore(db, createInMemoryStorage());
  ranking = buildRankingStore(db);
  await assessment.enqueueCohort(cohort.id);
});

/** Score a submission so that its total is `total`, spread across every category. */
async function scoreSubmission(submissionId: string, total: number, confidence = 0.8) {
  const job = await assessment.getJobBySubmission(submissionId);
  const share = total / 100;
  await assessment.saveScores(
    job!.id,
    RUBRIC_CATEGORIES.map((category) => ({
      categoryKey: category.key,
      rawScore: category.maxPoints * share,
      maxPoints: category.maxPoints,
      weightedScore: category.maxPoints * share,
      confidence,
      rationale: 'Observed.',
      supportingEvidence: ['step 1'],
      contradictoryEvidence: [],
      missingEvidence: [],
      isOverridden: false,
      overrideReason: null,
      overriddenBy: null,
      overriddenAt: null,
      originalRawScore: null,
      modelVersion: 'test-model',
      promptVersion: 'test-prompt',
      rubricVersion: RUBRIC_VERSION,
    })) as Omit<CategoryScore, 'id' | 'jobId' | 'createdAt' | 'updatedAt'>[],
  );
  return job!.id;
}

async function scoreAll() {
  // Descending totals: submission 0 scores highest.
  for (const [index, submission] of submissions.entries()) {
    await scoreSubmission(submission.id, 90 - index * 2);
  }
}

// --------------------------------------------------------------------------

describe('generating a snapshot', () => {
  it('ranks every fully scored submission', async () => {
    await scoreAll();
    const snapshot = await ranking.generateSnapshot(cohort.id, 'first pass');

    expect(snapshot.eligibleCount).toBe(14);
    expect(snapshot.isCurrent).toBe(true);
    expect(snapshot.rubricVersion).toBe(RUBRIC_VERSION);
  });

  it('excludes a submission missing any category score', async () => {
    // Summing seven of eight categories produces a number that looks like a
    // score and is really a penalty for the system's own incomplete work.
    await scoreAll();
    const job = await assessment.getJobBySubmission(submissions[3]!.id);
    await db.query('delete from category_scores where job_id = $1 and category_key = $2', [
      job!.id,
      'deck_demo',
    ]);

    const snapshot = await ranking.generateSnapshot(cohort.id);
    expect(snapshot.eligibleCount).toBe(13);

    const current = await ranking.getCurrentSnapshot(cohort.id);
    expect(current?.entries.some((e) => e.submissionId === submissions[3]!.id)).toBe(false);
  });

  it('excludes a confirmed disqualification but not a proposed one', async () => {
    await scoreAll();
    const proposed = await assessment.proposeDisqualification({
      submissionId: submissions[1]!.id,
      reasonCode: 'missing_pdf_deck',
      reasonDetail: '',
      evidence: {},
      status: 'proposed',
      proposedBy: 'system',
      confirmedBy: null,
      reversedBy: null,
      reversedReason: null,
    });

    // Proposed only: nobody has decided, so the team is still ranked.
    let snapshot = await ranking.generateSnapshot(cohort.id);
    expect(snapshot.eligibleCount).toBe(14);

    await assessment.confirmDisqualification(proposed.id, 'shared-admin');
    snapshot = await ranking.generateSnapshot(cohort.id);
    expect(snapshot.eligibleCount).toBe(13);
  });

  it('brings a team back when a disqualification is reversed', async () => {
    await scoreAll();
    const dq = await assessment.proposeDisqualification({
      submissionId: submissions[2]!.id, reasonCode: 'missing_demo_link', reasonDetail: '', evidence: {}, status: 'proposed', proposedBy: 'system', confirmedBy: null, reversedBy: null, reversedReason: null,
    });
    await assessment.confirmDisqualification(dq.id, 'admin');
    await assessment.reverseDisqualification(dq.id, 'admin', 'The link was in the deck.');

    const snapshot = await ranking.generateSnapshot(cohort.id);
    expect(snapshot.eligibleCount).toBe(14);
  });

  it('keeps exactly one current snapshot', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id, 'first');
    await ranking.generateSnapshot(cohort.id, 'second');

    const { rows } = await db.query(
      'select count(*) as n from ranking_snapshots where cohort_id = $1 and is_current',
      [cohort.id],
    );
    expect(Number((rows[0] as { n: unknown }).n)).toBe(1);
    expect(await ranking.listSnapshots(cohort.id)).toHaveLength(2);
  });

  it('is a record, not a live calculation', async () => {
    // Changing a score after the fact must not silently reorder a list someone
    // has already read.
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const before = await ranking.getCurrentSnapshot(cohort.id);

    await assessment.overrideScore({
      jobId: (await assessment.getJobBySubmission(submissions[13]!.id))!.id,
      categoryKey: 'core_workflow',
      rawScore: 25,
      reason: 'Reviewed and corrected.',
      actor: 'admin',
    });

    const after = await ranking.getCurrentSnapshot(cohort.id);
    expect(after?.entries.map((e) => e.submissionId)).toEqual(
      before?.entries.map((e) => e.submissionId),
    );
  });
});

describe('the ordering', () => {
  it('puts the highest total first', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const current = await ranking.getCurrentSnapshot(cohort.id);

    expect(current?.entries[0]?.submissionId).toBe(submissions[0]!.id);
    expect(current?.entries.map((e) => e.entry.rank)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
  });

  it('breaks a tie deterministically rather than arbitrarily', async () => {
    // Two runs of the same data must produce the same order, or "the Top 10"
    // depends on when you asked.
    for (const submission of submissions) await scoreSubmission(submission.id, 60);

    await ranking.generateSnapshot(cohort.id);
    const first = (await ranking.getCurrentSnapshot(cohort.id))!.entries.map((e) => e.submissionId);
    await ranking.generateSnapshot(cohort.id);
    const second = (await ranking.getCurrentSnapshot(cohort.id))!.entries.map((e) => e.submissionId);

    expect(second).toEqual(first);
  });

  it('records what was compared, so a placement can be explained', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const current = await ranking.getCurrentSnapshot(cohort.id);

    expect(current?.entries[0]?.entry.tiebreakVector).toMatchObject({
      total: expect.any(Number),
      core_workflow: expect.any(Number),
      unresolvedRisks: expect.any(Number),
    });
  });

  it('ranks a team with an open review flag below an equal-scoring team without one', async () => {
    for (const submission of submissions) await scoreSubmission(submission.id, 70);
    await assessment.raiseManualReview({
      submissionId: submissions[0]!.id, reasonCode: 'contradictory_evidence', detail: '', raisedBy: 'system', status: 'open', resolvedBy: null, resolvedAt: null, resolutionNote: null,
    });

    await ranking.generateSnapshot(cohort.id);
    const current = await ranking.getCurrentSnapshot(cohort.id);
    const flagged = current!.entries.findIndex((e) => e.submissionId === submissions[0]!.id);

    expect(flagged).toBeGreaterThan(0);
  });
});

describe('the shortlist', () => {
  it('marks the cohort target and no more', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const current = await ranking.getCurrentSnapshot(cohort.id);

    expect(current?.entries.filter((e) => e.entry.inShortlist)).toHaveLength(10);
    expect(current?.entries.slice(0, 10).every((e) => e.entry.inShortlist)).toBe(true);
  });

  it('carries its caveats, so a thin ranking does not look solid', async () => {
    await scoreAll();
    const job = await assessment.getJobBySubmission(submissions[0]!.id);
    await assessment.saveSummary({
      jobId: job!.id, totalScore: 0, meanConfidence: 0, minConfidence: 0, lowConfidence: true,
      risks: [], strengths: [], weaknesses: [], internalNotes: null, bugsFound: [],
      modelVersion: 'm', promptVersion: 'p', completedAt: new Date(),
    });
    await assessment.raiseManualReview({
      submissionId: submissions[0]!.id, reasonCode: 'low_confidence', detail: '', raisedBy: 'system', status: 'open', resolvedBy: null, resolvedAt: null, resolutionNote: null,
    });

    await ranking.generateSnapshot(cohort.id);
    const current = await ranking.getCurrentSnapshot(cohort.id);
    const entry = current!.entries.find((e) => e.submissionId === submissions[0]!.id);

    expect(entry?.lowConfidence).toBe(true);
    expect(entry?.hasOpenManualReview).toBe(true);
  });

  it('shortlists everyone when there are fewer than the target', async () => {
    await scoreSubmission(submissions[0]!.id, 80);
    await scoreSubmission(submissions[1]!.id, 70);
    await ranking.generateSnapshot(cohort.id);

    const current = await ranking.getCurrentSnapshot(cohort.id);
    expect(current?.entries).toHaveLength(2);
    expect(current?.entries.every((e) => e.entry.inShortlist)).toBe(true);
  });

  it('returns null before any ranking exists', async () => {
    expect(await ranking.getCurrentSnapshot(cohort.id)).toBeNull();
  });
});

describe('the final four', () => {
  const four = (ids: string[]) =>
    ids.map((submissionId, index) => ({ submissionId, position: index + 1, reason: 'Chosen by the panel.' }));

  it('is recorded against the human who chose it', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const top = (await ranking.getCurrentSnapshot(cohort.id))!.entries.slice(0, 4);

    const saved = await ranking.setFinalSelection(
      cohort.id,
      four(top.map((e) => e.submissionId)),
      'shared-admin',
    );

    expect(saved).toHaveLength(4);
    expect(saved.every((s) => s.selectedBy === 'shared-admin')).toBe(true);
    expect((await ranking.listFinalSelections(cohort.id)).map((s) => s.position)).toEqual([1, 2, 3, 4]);
  });

  it('cannot be set before a ranking exists', async () => {
    // The system does not rank on demand at selection time — choosing from
    // nothing would mean the panel picked without a list in front of them.
    await expect(
      ranking.setFinalSelection(cohort.id, four(submissions.slice(0, 4).map((s) => s.id)), 'admin'),
    ).rejects.toThrow(/no current ranking/i);
  });

  it('refuses a team that is not in the ranking', async () => {
    await scoreAll();
    const job = await assessment.getJobBySubmission(submissions[5]!.id);
    await db.query('delete from category_scores where job_id = $1', [job!.id]);
    await ranking.generateSnapshot(cohort.id);

    await expect(
      ranking.setFinalSelection(
        cohort.id,
        four([submissions[0]!.id, submissions[1]!.id, submissions[2]!.id, submissions[5]!.id]),
        'admin',
      ),
    ).rejects.toThrow(/not eligible/i);
  });

  it('refuses anything other than exactly four', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const ids = submissions.slice(0, 5).map((s) => s.id);

    await expect(ranking.setFinalSelection(cohort.id, four(ids.slice(0, 3)), 'a')).rejects.toThrow();
    await expect(ranking.setFinalSelection(cohort.id, four(ids), 'a')).rejects.toThrow();
  });

  it('refuses the same team in two positions', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const id = submissions[0]!.id;

    await expect(
      ranking.setFinalSelection(
        cohort.id,
        four([id, id, submissions[1]!.id, submissions[2]!.id]),
        'a',
      ),
    ).rejects.toThrow();
  });

  it('replaces a previous selection wholesale', async () => {
    // A partial update could leave three finalists from one decision and one
    // from an earlier one, with nothing in the rows to show it.
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    const ids = submissions.map((s) => s.id);

    await ranking.setFinalSelection(cohort.id, four(ids.slice(0, 4)), 'admin');
    await ranking.setFinalSelection(cohort.id, four(ids.slice(4, 8)), 'admin');

    const finals = await ranking.listFinalSelections(cohort.id);
    expect(finals).toHaveLength(4);
    expect(finals.map((f) => f.submissionId).sort()).toEqual(ids.slice(4, 8).sort());
  });

  it('can be cleared', async () => {
    await scoreAll();
    await ranking.generateSnapshot(cohort.id);
    await ranking.setFinalSelection(cohort.id, four(submissions.slice(0, 4).map((s) => s.id)), 'admin');
    await ranking.clearFinalSelection(cohort.id, 'admin');

    expect(await ranking.listFinalSelections(cohort.id)).toEqual([]);
  });
});
