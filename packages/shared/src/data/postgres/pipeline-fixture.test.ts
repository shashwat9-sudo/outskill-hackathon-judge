import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { buildRankingStore } from './repositories/ranking';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';
import type { AssessmentStore, RankingStore } from '../store';
import type { CategoryScore, Cohort, Submission } from '../types';

/**
 * The whole pipeline, end to end, on synthetic data.
 *
 * Every stage from queue to private Top 10, with the model's outputs supplied
 * as fixtures rather than generated. No external call, no key, no cost, no real
 * learner work.
 *
 * The point is not to test the stages again — each has its own suite. It is to
 * prove they compose: that what artifact analysis writes is what scoring can
 * read, that evidence survives to the summary, and that a submission which goes
 * to manual review does not silently appear in the shortlist anyway. Those are
 * the failures that only appear when the parts are joined.
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
    `insert into rubric_versions (version, name, is_active) values ('rubric-v1', 'Test rubric', true)`,
  );
  const seeded = await seedCohortWithSubmissions(db, 12);
  cohort = seeded.cohort;
  submissions = seeded.submissions;
  assessment = buildAssessmentStore(db);
  ranking = buildRankingStore(db);
});

// --------------------------------------------------------------------------
// Fixture model outputs — the shapes a provider would return.
// --------------------------------------------------------------------------

const MODEL = 'fixture-model-1';
const PROMPT = 'fixture-prompt-1';

function scoresFor(total: number): Omit<CategoryScore, 'id' | 'jobId' | 'createdAt' | 'updatedAt'>[] {
  const share = total / 100;
  return RUBRIC_CATEGORIES.map((category) => ({
    categoryKey: category.key,
    rawScore: category.maxPoints * share,
    maxPoints: category.maxPoints,
    weightedScore: category.maxPoints * share,
    confidence: 0.82,
    rationale: `Observed during the browser run for ${category.key}.`,
    supportingEvidence: [`browser step 3 (${category.key})`],
    contradictoryEvidence: [],
    missingEvidence: [],
    isOverridden: false,
    overrideReason: null,
    overriddenBy: null,
    overriddenAt: null,
    originalRawScore: null,
    modelVersion: MODEL,
    promptVersion: PROMPT,
    rubricVersion: RUBRIC_VERSION,
  })) as Omit<CategoryScore, 'id' | 'jobId' | 'createdAt' | 'updatedAt'>[];
}

/** Drive one submission through every stage, as the worker would. */
async function runFullPipeline(submission: Submission, total: number) {
  const job = (await assessment.getJobBySubmission(submission.id))!;

  // --- preflight ---
  await assessment.advanceStage(job.id, 'preflight');
  await assessment.recordPreflight(job.id, [
    { checkKey: 'product_url_present', status: 'pass', attemptNumber: 1, failureClass: 'none', detail: {}, checkedAt: new Date() },
    { checkKey: 'product_url_reachable', status: 'pass', attemptNumber: 1, failureClass: 'none', detail: { ms: 820 }, checkedAt: new Date() },
    { checkKey: 'deck_present', status: 'pass', attemptNumber: 1, failureClass: 'none', detail: {}, checkedAt: new Date() },
  ]);

  // --- artifact analysis ---
  await assessment.advanceStage(job.id, 'artifact_analysis');
  await assessment.saveArtifactAnalysis({
    jobId: job.id,
    deckPageCount: 9,
    deckTextExtracted: true,
    deckAnalysis: { problemStated: true, targetUserNamed: true },
    videoAnalysisLimited: true,
    videoLimitationReason: 'The system cannot watch video.',
    transcriptAvailable: false,
    writtenAnalysis: { claimedFeatures: 4 },
    injectionFlags: [],
    modelVersion: MODEL,
    promptVersion: PROMPT,
  });

  // --- test plan ---
  await assessment.advanceStage(job.id, 'test_plan_generation');
  await assessment.saveTestPlan(
    {
      jobId: job.id,
      generatedFrom: { idea: 'test-idea', declaredWorkflow: 'create → list → complete' },
      stepCount: 0,
      estimatedDurationMs: 120_000,
      modelVersion: MODEL,
      promptVersion: PROMPT,
      validationStatus: 'valid',
      rejectedSteps: [],
      summary: 'Exercise the declared core flow.',
    },
    [
      { stepIndex: 0, step: { action: 'navigate', url: submission.productUrl } as never, isCleanup: false, rationale: 'Open the product.' },
      { stepIndex: 1, step: { action: 'click', target: { role: 'button', name: 'New' } } as never, isCleanup: false, rationale: 'Start the flow.' },
      { stepIndex: 2, step: { action: 'assertText', text: 'Created' } as never, isCleanup: false, rationale: 'Confirm it worked.' },
      { stepIndex: 3, step: { action: 'cleanup' } as never, isCleanup: true, rationale: 'Remove test data.' },
    ],
  );

  // --- browser run ---
  await assessment.advanceStage(job.id, 'browser_testing');
  await assessment.saveBrowserRun(
    {
      jobId: job.id,
      viewport: 'desktop',
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 96_000,
      status: 'passed',
      browserVersion: 'chromium-fixture',
      tracePath: null,
      consoleErrorCount: 0,
      networkFailureCount: 0,
      a11yViolationCount: 2,
      a11ySummary: { serious: 1, moderate: 1 },
      cleanupStatus: 'complete',
      timedOut: false,
    },
    [
      { stepIndex: 0, action: 'navigate', status: 'passed', durationMs: 800, screenshotPath: 'a.png', assertionDetail: {}, errorMessage: null },
      { stepIndex: 1, action: 'click', status: 'passed', durationMs: 200, screenshotPath: null, assertionDetail: {}, errorMessage: null },
      { stepIndex: 2, action: 'assertText', status: 'passed', durationMs: 120, screenshotPath: 'b.png', assertionDetail: { found: 'Created' }, errorMessage: null },
      { stepIndex: 3, action: 'cleanup', status: 'passed', durationMs: 300, screenshotPath: null, assertionDetail: {}, errorMessage: null },
    ],
  );

  // --- evidence ---
  await assessment.advanceStage(job.id, 'evidence_review');
  await assessment.saveEvidence(job.id, [
    { categoryKey: 'core_workflow', evidenceType: 'browser_step', stance: 'supporting', summary: 'The declared flow completed.', sourceRef: { step: 2 }, confidence: 0.9 },
    { categoryKey: 'ux_accessibility', evidenceType: 'a11y', stance: 'contradictory', summary: 'One serious accessibility violation.', sourceRef: { impact: 'serious' }, confidence: 0.8 },
    { categoryKey: 'deck_demo', evidenceType: 'video', stance: 'missing', summary: 'The demo video was not watched.', sourceRef: {}, confidence: 0.3 },
  ]);

  // --- scoring ---
  await assessment.advanceStage(job.id, 'scoring');
  await assessment.saveScores(job.id, scoresFor(total));
  await assessment.saveSummary({
    jobId: job.id,
    totalScore: 0,
    meanConfidence: 0,
    minConfidence: 0,
    lowConfidence: false,
    risks: [],
    strengths: ['The core workflow completed end to end.'],
    weaknesses: ['One serious accessibility violation.'],
    internalNotes: null,
    bugsFound: [],
    modelVersion: MODEL,
    promptVersion: PROMPT,
    completedAt: new Date(),
  });

  // --- feedback ---
  await assessment.saveFeedbackReport({
    submissionId: submission.id,
    productSummary: 'Observed: the core flow completed. Claimed: AI ranking (not verified).',
    strengths: ['The declared workflow works.'],
    improvements: [{ title: 'Fix the serious accessibility violation', detail: 'Observed on the main form.', priority: 1 }],
    bugs: [],
    nextSevenDayPlan: ['Address the accessibility finding'],
    isExposedToParticipant: false,
    generatedAt: new Date(),
    modelVersion: MODEL,
    promptVersion: PROMPT,
  });

  await assessment.advanceStage(job.id, 'completed');
  return job.id;
}

// --------------------------------------------------------------------------

describe('a synthetic cohort, end to end', () => {
  it('carries one submission from queue to completed', async () => {
    const queued = await assessment.enqueueCohort(cohort.id);
    expect(queued.queued).toBe(12);

    const jobId = await runFullPipeline(submissions[0]!, 84);
    const job = await assessment.getJob(jobId);

    expect(job?.stage).toBe('completed');
    expect(job?.completedAt).not.toBeNull();
    expect(job?.claimedBy).toBeNull();
  });

  it('keeps every stage output readable by the next', async () => {
    await assessment.enqueueCohort(cohort.id);
    const jobId = await runFullPipeline(submissions[0]!, 84);

    expect(await assessment.listPreflight(jobId)).toHaveLength(3);
    expect((await assessment.getTestPlan(jobId))?.steps).toHaveLength(4);
    expect(await assessment.listBrowserRuns(jobId)).toHaveLength(1);
    expect(await assessment.listEvidence(jobId)).toHaveLength(3);
    expect(await assessment.listScores(jobId)).toHaveLength(8);
    expect(await assessment.getSummary(jobId)).not.toBeNull();
    expect(await assessment.getFeedbackReport(submissions[0]!.id)).not.toBeNull();
  });

  it('totals the eight categories to the score it was given', async () => {
    await assessment.enqueueCohort(cohort.id);
    const jobId = await runFullPipeline(submissions[0]!, 84);

    const summary = await assessment.getSummary(jobId);
    expect(summary?.totalScore).toBeCloseTo(84, 1);
  });

  it('records that the video was never watched', async () => {
    // The gap has to survive all the way to the evidence, or the deck score
    // looks like a judgement rather than a guess.
    await assessment.enqueueCohort(cohort.id);
    const jobId = await runFullPipeline(submissions[0]!, 84);

    const missing = (await assessment.listEvidence(jobId)).filter((e) => e.stance === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.summary).toMatch(/not watched/i);
  });
});

describe('the full cohort, through to a private Top 10', () => {
  beforeEach(async () => {
    await assessment.enqueueCohort(cohort.id);
    for (const [index, submission] of submissions.entries()) {
      await runFullPipeline(submission, 92 - index * 3);
    }
  });

  it('ranks every completed submission', async () => {
    const snapshot = await ranking.generateSnapshot(cohort.id, 'fixture run');
    expect(snapshot.eligibleCount).toBe(12);
  });

  it('marks exactly ten for the shortlist', async () => {
    await ranking.generateSnapshot(cohort.id);
    const current = await ranking.getCurrentSnapshot(cohort.id);

    expect(current?.entries.filter((e) => e.entry.inShortlist)).toHaveLength(10);
    expect(current?.entries[0]?.submissionId).toBe(submissions[0]!.id);
  });

  it('names no winner', async () => {
    // The system produces an ordering. Choosing the final four is a human act.
    await ranking.generateSnapshot(cohort.id);
    expect(await ranking.listFinalSelections(cohort.id)).toEqual([]);
  });

  it('lets a human select four from the ranked list', async () => {
    await ranking.generateSnapshot(cohort.id);
    const top = (await ranking.getCurrentSnapshot(cohort.id))!.entries.slice(0, 4);

    const selected = await ranking.setFinalSelection(
      cohort.id,
      top.map((entry, index) => ({
        submissionId: entry.submissionId,
        position: index + 1,
        reason: 'Chosen by the panel.',
      })),
      'shared-admin',
    );

    expect(selected).toHaveLength(4);
    expect(selected.every((s) => s.selectedBy === 'shared-admin')).toBe(true);
  });
});

describe('a submission that goes to manual review', () => {
  it('is not ranked as though it had been judged', async () => {
    await assessment.enqueueCohort(cohort.id);
    for (const [index, submission] of submissions.entries()) {
      if (index === 0) continue;
      await runFullPipeline(submission, 80 - index * 2);
    }

    // The first one could not be reached and was parked for a human.
    const job = (await assessment.getJobBySubmission(submissions[0]!.id))!;
    await assessment.recordPreflight(job.id, [
      { checkKey: 'product_url_reachable', status: 'fail', attemptNumber: 3, failureClass: 'timeout', detail: {}, checkedAt: new Date() },
    ]);
    await assessment.raiseManualReview({
      submissionId: submissions[0]!.id,
      reasonCode: 'app_unreachable',
      detail: 'Timed out on three attempts. This may be the host rather than the team.',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });
    await assessment.advanceStage(job.id, 'manual_review');

    const snapshot = await ranking.generateSnapshot(cohort.id);
    expect(snapshot.eligibleCount).toBe(11);

    const current = await ranking.getCurrentSnapshot(cohort.id);
    expect(current?.entries.some((e) => e.submissionId === submissions[0]!.id)).toBe(false);
  });

  it('appears in the operator review list with its reason', async () => {
    await assessment.enqueueCohort(cohort.id);
    await assessment.raiseManualReview({
      submissionId: submissions[0]!.id,
      reasonCode: 'contradictory_evidence',
      detail: 'The deck claims a feature the browser could not find.',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });

    const flags = await assessment.listManualReviewFlags(cohort.id);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.detail).toMatch(/deck claims a feature/i);
    expect(flags[0]?.groupNumber).toBe(1);
  });
});

describe('a consistency pass near the cut-off', () => {
  it('records the second look without erasing the first', async () => {
    await assessment.enqueueCohort(cohort.id);
    const jobId = await runFullPipeline(submissions[0]!, 70);

    await assessment.advanceStage(jobId, 'consistency_review');
    await assessment.saveConsistencyReview({
      jobId,
      triggerReason: ['near_cutoff'],
      passNumber: 2,
      scoreDelta: 1.5,
      adjusted: true,
      detail: { movedCategory: 'core_workflow' },
      reviewedAt: new Date(),
    });
    await assessment.advanceStage(jobId, 'completed');

    const { rows } = await db.query('select * from consistency_reviews where job_id = $1', [jobId]);
    expect(rows).toHaveLength(1);
    expect(Number((rows[0] as { score_delta: unknown }).score_delta)).toBeCloseTo(1.5, 2);
  });
});

describe('nothing in this run touched a provider', () => {
  it('used fixture outputs throughout', async () => {
    // The whole pipeline above ran on values written directly to the store.
    // No key, no network, no cost — which is what makes it safe to run on
    // every commit.
    await assessment.enqueueCohort(cohort.id);
    const jobId = await runFullPipeline(submissions[0]!, 84);

    const scores = await assessment.listScores(jobId);
    expect(scores.every((s) => s.modelVersion === MODEL)).toBe(true);
    expect(scores.every((s) => s.promptVersion === PROMPT)).toBe(true);
  });
});
