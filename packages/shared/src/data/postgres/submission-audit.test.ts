import { createInMemoryStorage } from './storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { buildRankingStore } from './repositories/ranking';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';
import {
  FAILURE_CATEGORIES,
  SUBMISSIONS_AUDIT_HEADERS,
  buildSubmissionsAuditCsv,
  classifyOutcome,
  explainOutcome,
  rankEligibility,
  summariseSubmissionAudit,
} from '../../domain/submission-audit';
import { RESULTS_EXPORT_HEADERS } from '../../domain/results-export';
import { parseCsv } from '../../utils/csv';
import type { AssessmentStore, RankingStore } from '../store';
import type { CategoryScore, Cohort, Submission } from '../types';

/**
 * The all-submissions audit read from real tables.
 *
 * Ten submissions in one cohort, two in another. The ten cover: ranked with
 * feedback; ranked with failed feedback; failed at browser testing with an
 * explicit platform error; diverted to a human because the product was
 * unreachable; ranked but low-confidence with two flags; disqualified after
 * scoring; never queued; failed with nothing recorded; still queued; and
 * diverted because the browser never reached the product. Every one of the
 * ten must come back exactly once, none of the other cohort's, and the ranked
 * results export must be unchanged by any of it.
 */

let db: PgliteHandle;
let assessment: AssessmentStore;
let ranking: RankingStore;
let cohort: Cohort;
let other: Cohort;
let submissions: Submission[];

const col = (name: string) => {
  const index = SUBMISSIONS_AUDIT_HEADERS.indexOf(name);
  if (index < 0) throw new Error(`No column ${name}`);
  return index;
};

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
  // The other cohort first, with its receipt ids renamed so the fixture's
  // per-index receipts do not collide with the main cohort's.
  const otherSeeded = await seedCohortWithSubmissions(db, 2, { code: 'OTHER' });
  other = otherSeeded.cohort;
  await db.query(`update submissions set receipt_id = 'OTHER-' || receipt_id where cohort_id = $1`, [other.id]);
  const seeded = await seedCohortWithSubmissions(db, 10);
  cohort = seeded.cohort;
  submissions = seeded.submissions;
  assessment = buildAssessmentStore(db, createInMemoryStorage());
  ranking = buildRankingStore(db);
  await assessment.enqueueCohort(cohort.id);
  await assessment.enqueueCohort(other.id);
});

async function jobOf(submissionId: string) {
  const job = await assessment.getJobBySubmission(submissionId);
  if (!job) throw new Error('no job');
  return job;
}

async function score(submissionId: string, total: number, confidence = 0.8) {
  const job = await jobOf(submissionId);
  const share = total / 100;
  await assessment.saveScores(
    job.id,
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
  await assessment.saveSummary({
    jobId: job.id,
    totalScore: total,
    meanConfidence: confidence,
    minConfidence: confidence,
    lowConfidence: confidence < 0.6,
    risks: [],
    strengths: [],
    weaknesses: [],
    internalNotes: null,
    bugsFound: [],
    modelVersion: 'test-model',
    promptVersion: 'test-prompt',
    completedAt: new Date(),
  });
  await db.query(
    `update assessment_jobs set stage = 'completed', attempt_count = 1, started_at = now(), completed_at = now() where id = $1`,
    [job.id],
  );
  return job.id;
}

async function preflightPassed(jobId: string, attempt: number) {
  await assessment.recordPreflight(jobId, [
    { checkKey: 'http_reachable', status: 'pass', attemptNumber: attempt, failureClass: 'none', detail: {}, checkedAt: new Date() },
    { checkKey: 'deck_readable', status: 'warn', attemptNumber: attempt, failureClass: 'none', detail: { message: 'Deck returned 404.' }, checkedAt: new Date() },
  ]);
}

async function artifactAndPlan(jobId: string, steps: number) {
  await db.query(
    `insert into artifact_analyses
       (job_id, deck_page_count, deck_text_extracted, deck_analysis, video_analysis_limited,
        video_limitation_reason, transcript_available, written_analysis, injection_flags, model_version, prompt_version)
     values ($1, 11, true, '{}'::jsonb, false, null, false, '{}'::jsonb, '[]'::jsonb, 'm', 'p')`,
    [jobId],
  );
  await db.query(
    `insert into test_plans
       (job_id, generated_from, step_count, estimated_duration_ms, model_version, prompt_version,
        validation_status, rejected_steps, summary)
     values ($1, '{}'::jsonb, $2, 60000, 'm', 'p', 'valid', '[]'::jsonb, 'plan')`,
    [jobId, steps],
  );
}

async function failJob(jobId: string, error: string | null, attempts = 2) {
  await db.query(
    `update assessment_jobs
        set stage = 'failed', last_error = $2, attempt_count = $3, max_attempts = 3,
            started_at = now(), completed_at = now()
      where id = $1`,
    [jobId, error, attempts],
  );
}

async function divertJob(jobId: string, error: string | null, attempts = 1) {
  await db.query(
    `update assessment_jobs
        set stage = 'manual_review', last_error = $2, attempt_count = $3, max_attempts = 3,
            started_at = now(), completed_at = now()
      where id = $1`,
    [jobId, error, attempts],
  );
}

/** The ten scenarios. Index → what happened. */
async function arrange() {
  const [s0, s1, s2, s3, s4, s5, s6, s7, , s9] = submissions as [Submission, Submission, Submission, Submission, Submission, Submission, Submission, Submission, Submission, Submission];

  // 0: ranked, feedback ready. Product name is a formula.
  await score(s0.id, 90);
  await db.query(`update submissions set product_name = '=HYPERLINK("https://evil.example","x")' where id = $1`, [s0.id]);
  await assessment.saveFeedbackReport({
    submissionId: s0.id,
    productSummary: 'Summary for Product 1',
    strengths: ['a', 'b', 'c'],
    improvements: [{ title: 'Do', detail: 'this', priority: 1 }],
    bugs: [{ description: 'bug', evidence: 'step 3' }],
    nextSevenDayPlan: ['ship'],
    isExposedToParticipant: false,
    generatedAt: new Date(),
    modelVersion: 'm',
    promptVersion: 'p',
  });
  await assessment.setFeedbackStatus((await jobOf(s0.id)).id, { status: 'generated', error: null, attempts: 1 });

  // 1: ranked, feedback failed.
  await score(s1.id, 85);
  await assessment.setFeedbackStatus((await jobOf(s1.id)).id, { status: 'failed', error: 'Withheld: mentions rank', attempts: 3 });

  // 2: failed at browser testing with the platform's own error. Login required.
  const j2 = await jobOf(s2.id);
  await preflightPassed(j2.id, 2);
  await artifactAndPlan(j2.id, 37);
  await failJob(j2.id, 'permission denied for table submission_credentials');
  await db.query(`update submissions set login_required = true where id = $1`, [s2.id]);
  await db.query(
    `insert into submission_credentials (submission_id, username_ciphertext, password_ciphertext, login_instructions_ciphertext)
     values ($1, $2, $3, $4)`,
    [s2.id, Buffer.from('CIPHERTEXT-USER-QX9'), Buffer.from('CIPHERTEXT-PASS-QX9'), Buffer.from('CIPHERTEXT-NOTE-QX9')],
  );

  // 3: unreachable — preflight timed out, flag raised, diverted.
  const j3 = await jobOf(s3.id);
  await assessment.recordPreflight(j3.id, [
    { checkKey: 'http_reachable', status: 'fail', attemptNumber: 3, failureClass: 'timeout', detail: { message: 'No response within 15000 ms.' }, checkedAt: new Date() },
    { checkKey: 'http_reachable', status: 'fail', attemptNumber: 2, failureClass: 'timeout', detail: { message: 'No response within 15000 ms.' }, checkedAt: new Date() },
  ]);
  await assessment.raiseManualReview({
    submissionId: s3.id,
    reasonCode: 'product_unreachable',
    detail: 'The product could not be reached after 3 attempt(s): No response within 15000 ms. It has not been judged on product behaviour.',
    raisedBy: 'system',
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
  });
  await divertJob(j3.id, 'The product could not be reached.', 2);

  // 4: ranked but low confidence, two flags (one resolved).
  await score(s4.id, 80, 0.5);
  await assessment.raiseManualReview({
    submissionId: s4.id,
    reasonCode: 'prompt_injection_detected',
    detail: 'Instruction-like content found. Password: NotReallyASecret1',
    raisedBy: 'system',
    status: 'resolved',
    resolvedBy: 'shared-admin',
    resolvedAt: new Date(),
    resolutionNote: 'Checked',
  });
  await assessment.raiseManualReview({
    submissionId: s4.id,
    reasonCode: 'low_confidence_scores',
    detail: 'At least one category scored below the confidence threshold (0.50 < 0.6). Treat this score as provisional.',
    raisedBy: 'system',
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
  });

  // 5: scored, then disqualified (confirmed).
  await score(s5.id, 70);
  const dq = await assessment.proposeDisqualification({
    submissionId: s5.id,
    reasonCode: 'missing_demo_link',
    reasonDetail: 'No Loom',
    evidence: {},
    status: 'proposed',
    proposedBy: 'system',
    confirmedBy: null,
    reversedBy: null,
    reversedReason: null,
  });
  await assessment.confirmDisqualification(dq.id, 'shared-admin');

  // 6: never queued.
  await db.query(`delete from assessment_jobs where submission_id = $1`, [s6.id]);

  // 7: failed with nothing recorded. Product URL carries basic-auth credentials.
  await failJob((await jobOf(s7.id)).id, null, 3);
  await db.query(`update submissions set product_url = 'https://team:TOPSECRET-77@product-8.example.com/app' where id = $1`, [s7.id]);

  // 8: still queued (nothing to do).

  // 9: browser never reached the product.
  const j9 = await jobOf(s9.id);
  await preflightPassed(j9.id, 1);
  await artifactAndPlan(j9.id, 20);
  await assessment.saveBrowserRun(
    {
      jobId: j9.id,
      viewport: 'desktop',
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 900,
      status: 'failed',
      browserVersion: 'Chromium 140',
      tracePath: null,
      consoleErrorCount: 0,
      networkFailureCount: 1,
      a11yViolationCount: 0,
      a11ySummary: {},
      cleanupStatus: 'not_attempted',
      timedOut: false,
    },
    [
      { stepIndex: 0, action: 'navigate', status: 'failed', durationMs: 900, screenshotPath: null, assertionDetail: {}, errorMessage: 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://product-10.example.com' },
      { stepIndex: 1, action: 'click', status: 'skipped', durationMs: 0, screenshotPath: null, assertionDetail: {}, errorMessage: null },
    ],
  );
  await assessment.raiseManualReview({
    submissionId: s9.id,
    reasonCode: 'browser_never_reached_product',
    detail: 'The browser never loaded the product, so nothing observed is evidence about this submission.',
    raisedBy: 'system',
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
  });
  await divertJob(j9.id, 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://product-10.example.com', 1);

  // The other cohort: one ranked product, so its snapshot exists too.
  const otherSubs = await db.query<{ id: string }>(`select id from submissions where cohort_id = $1 order by created_at`, [other.id]);
  await score(otherSubs.rows[0]!.id, 60);

  await ranking.generateSnapshot(cohort.id, 'audit test');
  await ranking.generateSnapshot(other.id, 'other');
}

describe('listSubmissionAudit', () => {
  it('returns every submission of the cohort exactly once, whatever happened to it', async () => {
    await arrange();
    const rows = await ranking.listSubmissionAudit(cohort.id);

    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.submissionId)).size).toBe(10);
    expect(rows.map((r) => r.submissionId).sort()).toEqual(submissions.map((s) => s.id).sort());
    expect(rows.every((r) => r.cohortId === cohort.id)).toBe(true);

    const byId = new Map(rows.map((r) => [r.submissionId, r]));
    const outcomes = submissions.map((s) => classifyOutcome(byId.get(s.id)!));
    expect(outcomes).toEqual([
      'Completed',
      'Completed',
      'Failed',
      'Needs human review',
      'Completed',
      'Disqualified',
      'Not assessed',
      'Failed',
      'Queued',
      'Needs human review',
    ]);
    expect(summariseSubmissionAudit(rows)).toEqual({
      total: 10,
      ranked: 3,
      completedUnranked: 0,
      needsHumanReview: 2,
      failed: 2,
      disqualified: 1,
      incomplete: 1,
      notAssessed: 1,
      rankedWithOpenFlags: 1,
    });
  });

  it('carries scores, rank and feedback for ranked products, and blanks for unscored ones', async () => {
    await arrange();
    const rows = await ranking.listSubmissionAudit(cohort.id);
    const byId = new Map(rows.map((r) => [r.submissionId, r]));

    const first = byId.get(submissions[0]!.id)!;
    expect(first.ranking).toMatchObject({ rank: 1, totalScore: 90, inShortlist: true });
    expect(Object.keys(first.categoryScores).sort()).toEqual(RUBRIC_CATEGORIES.map((c) => c.key).sort());
    expect(first.categoryScores.core_workflow).toEqual({ rawScore: 22.5, maxPoints: 25, confidence: 0.8, isOverridden: false });
    expect(first.feedback?.productSummary).toBe('Summary for Product 1');
    expect(first.summary).toMatchObject({ totalScore: 90, lowConfidence: false });
    expect(first.rankingGeneratedAt).toBeInstanceOf(Date);
    expect(rankEligibility(first)).toEqual({ eligible: true, exclusionReason: '' });

    const failed = byId.get(submissions[2]!.id)!;
    expect(failed.ranking).toBeNull();
    expect(failed.categoryScores).toEqual({});
    expect(failed.summary).toBeNull();
    expect(failed.loginRequired).toBe(true);
    expect(failed.job).toMatchObject({ stage: 'failed', attemptCount: 2, maxAttempts: 3, lastError: 'permission denied for table submission_credentials' });
    expect(failed.preflight).toMatchObject({ attempt: 2 });
    expect(failed.preflight!.checks.map((c) => `${c.checkKey}:${c.status}`)).toEqual(['http_reachable:pass', 'deck_readable:warn']);
    expect(failed.artifactAnalysis).toMatchObject({ deckPageCount: 11, deckTextExtracted: true });
    expect(failed.testPlan).toMatchObject({ stepCount: 37, validationStatus: 'valid', rejectedStepCount: 0 });
    expect(failed.browserRuns).toEqual([]);
  });

  it('derives the failing stage, prefers the recorded error, and labels a derived stage', async () => {
    await arrange();
    const rows = await ranking.listSubmissionAudit(cohort.id);
    const byId = new Map(rows.map((r) => [r.submissionId, r]));

    const platform = explainOutcome(byId.get(submissions[2]!.id)!);
    expect(platform).toMatchObject({
      failureStage: 'Browser testing',
      failureStageBasis: 'Derived from existing evidence',
      failureCategory: FAILURE_CATEGORIES.internalWorker,
      reasonSource: 'Explicit system error',
      evidenceQuality: 'High',
    });
    expect(platform.explanation).toMatch(/refused access to the credentials table/);
    expect(platform.explanation).toMatch(/Stage derived from records/);

    const unreachable = explainOutcome(byId.get(submissions[3]!.id)!);
    expect(unreachable).toMatchObject({
      failureStage: 'Preflight',
      failureStageBasis: 'Explicitly recorded',
      failureCategory: FAILURE_CATEGORIES.productUnreachable,
      evidenceQuality: 'High',
    });
    expect(unreachable.explanation).toMatch(/did not respond within the time limit/);
    expect(unreachable.technicalDetail).toMatch(/preflight http_reachable failed \(timeout\)/);
    // The latest attempt's checks are the ones reported.
    expect(byId.get(submissions[3]!.id)!.preflight).toMatchObject({ attempt: 3 });

    // The job's error text is a raw browser message the pipeline does not
    // name, so the system flag — an explicit record — is the reason source.
    const browser = explainOutcome(byId.get(submissions[9]!.id)!);
    expect(browser).toMatchObject({
      failureStage: 'Browser testing',
      failureCategory: FAILURE_CATEGORIES.browserNavigation,
      reasonSource: 'Manual review flag',
      evidenceQuality: 'High',
    });
    expect(browser.technicalDetail).toMatch(/net::ERR_NAME_NOT_RESOLVED/);
    const run = byId.get(submissions[9]!.id)!.browserRuns[0]!;
    expect(run).toMatchObject({ status: 'failed', stepsTotal: 2, stepsPassed: 0, stepsFailed: 1, navigationPassed: false });
    expect(run.firstFailure).toMatchObject({ stepIndex: 0, action: 'navigate' });

    const unknown = explainOutcome(byId.get(submissions[7]!.id)!);
    expect(unknown).toMatchObject({
      failureCategory: FAILURE_CATEGORIES.unknown,
      reasonSource: 'Not recorded',
      evidenceQuality: 'Unknown',
    });

    const never = explainOutcome(byId.get(submissions[6]!.id)!);
    expect(never).toMatchObject({ failureCategory: FAILURE_CATEGORIES.noJob, reasonSource: 'Derived from existing evidence' });
    expect(byId.get(submissions[6]!.id)!.job).toBeNull();
  });

  it('keeps manual review, disqualification and feedback distinct from failure', async () => {
    await arrange();
    const rows = await ranking.listSubmissionAudit(cohort.id);
    const byId = new Map(rows.map((r) => [r.submissionId, r]));

    const lowConfidence = byId.get(submissions[4]!.id)!;
    expect(classifyOutcome(lowConfidence)).toBe('Completed');
    expect(lowConfidence.ranking).toMatchObject({ rank: 3 });
    expect(lowConfidence.manualReviewFlags.map((f) => `${f.reasonCode}:${f.status}`)).toEqual([
      'prompt_injection_detected:resolved',
      'low_confidence_scores:open',
    ]);
    expect(lowConfidence.summary?.lowConfidence).toBe(true);
    expect(lowConfidence.lowConfidenceThreshold).toBe(cohort.assessmentConfig.lowConfidenceThreshold);

    const disqualified = byId.get(submissions[5]!.id)!;
    expect(classifyOutcome(disqualified)).toBe('Disqualified');
    expect(disqualified.disqualification).toMatchObject({ status: 'confirmed', reasonCode: 'missing_demo_link' });
    expect(disqualified.ranking).toBeNull();
    expect(rankEligibility(disqualified)).toEqual({ eligible: false, exclusionReason: 'Confirmed disqualification' });

    const feedbackFailed = byId.get(submissions[1]!.id)!;
    expect(classifyOutcome(feedbackFailed)).toBe('Completed');
    expect(feedbackFailed.feedbackStatus).toBe('failed');
    expect(feedbackFailed.feedbackError).toBe('Withheld: mentions rank');
    expect(feedbackFailed.ranking).toMatchObject({ rank: 2 });
  });

  it('never includes another cohort, and leaves the ranked results export as it was', async () => {
    await arrange();
    const otherIds = (await db.query<{ id: string }>(`select id from submissions where cohort_id = $1`, [other.id])).rows.map((r) => r.id);

    const rows = await ranking.listSubmissionAudit(cohort.id);
    expect(rows.some((r) => otherIds.includes(r.submissionId))).toBe(false);
    const otherRows = await ranking.listSubmissionAudit(other.id);
    expect(otherRows.map((r) => r.submissionId).sort()).toEqual(otherIds.sort());
    expect(await ranking.listSubmissionAudit('00000000-0000-0000-0000-000000000000')).toEqual([]);

    // The ranking-based export still returns only the ranked entries.
    const ranked = await ranking.listRankedResults(cohort.id);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(RESULTS_EXPORT_HEADERS).toHaveLength(45);
  });

  it('writes one CSV row per submission, guards formulas and carries no credential', async () => {
    await arrange();
    const rows = await ranking.listSubmissionAudit(cohort.id);
    const csv = buildSubmissionsAuditCsv(rows);
    const [headers, ...records] = parseCsv(csv);

    expect(headers).toEqual([...SUBMISSIONS_AUDIT_HEADERS]);
    expect(records).toHaveLength(10);
    expect(new Set(records.map((r) => r[col('Submission ID')])).size).toBe(10);

    const byId = new Map(records.map((r) => [r[col('Submission ID')], r]));
    const first = byId.get(submissions[0]!.id)!;
    expect(first[col('Product Name')]).toMatch(/^'=HYPERLINK/);
    expect(first[col('Rank')]).toBe('1');
    expect(first[col('Feedback Status')]).toBe('ready');

    const failed = byId.get(submissions[2]!.id)!;
    expect(failed[col('Assessment Outcome')]).toBe('Failed');
    expect(failed[col('Login Required')]).toBe('yes');
    expect(failed[col('Problem Clarity')]).toBe('');
    expect(failed[col('Total Score')]).toBe('');
    expect(failed[col('Preflight Result')]).toMatch(/^attempt 2: deck_readable warn: Deck returned 404\./);
    expect(failed[col('Test Plan')]).toBe('37 steps (valid)');

    const flagged = byId.get(submissions[4]!.id)!;
    expect(flagged[col('Assessment Outcome')]).toBe('Completed');
    expect(flagged[col('Manual Review Reason(s)')]).toMatch(/prompt injection detected: .*\[resolved: Checked\] \| low confidence scores: /);
    expect(flagged[col('Failure Category')]).toBe('');

    const unknown = byId.get(submissions[7]!.id)!;
    expect(unknown[col('Product URL')]).toBe('https://[REDACTED]@product-8.example.com/app');

    for (const secret of ['TOPSECRET-77', 'NotReallyASecret1', 'CIPHERTEXT-USER-QX9', 'CIPHERTEXT-PASS-QX9', 'CIPHERTEXT-NOTE-QX9']) {
      expect(csv, `must not contain ${secret}`).not.toContain(secret);
    }
  });
});
