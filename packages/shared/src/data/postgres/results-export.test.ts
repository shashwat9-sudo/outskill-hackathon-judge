import { createInMemoryStorage } from './storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { buildRankingStore } from './repositories/ranking';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';
import { buildResultsFeedbackCsv, selectResultsForExport } from '../../domain/results-export';
import { parseCsv } from '../../utils/csv';
import type { AssessmentStore, RankingStore } from '../store';
import type { CategoryScore, Cohort, Submission } from '../types';

/**
 * The results export read from real tables.
 *
 * A snapshot with six ranked products: two with feedback, one whose feedback
 * failed, three still pending; one human override, one open review flag, one
 * proposed disqualification, and four recorded winners. Every one of the six
 * must come back, the export must describe the snapshot as stored, and the
 * coverage counts must add up.
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
  const seeded = await seedCohortWithSubmissions(db, 6);
  cohort = seeded.cohort;
  submissions = seeded.submissions;
  assessment = buildAssessmentStore(db, createInMemoryStorage());
  ranking = buildRankingStore(db);
  await assessment.enqueueCohort(cohort.id);
});

async function score(submissionId: string, total: number) {
  const job = await assessment.getJobBySubmission(submissionId);
  const share = total / 100;
  await assessment.saveScores(
    job!.id,
    RUBRIC_CATEGORIES.map((category) => ({
      categoryKey: category.key,
      rawScore: category.maxPoints * share,
      maxPoints: category.maxPoints,
      weightedScore: category.maxPoints * share,
      confidence: 0.8,
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
  await db.query(`update assessment_jobs set stage = 'completed' where id = $1`, [job!.id]);
  return job!.id;
}

async function arrange() {
  for (const [index, submission] of submissions.entries()) await score(submission.id, 90 - index * 5);

  // Feedback: two reports, one failure, three still pending.
  for (const [index, submission] of submissions.slice(0, 2).entries()) {
    await assessment.saveFeedbackReport({
      submissionId: submission.id,
      productSummary: `Summary for Product ${index + 1}`,
      strengths: ['a', 'b', 'c'],
      improvements: [{ title: 'Do', detail: 'this', priority: 1 }],
      bugs: [{ description: 'bug', evidence: 'step 3' }],
      nextSevenDayPlan: ['ship'],
      isExposedToParticipant: false,
      generatedAt: new Date(),
      modelVersion: 'm',
      promptVersion: 'p',
    });
    // As the worker records it once a report is stored.
    const job = await assessment.getJobBySubmission(submission.id);
    await assessment.setFeedbackStatus(job!.id, { status: 'generated', error: null, attempts: 1 });
  }
  const failedJob = await assessment.getJobBySubmission(submissions[2]!.id);
  await assessment.setFeedbackStatus(failedJob!.id, { status: 'failed', error: 'Withheld: mentions rank', attempts: 3 });

  await assessment.raiseManualReview({
    submissionId: submissions[3]!.id,
    reasonCode: 'low_confidence_scores',
    detail: 'thin evidence',
    raisedBy: 'system',
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
  });
  await assessment.proposeDisqualification({
    submissionId: submissions[4]!.id,
    reasonCode: 'missing_demo_link',
    reasonDetail: 'No Loom',
    evidence: {},
    status: 'proposed',
    proposedBy: 'system',
    confirmedBy: null,
    reversedBy: null,
    reversedReason: null,
  });

  await ranking.generateSnapshot(cohort.id, 'export test');
  await ranking.setFinalSelection(
    cohort.id,
    submissions.slice(0, 4).map((s, index) => ({ submissionId: s.id, position: index + 1, reason: `Winner ${index + 1}` })),
    'shared-admin',
  );
}

describe('listRankedResults', () => {
  it('returns every ranked entry, in rank order, with scores, flags and winners', async () => {
    await arrange();
    const rows = await ranking.listRankedResults(cohort.id);

    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.map((r) => r.submissionId)).toEqual(submissions.map((s) => s.id));
    expect(rows[0]!.cohortName).toBe(cohort.name);
    expect(rows[0]!.cohortCode).toBe(cohort.code);
    expect(rows[0]!.totalScore).toBe(90);
    expect(rows[0]!.productUrl).toBe('https://product-1.example.com');
    expect(rows[0]!.ideaTitle).toBe('Test idea');
    expect(rows[0]!.assessmentStage).toBe('completed');
    expect(Object.keys(rows[0]!.categoryScores).sort()).toEqual(RUBRIC_CATEGORIES.map((c) => c.key).sort());
    expect(rows[0]!.categoryScores.core_workflow).toEqual({ rawScore: 22.5, maxPoints: 25, confidence: 0.8, isOverridden: false });

    expect(rows.slice(0, 4).map((r) => r.finalPosition)).toEqual([1, 2, 3, 4]);
    expect(rows[0]!.finalSelectionReason).toBe('Winner 1');
    expect(rows[4]!.finalPosition).toBeNull();

    expect(rows[3]!.openManualReviewReasons).toEqual(['low_confidence_scores']);
    expect(rows[4]!.disqualification).toEqual({ status: 'proposed', reasonCode: 'missing_demo_link', reasonDetail: 'No Loom' });
    expect(rows[0]!.disqualification).toBeNull();
  });

  it('keeps products without feedback and says why', async () => {
    await arrange();
    const rows = await ranking.listRankedResults(cohort.id);

    expect(rows[0]!.feedback?.productSummary).toBe('Summary for Product 1');
    expect(rows[0]!.feedbackStatus).toBe('generated');
    expect(rows[2]!.feedback).toBeNull();
    expect(rows[2]!.feedbackStatus).toBe('failed');
    expect(rows[2]!.feedbackError).toBe('Withheld: mentions rank');
    expect(rows[2]!.feedbackAttempts).toBe(3);
    expect(rows[5]!.feedback).toBeNull();
    expect(rows[5]!.feedbackStatus).toBe('pending');

    const csv = buildResultsFeedbackCsv(rows);
    const [headers, ...records] = parseCsv(csv);
    expect(records).toHaveLength(6);
    const status = headers!.indexOf('Feedback Status');
    expect(records.map((r) => r[status])).toEqual(['ready', 'ready', 'failed', 'pending', 'pending', 'pending']);
  });

  it('shows the effective overridden score while the stored snapshot stays put', async () => {
    await arrange();
    const before = (await ranking.getCurrentSnapshot(cohort.id))!.entries.map((e) => e.entry.totalScore);
    const job = await assessment.getJobBySubmission(submissions[0]!.id);
    await assessment.overrideScore({ jobId: job!.id, categoryKey: 'core_workflow', rawScore: 5, reason: 'Browser showed less', actor: 'shared-admin' });

    const rows = await ranking.listRankedResults(cohort.id);
    expect(rows[0]!.categoryScores.core_workflow?.rawScore).toBe(5);
    expect(rows[0]!.categoryScores.core_workflow?.isOverridden).toBe(true);
    // The snapshot is a record: totals and ranks are as generated.
    expect(rows[0]!.totalScore).toBe(90);
    expect((await ranking.getCurrentSnapshot(cohort.id))!.entries.map((e) => e.entry.totalScore)).toEqual(before);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('supports the shortlist and top-N scopes on the same rows', async () => {
    await arrange();
    await db.query('update cohorts set shortlist_target = 2 where id = $1', [cohort.id]);
    await ranking.generateSnapshot(cohort.id, 'smaller shortlist');
    const rows = await ranking.listRankedResults(cohort.id);
    expect(rows).toHaveLength(6);
    expect(selectResultsForExport(rows, 'shortlist').map((r) => r.rank)).toEqual([1, 2]);
    expect(selectResultsForExport(rows, 'top', 4).map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(selectResultsForExport(rows, 'all')).toHaveLength(6);
  });

  it('returns nothing before a snapshot exists, and nothing from another cohort', async () => {
    expect(await ranking.listRankedResults(cohort.id)).toEqual([]);
    await arrange();
    const { rows } = await db.query<{ id: string }>(`select gen_random_uuid() as id`);
    expect(await ranking.listRankedResults(rows[0]!.id)).toEqual([]);
  });

  it('never carries a credential, ciphertext, path or prompt', async () => {
    await arrange();
    const serialised = JSON.stringify(await ranking.listRankedResults(cohort.id)).toLowerCase();
    for (const forbidden of ['ciphertext', 'password', 'storage_path', 'storagepath', 'trace', 'prompt:', 'token']) {
      expect(serialised, `export row carries ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('getFeedbackCoverage', () => {
  it('counts completed assessments by feedback state, whatever the cohort size', async () => {
    await arrange();
    expect(await assessment.getFeedbackCoverage(cohort.id)).toEqual({
      completed: 6,
      ready: 2,
      pending: 3,
      generating: 0,
      failed: 1,
    });
  });

  it('ignores jobs that have not completed and cohorts that are not this one', async () => {
    await score(submissions[0]!.id, 80);
    await db.query(`update assessment_jobs set stage = 'browser_testing' where submission_id = $1`, [submissions[1]!.id]);
    expect(await assessment.getFeedbackCoverage(cohort.id)).toEqual({ completed: 1, ready: 0, pending: 1, generating: 0, failed: 0 });
    const { rows } = await db.query<{ id: string }>(`select gen_random_uuid() as id`);
    expect(await assessment.getFeedbackCoverage(rows[0]!.id)).toEqual({ completed: 0, ready: 0, pending: 0, generating: 0, failed: 0 });
  });
});
