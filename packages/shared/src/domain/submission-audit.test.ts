import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_OUTCOMES,
  FAILURE_CATEGORIES,
  SUBMISSIONS_AUDIT_HEADERS,
  buildSubmissionsAuditCsv,
  classifyOutcome,
  deriveFailureStage,
  describeManualReview,
  explainOutcome,
  orderAuditRows,
  rankEligibility,
  sanitiseForExport,
  submissionAuditRow,
  submissionsAuditFilename,
  summariseSubmissionAudit,
  buildTeamResultsCsv,
  TEAM_RESULTS_HEADERS,
  type AuditManualReviewFlag,
  type SubmissionAuditRow,
} from './submission-audit';
import { RESULTS_EXPORT_CATEGORY_LABELS, RESULTS_EXPORT_HEADERS } from './results-export';
import { RUBRIC_CATEGORIES } from '../rubric/index';
import { parseCsv } from '../utils/csv';

/**
 * The audit's rules, driven with hand-built rows.
 *
 * What is pinned here is the contract the operator relies on: every row lands
 * in one outcome bucket, the failure reason comes from the strongest evidence
 * and says which, manual review is never called failure, feedback is a
 * separate lifecycle, an unscored category is blank rather than zero, and
 * nothing shaped like a secret survives into a cell.
 */

const col = (name: string) => {
  const index = SUBMISSIONS_AUDIT_HEADERS.indexOf(name);
  if (index < 0) throw new Error(`No column ${name}`);
  return index;
};

function scores(share = 0.9): SubmissionAuditRow['categoryScores'] {
  const out: SubmissionAuditRow['categoryScores'] = {};
  for (const c of RUBRIC_CATEGORIES) {
    out[c.key] = { rawScore: c.maxPoints * share, maxPoints: c.maxPoints, confidence: 0.8, isOverridden: false };
  }
  return out;
}

const at = new Date('2026-09-27T08:00:00Z');

function flag(reasonCode: string, overrides: Partial<AuditManualReviewFlag> = {}): AuditManualReviewFlag {
  return {
    reasonCode,
    detail: `${reasonCode} detail`,
    status: 'open',
    raisedBy: 'system',
    createdAt: at,
    resolvedAt: null,
    resolutionNote: null,
    ...overrides,
  };
}

function row(overrides: Partial<SubmissionAuditRow> = {}): SubmissionAuditRow {
  return {
    cohortId: 'cohort',
    cohortName: 'AIAP C14',
    cohortCode: 'AIAP C14',
    submissionId: 'sub-1',
    groupNumber: 7,
    productName: 'Product',
    ideaTitle: 'Campaign Planner',
    ideaSlug: 'campaign-planner',
    submissionStatus: 'submitted',
    loginRequired: false,
    productUrl: 'https://product.example.com',
    loomUrl: null,
    deckUrl: null,
    lowConfidenceThreshold: 0.6,
    job: {
      id: 'job-1',
      stage: 'completed',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    },
    preflight: { attempt: 1, checks: [{ checkKey: 'http_reachable', status: 'pass', failureClass: 'none', message: null }] },
    artifactAnalysis: { deckPageCount: 10, deckTextExtracted: true, videoAnalysisLimited: false, videoLimitationReason: null, injectionFlagCount: 0 },
    testPlan: { stepCount: 30, validationStatus: 'valid', rejectedStepCount: 0 },
    browserRuns: [
      { attempt: 1, viewport: 'desktop', status: 'passed', timedOut: false, durationMs: 1000, stepsTotal: 30, stepsPassed: 30, stepsFailed: 0, stepsErrored: 0, navigationPassed: true, firstFailure: null },
    ],
    evidenceCount: 40,
    categoryScores: scores(),
    summary: { totalScore: 90, meanConfidence: 0.8, minConfidence: 0.7, lowConfidence: false, riskCount: 0 },
    manualReviewFlags: [],
    disqualification: null,
    ranking: { rank: 1, totalScore: 90, inShortlist: true, meanConfidence: 0.8 },
    rankingGeneratedAt: at,
    finalPosition: null,
    finalSelectionReason: null,
    feedbackStatus: 'generated',
    feedbackError: null,
    feedbackAttempts: 1,
    feedback: {
      id: 'fb',
      submissionId: 'sub-1',
      productSummary: 'Summary',
      strengths: ['s1', 's2', 's3'],
      improvements: [{ title: 'Do', detail: 'this', priority: 1 }],
      bugs: [],
      nextSevenDayPlan: ['ship'],
      isExposedToParticipant: false,
      generatedAt: at,
      modelVersion: 'm',
      promptVersion: 'p',
    },
    ...overrides,
  };
}

/** A job that failed at browser testing before any run was recorded. */
function failedBeforeBrowser(lastError: string | null): SubmissionAuditRow {
  return row({
    job: { id: 'job-2', stage: 'failed', attemptCount: 2, maxAttempts: 3, lastError, startedAt: at, completedAt: at, updatedAt: at },
    preflight: { attempt: 2, checks: [{ checkKey: 'http_reachable', status: 'pass', failureClass: 'none', message: null }] },
    browserRuns: [],
    evidenceCount: 0,
    categoryScores: {},
    summary: null,
    ranking: null,
    feedbackStatus: 'pending',
    feedback: null,
  });
}

describe('classifyOutcome', () => {
  it('puts every row in exactly one bucket, from the job stage', () => {
    expect(classifyOutcome(row())).toBe('Completed');
    expect(classifyOutcome(row({ job: { ...row().job!, stage: 'manual_review' } }))).toBe('Needs human review');
    expect(classifyOutcome(row({ job: { ...row().job!, stage: 'failed' } }))).toBe('Failed');
    expect(classifyOutcome(row({ job: { ...row().job!, stage: 'queued' } }))).toBe('Queued');
    expect(classifyOutcome(row({ job: { ...row().job!, stage: 'browser_testing' } }))).toBe('In progress');
    expect(classifyOutcome(row({ job: null }))).toBe('Not assessed');
    expect(classifyOutcome(row({ disqualification: { status: 'confirmed', reasonCode: 'missing_demo_link', reasonDetail: '' } }))).toBe('Disqualified');
    // A proposed disqualification is not an outcome yet.
    expect(classifyOutcome(row({ disqualification: { status: 'proposed', reasonCode: 'missing_demo_link', reasonDetail: '' } }))).toBe('Completed');
    for (const outcome of ASSESSMENT_OUTCOMES) expect(typeof outcome).toBe('string');
  });
});

describe('rankEligibility', () => {
  it('uses the ranking rule, and names why a row is out', () => {
    expect(rankEligibility(row())).toEqual({ eligible: true, exclusionReason: '' });
    expect(rankEligibility(row({ ranking: null })).exclusionReason).toMatch(/No current ranking entry/);
    expect(rankEligibility(row({ disqualification: { status: 'confirmed', reasonCode: 'x', reasonDetail: '' } }))).toEqual({
      eligible: false,
      exclusionReason: 'Confirmed disqualification',
    });
    expect(rankEligibility(failedBeforeBrowser('boom'))).toEqual({ eligible: false, exclusionReason: 'Assessment failed' });
    expect(rankEligibility(row({ job: null, categoryScores: {}, ranking: null }))).toEqual({ eligible: false, exclusionReason: 'No assessment job' });
    const partial = scores();
    delete partial.deck_demo;
    expect(rankEligibility(row({ categoryScores: partial, ranking: null })).exclusionReason).toBe('Missing complete category scores');
    expect(rankEligibility(row({ submissionStatus: 'withdrawn', ranking: null })).exclusionReason).toMatch(/not a final submission/);
    expect(
      rankEligibility(row({ job: { ...row().job!, stage: 'manual_review' }, categoryScores: {}, ranking: null })).exclusionReason,
    ).toMatch(/manual review/);
  });
});

describe('deriveFailureStage', () => {
  it('reads the stage of an in-flight job from the job itself', () => {
    const result = deriveFailureStage(row({ job: { ...row().job!, stage: 'browser_testing' } }));
    expect(result).toMatchObject({ stage: 'browser_testing', basis: 'Explicitly recorded' });
  });

  it('derives the failing stage from the furthest record when the job only says "failed"', () => {
    // Preflight passed, artifact analysis and test plan saved, no browser run:
    // browser testing is where it stopped.
    expect(deriveFailureStage(failedBeforeBrowser('permission denied for table submission_credentials'))).toMatchObject({
      stage: 'browser_testing',
      basis: 'Derived from existing evidence',
    });
    // Preflight passed but no artifact analysis: artifact analysis.
    expect(deriveFailureStage(failedBeforeBrowser(null) && { ...failedBeforeBrowser(null), artifactAnalysis: null, testPlan: null })).toMatchObject({
      stage: 'artifact_analysis',
      basis: 'Derived from existing evidence',
    });
    // A failed preflight check names preflight.
    expect(
      deriveFailureStage({
        ...failedBeforeBrowser(null),
        preflight: { attempt: 1, checks: [{ checkKey: 'dns_resolves', status: 'fail', failureClass: 'dns', message: 'NXDOMAIN' }] },
        artifactAnalysis: null,
        testPlan: null,
      }),
    ).toMatchObject({ stage: 'preflight' });
    // Nothing recorded at all: not derived, not invented.
    expect(
      deriveFailureStage({ ...failedBeforeBrowser(null), preflight: null, artifactAnalysis: null, testPlan: null }),
    ).toMatchObject({ stage: '', basis: 'Not recorded' });
  });

  it('takes the stage from a system flag or a canonical error before reading the trail', () => {
    const diverted = row({
      job: { ...row().job!, stage: 'manual_review', lastError: 'The product could not be reached.' },
      manualReviewFlags: [flag('product_unreachable')],
      artifactAnalysis: null,
      testPlan: null,
      browserRuns: [],
      categoryScores: {},
      summary: null,
      ranking: null,
    });
    expect(deriveFailureStage(diverted)).toMatchObject({ stage: 'preflight', basis: 'Explicitly recorded' });
    expect(deriveFailureStage(failedBeforeBrowser('No valid test steps could be generated.'))).toMatchObject({
      stage: 'test_plan_generation',
      basis: 'Explicitly recorded',
    });
  });
});

describe('explainOutcome', () => {
  it('prefers the explicit recorded error over anything inferred from the trail', () => {
    const explained = explainOutcome(failedBeforeBrowser('permission denied for table submission_credentials'));
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.internalWorker);
    expect(explained.reasonSource).toBe('Explicit system error');
    expect(explained.evidenceQuality).toBe('High');
    expect(explained.failureStage).toBe('Browser testing');
    expect(explained.failureStageBasis).toBe('Derived from existing evidence');
    expect(explained.explanation).toMatch(/refused access to the credentials table/);
    expect(explained.explanation).toMatch(/platform fault/);
    expect(explained.technicalDetail).toMatch(/permission denied for table submission_credentials; attempts 2 of 3/);
  });

  it('labels a derived stage as derived, and says what the records showed', () => {
    const explained = explainOutcome(failedBeforeBrowser('permission denied for table submission_credentials'));
    expect(explained.explanation).toMatch(/Stage derived from records: preflight attempt 2: passed → artifact analysis: saved → test plan: 30 steps \(valid\) → browser testing: no run recorded/);
  });

  it('explains the credential guard as the guard working, not as a product failure', () => {
    const explained = explainOutcome({
      ...failedBeforeBrowser('Refusing to send an AI payload that still contains a labelled password. Redaction should have removed it before the payload was built.'),
      artifactAnalysis: null,
      testPlan: null,
    });
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.credentialGuard);
    expect(explained.failureStage).toBe('Artifact analysis');
    expect(explained.explanation).toMatch(/safety guard working as designed/);
    expect(explained.evidenceQuality).toBe('High');
  });

  it('uses the manual-review flag and the preflight record for an unreachable product', () => {
    const explained = explainOutcome(
      row({
        job: { ...row().job!, stage: 'manual_review', attemptCount: 2, lastError: 'The product could not be reached.' },
        preflight: {
          attempt: 3,
          checks: [{ checkKey: 'http_reachable', status: 'fail', failureClass: 'timeout', message: 'No response within 15000 ms.' }],
        },
        manualReviewFlags: [flag('product_unreachable', { detail: 'The product could not be reached after 3 attempt(s): No response within 15000 ms.' })],
        artifactAnalysis: null,
        testPlan: null,
        browserRuns: [],
        evidenceCount: 0,
        categoryScores: {},
        summary: null,
        ranking: null,
        feedback: null,
        feedbackStatus: 'pending',
      }),
    );
    expect(explained.failureStage).toBe('Preflight');
    expect(explained.failureStageBasis).toBe('Explicitly recorded');
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.productUnreachable);
    expect(explained.explanation).toMatch(/did not respond within the time limit/);
    expect(explained.reasonSource).toBe('Explicit system error');
    expect(explained.technicalDetail).toMatch(/preflight http_reachable failed \(timeout\): No response within 15000 ms\./);
    expect(explained.technicalDetail).toMatch(/flag product_unreachable/);
    expect(explained.evidenceQuality).toBe('High');
  });

  it('uses the flag alone when the job carries no error', () => {
    const explained = explainOutcome(
      row({
        job: { ...row().job!, stage: 'manual_review', lastError: null },
        preflight: {
          attempt: 2,
          checks: [{ checkKey: 'product_type_supported', status: 'warn', failureClass: 'invalid', message: 'This looks like a document.' }],
        },
        manualReviewFlags: [flag('unsupported_product_type', { detail: 'This looks like a document or file-storage link rather than a running web application.' })],
        artifactAnalysis: null,
        testPlan: null,
        browserRuns: [],
        categoryScores: {},
        summary: null,
        ranking: null,
      }),
    );
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.unsupportedProductType);
    expect(explained.reasonSource).toBe('Manual review flag');
    expect(explained.failureStage).toBe('Preflight');
    expect(explained.explanation).toMatch(/not a running web application/);
  });

  it('reads a browser run record when the browser never reached the product', () => {
    const explained = explainOutcome(
      row({
        job: { ...row().job!, stage: 'manual_review', lastError: 'net::ERR_NAME_NOT_RESOLVED' },
        browserRuns: [
          {
            attempt: 1,
            viewport: 'desktop',
            status: 'failed',
            timedOut: false,
            durationMs: 500,
            stepsTotal: 12,
            stepsPassed: 0,
            stepsFailed: 1,
            stepsErrored: 0,
            navigationPassed: false,
            firstFailure: { stepIndex: 0, action: 'navigate', errorMessage: 'page.goto: net::ERR_NAME_NOT_RESOLVED' },
          },
        ],
        manualReviewFlags: [flag('browser_never_reached_product', { detail: 'The browser never loaded the product.' })],
        evidenceCount: 0,
        categoryScores: {},
        summary: null,
        ranking: null,
      }),
    );
    expect(explained.failureStage).toBe('Browser testing');
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.browserNavigation);
    expect(explained.reasonSource).toBe('Manual review flag');
    expect(explained.technicalDetail).toMatch(/first failing step 0 \(navigate\): page\.goto: net::ERR_NAME_NOT_RESOLVED/);
  });

  it('reads a browser run record when nothing else explains a failure', () => {
    const explained = explainOutcome(
      row({
        job: { ...row().job!, stage: 'failed', lastError: null },
        browserRuns: [
          {
            attempt: 2,
            viewport: 'desktop',
            status: 'error',
            timedOut: true,
            durationMs: 480000,
            stepsTotal: 20,
            stepsPassed: 6,
            stepsFailed: 0,
            stepsErrored: 1,
            navigationPassed: true,
            firstFailure: { stepIndex: 6, action: 'click', errorMessage: 'Timeout 30000ms exceeded.' },
          },
        ],
        evidenceCount: 0,
        categoryScores: {},
        summary: null,
        ranking: null,
      }),
    );
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.browserTimeout);
    expect(explained.reasonSource).toBe('Browser run record');
    expect(explained.evidenceQuality).toBe('High');
    expect(explained.technicalDetail).toMatch(/desktop attempt 2: error \(timed out\), 6\/20 steps passed; first failing step 6 \(click\)/);
  });

  it('classifies an unrecognised recorded error as unclassified rather than guessing a cause', () => {
    const explained = explainOutcome(failedBeforeBrowser('Something odd happened'));
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.unclassified);
    expect(explained.reasonSource).toBe('Explicit system error');
    expect(explained.evidenceQuality).toBe('Medium');
    expect(explained.explanation).toMatch(/Something odd happened/);
  });

  it('says "reason not recorded" when nothing explains a failure', () => {
    const explained = explainOutcome({
      ...failedBeforeBrowser(null),
      preflight: null,
      artifactAnalysis: null,
      testPlan: null,
    });
    expect(explained.failureStage).toBe('Unknown');
    expect(explained.failureCategory).toBe(FAILURE_CATEGORIES.unknown);
    expect(explained.explanation).toBe(
      'The assessment did not complete, but the system does not contain enough persisted information to determine the exact cause.',
    );
    expect(explained.reasonSource).toBe('Not recorded');
    expect(explained.evidenceQuality).toBe('Unknown');
  });

  it('gives a completed assessment no failure at all, even with an open flag', () => {
    const explained = explainOutcome(row({ manualReviewFlags: [flag('low_confidence_scores')] }));
    expect(explained.failureCategory).toBe('');
    expect(explained.failureStage).toBe('');
  });

  it('describes queued, in-progress, disqualified and never-queued rows', () => {
    expect(explainOutcome(row({ job: { ...row().job!, stage: 'queued' }, ranking: null }))).toMatchObject({
      failureCategory: FAILURE_CATEGORIES.incomplete,
      reasonSource: 'Assessment job record',
    });
    expect(explainOutcome(row({ job: { ...row().job!, stage: 'scoring' }, ranking: null }))).toMatchObject({
      failureStage: 'Scoring',
      explanation: 'The assessment is still in progress at scoring.',
    });
    expect(
      explainOutcome(row({ disqualification: { status: 'confirmed', reasonCode: 'missing_demo_link', reasonDetail: 'No Loom' }, ranking: null })),
    ).toMatchObject({ failureCategory: FAILURE_CATEGORIES.disqualified, reasonSource: 'Disqualification record', evidenceQuality: 'High' });
    expect(explainOutcome(row({ job: null, ranking: null }))).toMatchObject({
      failureStage: 'Not started',
      failureCategory: FAILURE_CATEGORIES.noJob,
      reasonSource: 'Derived from existing evidence',
    });
  });
});

describe('describeManualReview', () => {
  it('keeps every flag, open and resolved, and never calls a low-confidence product failed', () => {
    const flagged = row({
      manualReviewFlags: [
        flag('low_confidence_scores', { detail: 'At least one category scored below the confidence threshold (0.55 < 0.6).' }),
        flag('prompt_injection_detected', {
          status: 'resolved',
          resolvedAt: at,
          resolutionNote: 'Checked, harmless',
          createdAt: new Date(at.getTime() - 1000),
        }),
      ],
    });
    const review = describeManualReview(flagged);
    expect(review.flagged).toBe(true);
    expect(review.status).toBe('open');
    expect(review.resolved).toBe('no');
    expect(review.lowConfidence).toBe(true);
    expect(review.reasons).toBe(
      'prompt injection detected: prompt_injection_detected detail [resolved: Checked, harmless] | ' +
        'low confidence scores: At least one category scored below the confidence threshold (0.55 < 0.6).',
    );
    expect(classifyOutcome(flagged)).toBe('Completed');
    expect(explainOutcome(flagged).failureCategory).toBe('');
  });
});

describe('sanitiseForExport', () => {
  it('redacts anything shaped like a secret', () => {
    expect(sanitiseForExport('login failed: password: hunter2 for user')).toBe('login failed: password: [REDACTED] for user');
    expect(sanitiseForExport('Password=Secr3t! then token=abcdefghijklmnop123456')).toBe('Password=[REDACTED] then token=[REDACTED]');
    expect(sanitiseForExport('https://user:pw@host.example.com/app')).toBe('https://[REDACTED]@host.example.com/app');
    // A labelled key swallows the rest of the query string: over-redaction is the safe side.
    expect(sanitiseForExport('called https://api.example.com/x?api_key=AKIA123456789&y=1')).toBe(
      'called https://api.example.com/x?api_key=[REDACTED]',
    );
    expect(sanitiseForExport('see https://app.example.com/reset?code=ZXhhbXBsZQ&next=/home')).toBe(
      'see https://app.example.com/reset?code=[REDACTED]&next=/home',
    );
    expect(sanitiseForExport('key sk-live-abcdefghijklmnopqrstuvwxyz0123')).toBe('key [REDACTED]');
    expect(sanitiseForExport('dsn postgresql://ohj:pw@db.example.com:5432/app failed')).toBe('dsn [REDACTED] failed');
    expect(sanitiseForExport('  lots   of\n\nwhitespace ')).toBe('lots of whitespace');
    expect(sanitiseForExport(null)).toBe('');
    expect(sanitiseForExport('x'.repeat(700))).toHaveLength(600);
  });
});

describe('the CSV', () => {
  it('keeps unscored categories blank rather than zero, and separates feedback from assessment', () => {
    const failed = failedBeforeBrowser('permission denied for table submission_credentials');
    const feedbackFailed = row({ feedbackStatus: 'failed', feedbackError: 'Withheld: mentions rank', feedback: null, ranking: { ...row().ranking!, rank: 17 } });
    const [headers, ...records] = parseCsv(buildSubmissionsAuditCsv([failed, feedbackFailed]));
    expect(headers).toEqual([...SUBMISSIONS_AUDIT_HEADERS]);
    expect(records).toHaveLength(2);

    const ranked = records[0]!;
    const unranked = records[1]!;
    expect(ranked[col('Rank')]).toBe('17');
    expect(ranked[col('Assessment Outcome')]).toBe('Completed');
    expect(ranked[col('Feedback Status')]).toBe('failed');
    expect(ranked[col('Feedback Error / Failure Reason')]).toBe('Withheld: mentions rank');
    expect(ranked[col('Problem Clarity')]).not.toBe('');

    expect(unranked[col('Assessment Outcome')]).toBe('Failed');
    expect(unranked[col('Rank')]).toBe('');
    expect(unranked[col('Total Score')]).toBe('');
    expect(unranked[col('Scored Categories')]).toBe('0 of 8');
    for (const label of Object.values(RESULTS_EXPORT_CATEGORY_LABELS)) {
      expect(unranked[col(label)], label).toBe('');
    }
    expect(unranked[col('Feedback Status')]).toBe('not applicable');
    expect(unranked[col('Rank Eligible')]).toBe('no');
    expect(unranked[col('Rank Exclusion Reason')]).toBe('Assessment failed');
    expect(unranked[col('Failure Stage')]).toBe('Browser testing');
    expect(unranked[col('Failure Stage Basis')]).toBe('Derived from existing evidence');
    expect(unranked[col('Reason Source')]).toBe('Explicit system error');
    expect(unranked[col('Reason Evidence Quality')]).toBe('High');
    expect(unranked[col('Attempt Count')]).toBe('2');
    expect(unranked[col('Max Attempts')]).toBe('3');
  });

  it('labels a completed, low-confidence, ranked product as completed and under review', () => {
    const flagged = row({ manualReviewFlags: [flag('low_confidence_scores')], summary: { ...row().summary!, lowConfidence: true, minConfidence: 0.3 } });
    const [, record] = parseCsv(buildSubmissionsAuditCsv([flagged]));
    expect(record![col('Assessment Outcome')]).toBe('Completed');
    expect(record![col('Manual Review')]).toBe('yes');
    expect(record![col('Manual Review Status')]).toBe('open');
    expect(record![col('Low Confidence')]).toBe('yes');
    expect(record![col('Lowest Category Confidence')]).toBe('0.30');
    expect(record![col('Confidence Threshold')]).toBe('0.6');
    expect(record![col('Failure Category')]).toBe('');
    expect(record![col('Rank')]).toBe('1');
  });

  it('guards formula cells and lets nothing secret through', () => {
    const hostile = failedBeforeBrowser('Login failed; password: hunter2; bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
    hostile.productName = '=HYPERLINK("https://evil.example","click")';
    hostile.productUrl = 'https://team:S3cretPw@product.example.com/app';
    hostile.manualReviewFlags = [flag('product_unreachable', { detail: '@cmd | Password=TopSecret1' })];
    const csv = buildSubmissionsAuditCsv([hostile]);
    expect(csv).not.toContain('hunter2');
    expect(csv).not.toContain('S3cretPw');
    expect(csv).not.toContain('TopSecret1');
    expect(csv).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    const [, record] = parseCsv(csv);
    expect(record![col('Product Name')]).toMatch(/^'=HYPERLINK/);
    expect(record![col('Product URL')]).toBe('https://[REDACTED]@product.example.com/app');
    expect(record![col('Manual Review Reason(s)')]).toBe('product unreachable: @cmd | Password=[REDACTED]');
    // Multiline feedback cells survive quoting; a feedback cell that starts
    // like a formula is guarded too.
    const withPlan = row();
    withPlan.feedback!.productSummary = '=1+1 looks like a formula';
    withPlan.feedback!.nextSevenDayPlan = ['first', 'second'];
    withPlan.feedback!.bugs = [{ description: 'Crash on "save"', evidence: 'step 3' }];
    const [, planned] = parseCsv(buildSubmissionsAuditCsv([withPlan]));
    expect(planned![col('Feedback Summary')]).toBe("'=1+1 looks like a formula");
    expect(planned![col('Feedback 7-Day Plan')]).toBe('1. first\n2. second');
    expect(planned![col('Feedback Bugs / Issues')]).toBe('Crash on "save" (evidence: step 3)');
  });

  it('starts with a byte-order mark and orders ranked rows first', () => {
    const csv = buildSubmissionsAuditCsv([failedBeforeBrowser('x'), row({ submissionId: 'b', ranking: { ...row().ranking!, rank: 2 } }), row({ submissionId: 'a' })]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [, ...records] = parseCsv(csv);
    expect(records.map((r) => r[col('Rank')])).toEqual(['1', '2', '']);
    expect(orderAuditRows([failedBeforeBrowser('x'), row()]).map((r) => r.submissionId)).toEqual(['sub-1', 'sub-1']);
  });

  it('leaves the ranked results export untouched', () => {
    expect(RESULTS_EXPORT_HEADERS).toHaveLength(45);
    expect(RESULTS_EXPORT_HEADERS[0]).toBe('Cohort');
    expect(RESULTS_EXPORT_HEADERS[RESULTS_EXPORT_HEADERS.length - 1]).toBe('Submission ID');
    expect(SUBMISSIONS_AUDIT_HEADERS).not.toEqual(RESULTS_EXPORT_HEADERS);
  });

  it('names the file after the cohort and the moment', () => {
    expect(submissionsAuditFilename('AIAP C14', new Date('2026-09-27T09:30:00.123Z'))).toBe(
      'aiap-c14-all-submissions-audit-2026-09-27T09-30-00Z.csv',
    );
  });
});

describe('summariseSubmissionAudit', () => {
  it('counts every row exactly once', () => {
    const rows = [
      row(),
      row({ submissionId: 'flagged', manualReviewFlags: [flag('low_confidence_scores')], ranking: { ...row().ranking!, rank: 2 } }),
      row({ submissionId: 'unranked', ranking: null }),
      failedBeforeBrowser('x'),
      row({ submissionId: 'review', job: { ...row().job!, stage: 'manual_review' }, ranking: null }),
      row({ submissionId: 'dq', disqualification: { status: 'confirmed', reasonCode: 'x', reasonDetail: '' }, ranking: null }),
      row({ submissionId: 'queued', job: { ...row().job!, stage: 'queued' }, ranking: null }),
      row({ submissionId: 'none', job: null, ranking: null }),
    ];
    const summary = summariseSubmissionAudit(rows);
    expect(summary).toEqual({
      total: 8,
      ranked: 2,
      completedUnranked: 1,
      needsHumanReview: 1,
      failed: 1,
      disqualified: 1,
      incomplete: 1,
      notAssessed: 1,
      rankedWithOpenFlags: 1,
    });
    const bucketed = summary.ranked + summary.completedUnranked + summary.needsHumanReview + summary.failed + summary.disqualified + summary.incomplete + summary.notAssessed;
    expect(bucketed).toBe(summary.total);
    expect(submissionAuditRow(rows[0]!)).toHaveLength(SUBMISSIONS_AUDIT_HEADERS.length);
  });
});

describe('the team results sheet', () => {
  it('leads with outcome and rank, ranks first, and never fakes a rank or score', () => {
    const ranked = row({ submissionId: 'r1', groupNumber: 40 });
    const flagged = row({ submissionId: 'r2', groupNumber: 3, ranking: { ...row().ranking!, rank: 2, inShortlist: false }, manualReviewFlags: [flag('low_confidence_scores')] });
    const failed = failedBeforeBrowser('permission denied for table submission_credentials');
    failed.submissionId = 'f1';
    failed.groupNumber = 7;
    const review = row({ submissionId: 'm1', groupNumber: 5, job: { ...row().job!, stage: 'manual_review', lastError: 'The product could not be reached.' }, manualReviewFlags: [flag('product_unreachable')], categoryScores: {}, summary: null, ranking: null, feedback: null, feedbackStatus: 'pending' });
    const queued = row({ submissionId: 'q1', groupNumber: 9, job: { ...row().job!, stage: 'queued' }, categoryScores: {}, summary: null, ranking: null, feedback: null, feedbackStatus: 'pending' });

    const [headersRow, ...records] = parseCsv(buildTeamResultsCsv([queued, failed, flagged, review, ranked]));
    const headers = headersRow!;
    expect(headers).toEqual([...TEAM_RESULTS_HEADERS]);
    expect(headers.slice(0, 8)).toEqual(['Group Number', 'Product Name', 'Idea / Category', 'Ranking Status', 'Rank', 'Total Score', 'In Top 10', 'Assessment Outcome']);
    const c = (name: string) => TEAM_RESULTS_HEADERS.indexOf(name);

    expect(records.map((r) => r[c('Group Number')])).toEqual(['40', '3', '5', '7', '9']);
    expect(records.map((r) => r[c('Ranking Status')])).toEqual([
      'Ranked',
      'Ranked',
      'Not Ranked — Needs Human Review',
      'Not Ranked — Assessment Failed',
      'Not Ranked — Incomplete',
    ]);
    expect(records.map((r) => r[c('Rank')])).toEqual(['1', '2', '', '', '']);
    expect(records.map((r) => r[c('Total Score')])).toEqual(['90.00', '90.00', '', '', '']);
    expect(records.map((r) => r[c('In Top 10')])).toEqual(['yes', 'no', '', '', '']);
    expect(records[1]![c('Why Not Ranked / Review Reason')]).toMatch(/^low confidence scores/);
    expect(records[2]![c('Why Not Ranked / Review Reason')]).toMatch(/could not be reached|routed to a human/);
    expect(records[3]![c('Why Not Ranked / Review Reason')]).toMatch(/refused access to the credentials table/);
    expect(records[3]![c('Problem Clarity')]).toBe('');
    expect(records[0]![c('Problem Clarity')]).toBe((RUBRIC_CATEGORIES[0]!.maxPoints * 0.9).toFixed(2));
    expect(records[4]![c('Failure Category')]).toBe('Incomplete assessment');
    expect(records[3]![c('Technical Detail')]).toMatch(/permission denied/);
    expect(headers[headers.length - 1]).toBe('Technical Detail');
  });
});
