import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '@ohj/shared';
import type { AdminSubmissionDetail } from '@ohj/shared';
import { SubmissionDetail } from './submission-detail';

/**
 * Every tab, on every shape of submission we actually produce.
 *
 * The page went down in production with "a client-side exception has occurred",
 * which replaces the entire route — not the failing panel. The cause was
 * `summary.totalScore.toFixed(2)` where `totalScore` had arrived as the string
 * Postgres sends for a `numeric` column, and it applied to every completed
 * submission rather than to anything unusual in the data.
 *
 * Nothing caught it because the repository is typed as returning `number` and
 * the mapper casts, so the compiler was told a fact that was false, and no test
 * had ever rendered this component at all.
 *
 * These render each tab in turn. A tab that throws fails its test rather than
 * silently degrading, which is the behaviour the page needs: a missing optional
 * value shows an empty state, and anything else is a bug worth failing on.
 */

vi.mock('@/server/admin-actions', () => ({
  confirmDisqualificationAction: vi.fn(),
  overrideScoreAction: vi.fn(),
  proposeDisqualificationAction: vi.fn(),
  reopenSubmissionAction: vi.fn(),
  rerunAssessmentAction: vi.fn(),
  resolveManualReviewAction: vi.fn(),
  revealCredentialsAction: vi.fn(),
  reverseDisqualificationAction: vi.fn(),
  setLateExceptionAction: vi.fn(),
}));

const ISO = '2026-08-21T12:00:00.000Z';

const TABS = [
  'Overview',
  'Team',
  'Declaration',
  'Artifacts',
  'Preflight',
  'Test plan',
  'Browser evidence',
  'Scores',
  'Feedback',
  'Manual review',
  'Audit history',
];

/**
 * Built the way the page receives it.
 *
 * `page.tsx` sends this through `JSON.parse(JSON.stringify(detail))`, so every
 * Date is already an ISO string by the time the component sees one. Fixtures
 * with real Dates would test a shape that never reaches the browser.
 */
function makeDetail(over: Partial<Record<string, unknown>> = {}): AdminSubmissionDetail {
  const base = {
    submission: {
      id: 'sub-1',
      cohortId: 'cohort-1',
      teamId: 'team-1',
      status: 'locked',
      ideaId: 'idea-1',
      productName: 'Sizzle',
      primaryUser: 'Home cooks',
      exactProblem: 'Recipes are scattered.',
      oneSentencePromise: 'One place for what you cook.',
      briefDescription: 'Share the recipes you actually cook.',
      whyAiNecessary: null,
      differentiation: null,
      mustHaveWorkflow: null,
      shouldHaveFeatures: [],
      excludedFeatures: null,
      productUrl: 'https://sizzle.example.com',
      loomUrl: null,
      deckUrl: null,
      loginRequired: false,
      coreTestSteps: [],
      safeSampleInputs: null,
      resetInstructions: null,
      knownLimitations: null,
      bugsFixed: [],
      deliberatelyExcluded: null,
      majorTradeoff: null,
      day12ToDay13Changes: null,
      whatGotWorking: 'Posting and the feed.',
      mostImportantLearning: null,
      nextSevenDayPlan: null,
      builderStack: null,
      apisUsed: null,
      externalTemplates: null,
      draftPayload: {},
      version: 1,
      draftUpdatedAt: null,
      lastEditedBy: null,
      submittedAt: ISO,
      submittedByName: null,
      receiptId: null,
      lockedAt: ISO,
      reopenedAt: null,
      reopenedReason: null,
      isLate: false,
      hasLateException: false,
      createdAt: ISO,
      updatedAt: ISO,
    },
    team: { id: 'team-1', cohortId: 'cohort-1', groupNumber: 102, createdAt: ISO, updatedAt: ISO },
    members: [],
    cohort: {
      id: 'cohort-1',
      name: 'AIAP C13',
      code: 'AIAP-C13',
      status: 'judging',
      timezone: 'Asia/Kolkata',
      createdAt: ISO,
      updatedAt: ISO,
    },
    idea: { id: 'idea-1', title: 'Recipe Sharing App', slug: 'recipe-sharing-app' },
    artifacts: [],
    declarations: null,
    credentials: null,
    events: [],
    job: {
      id: 'job-1',
      submissionId: 'sub-1',
      cohortId: 'cohort-1',
      stage: 'completed',
      attemptCount: 1,
      maxAttempts: 3,
      lastError: null,
      createdAt: ISO,
      updatedAt: ISO,
    },
    preflight: [],
    artifactAnalysis: null,
    testPlan: null,
    browserRuns: [],
    evidence: [],
    scores: [],
    summary: null,
    consistencyReviews: [],
    manualReviewFlags: [],
    disqualifications: [],
    feedbackReport: null,
    auditLogs: [],
    rank: null,
    inShortlist: false,
    ...over,
  };
  return base as unknown as AdminSubmissionDetail;
}

const fullScores = () =>
  RUBRIC_CATEGORIES.map((category) => ({
    id: `score-${category.key}`,
    jobId: 'job-1',
    categoryKey: category.key,
    rawScore: category.maxPoints / 2,
    maxPoints: category.maxPoints,
    weightedScore: category.maxPoints / 2,
    confidence: 0.8,
    rationale: 'Because of what was observed.',
    supportingEvidence: ['step 3 passed'],
    contradictoryEvidence: [],
    missingEvidence: [],
    isOverridden: false,
    overrideReason: null,
    overriddenBy: null,
    overriddenAt: null,
    originalRawScore: null,
    modelVersion: 'gemini-3.5-flash-lite',
    promptVersion: 'v2',
    rubricVersion: RUBRIC_VERSION,
    createdAt: ISO,
    updatedAt: ISO,
  }));

const summary = () => ({
  id: 'summary-1',
  jobId: 'job-1',
  totalScore: 56,
  meanConfidence: 0.78,
  minConfidence: 0.7,
  lowConfidence: false,
  risks: ['The deck could not be read.'],
  strengths: ['The core flow works.'],
  weaknesses: [],
  bugsFound: [],
  summaryText: 'A working product.',
  modelVersion: 'gemini-3.5-flash-lite',
  promptVersion: 'v2',
  rubricVersion: RUBRIC_VERSION,
  completedAt: ISO,
});

const browserRun = (attempt: number, viewport: 'desktop' | 'mobile') => ({
  id: `run-${attempt}-${viewport}`,
  jobId: 'job-1',
  attempt,
  viewport,
  startedAt: ISO,
  finishedAt: ISO,
  durationMs: 46380,
  status: 'partial',
  browserVersion: 'chromium-1.62.1',
  tracePath: null,
  consoleErrorCount: 2,
  networkFailureCount: 0,
  a11yViolationCount: 1,
  a11ySummary: {},
  cleanupStatus: 'complete',
  timedOut: false,
  steps: [
    {
      id: `step-${attempt}-${viewport}`,
      runId: `run-${attempt}-${viewport}`,
      stepIndex: 0,
      action: 'Post a recipe',
      expectedResult: 'It appears in the feed',
      status: 'passed',
      observedResult: 'It appeared.',
      screenshotPath: null,
      durationMs: 1200,
      consoleErrors: [],
      networkFailures: [],
      assertionDetail: { detail: 'The recipe appeared in the feed.' },
    },
  ],
});

/** Render every tab in turn and fail on the first that throws. */
function renderEveryTab(detail: AdminSubmissionDetail) {
  const { unmount } = render(<SubmissionDetail detail={detail} csrfToken="csrf" />);
  for (const label of TABS) {
    const tab = screen.getByRole('tab', { name: label });
    expect(() => fireEvent.click(tab)).not.toThrow();
  }
  unmount();
}

// --------------------------------------------------------------------------

describe('an ordinary completed submission', () => {
  const detail = () => makeDetail({ scores: fullScores(), summary: summary() });

  it('renders every tab', () => {
    renderEveryTab(detail());
  });

  it('shows the total on the scores tab', () => {
    /*
     * The exact call that failed. `totalScore` arriving as "56.00" rather than
     * 56 threw `toFixed is not a function`, and Next replaced the whole route
     * with an error page.
     */
    render(<SubmissionDetail detail={detail()} csrfToken="csrf" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Scores' }));

    expect(screen.getByText(/Total 56\.00 \/ 100/)).toBeTruthy();
  });

  it('names every rubric category', () => {
    render(<SubmissionDetail detail={detail()} csrfToken="csrf" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Scores' }));

    for (const category of RUBRIC_CATEGORIES) {
      expect(screen.getAllByText(new RegExp(category.title, 'i')).length).toBeGreaterThan(0);
    }
  });
});

describe('a submission that was judged again', () => {
  it('renders every tab with several preflight attempts and browser runs', () => {
    renderEveryTab(
      makeDetail({
        scores: fullScores(),
        summary: summary(),
        job: {
          id: 'job-1',
          submissionId: 'sub-1',
          cohortId: 'cohort-1',
          stage: 'completed',
          attemptCount: 3,
          maxAttempts: 5,
          lastError: null,
          createdAt: ISO,
          updatedAt: ISO,
        },
        preflight: [1, 2, 3].flatMap((attempt) =>
          ['deck_readable', 'demo_link_accessible'].map((checkKey) => ({
            id: `${checkKey}-${attempt}`,
            jobId: 'job-1',
            checkKey,
            status: attempt === 3 ? 'pass' : 'warn',
            attemptNumber: attempt,
            failureClass: 'none',
            detail: { message: 'Deck link is reachable (200).' },
            checkedAt: ISO,
          })),
        ),
        browserRuns: [
          browserRun(1, 'desktop'),
          browserRun(1, 'mobile'),
          browserRun(3, 'desktop'),
          browserRun(3, 'mobile'),
        ],
      }),
    );
  });

  it('renders every tab with a resolved historical manual-review flag', () => {
    renderEveryTab(
      makeDetail({
        scores: fullScores(),
        summary: summary(),
        manualReviewFlags: [
          {
            id: 'flag-1',
            submissionId: 'sub-1',
            reasonCode: 'product_unreachable',
            detail: 'The product URL did not respond.',
            raisedBy: 'system',
            status: 'resolved',
            resolvedBy: 'system',
            resolvedAt: ISO,
            resolutionNote: 'Superseded by judging attempt 3.',
            createdAt: ISO,
            updatedAt: ISO,
          },
        ],
      }),
    );
  });
});

describe('supporting evidence that is missing or link-based', () => {
  it('renders every tab with no deck, no Loom and no artifacts', () => {
    renderEveryTab(makeDetail({ scores: fullScores(), summary: summary() }));
  });

  it('renders every tab with URL-based deck and Loom and still no artifact rows', () => {
    /*
     * The shape every sheet-ingested submission has: links on the submission,
     * and `submission_artifacts` empty because learners upload nothing into
     * the Judge.
     */
    const detail = makeDetail({ scores: fullScores(), summary: summary() });
    (detail.submission as unknown as Record<string, unknown>).loomUrl =
      'https://www.loom.com/share/abc';
    (detail.submission as unknown as Record<string, unknown>).deckUrl =
      'https://drive.google.com/open?id=abc';

    renderEveryTab(detail);
  });

  it('renders every tab with an artifact whose size and checksum are unknown', () => {
    renderEveryTab(
      makeDetail({
        scores: fullScores(),
        summary: summary(),
        artifacts: [
          {
            id: 'artifact-1',
            submissionId: 'sub-1',
            kind: 'deck_pdf',
            storageBucket: 'decks',
            storagePath: 'sub-1/deck.pdf',
            originalFilename: null,
            mimeType: null,
            byteSize: null,
            checksumSha256: null,
            externalUrl: null,
            uploadCompletedAt: null,
            isAccessible: null,
            lastCheckedAt: null,
            createdAt: ISO,
          },
        ],
      }),
    );
  });
});

describe('a partial or failed assessment', () => {
  it('renders every tab with no browser evidence at all', () => {
    renderEveryTab(makeDetail({ scores: fullScores(), summary: summary(), browserRuns: [] }));
  });

  it('renders every tab when nothing has been judged yet', () => {
    renderEveryTab(makeDetail({ job: null }));
  });

  it('renders every tab for a failed job with no scores and no summary', () => {
    renderEveryTab(
      makeDetail({
        job: {
          id: 'job-1',
          submissionId: 'sub-1',
          cohortId: 'cohort-1',
          stage: 'failed',
          attemptCount: 3,
          maxAttempts: 3,
          lastError: 'Product was unreachable.',
          createdAt: ISO,
          updatedAt: ISO,
        },
      }),
    );
  });

  it('renders every tab when scores exist but the summary does not', () => {
    // A run that stopped between saving scores and writing the summary.
    renderEveryTab(makeDetail({ scores: fullScores(), summary: null }));
  });
});

describe('nullable optional values', () => {
  it('renders every tab with the whole written submission empty', () => {
    /*
     * A missing optional value must produce an empty state, not take the page
     * down with it. Every nullable text field is null here at once.
     */
    const detail = makeDetail({ scores: fullScores(), summary: summary(), idea: null });
    const s = detail.submission as unknown as Record<string, unknown>;
    for (const key of [
      'productName',
      'primaryUser',
      'exactProblem',
      'oneSentencePromise',
      'briefDescription',
      'whatGotWorking',
      'productUrl',
      'submittedAt',
      'lockedAt',
    ]) {
      s[key] = null;
    }

    renderEveryTab(detail);
  });

  it('renders a browser run with no duration or browser version', () => {
    const run = { ...browserRun(1, 'desktop'), durationMs: null, browserVersion: null };
    renderEveryTab(makeDetail({ scores: fullScores(), summary: summary(), browserRuns: [run] }));
  });

  it('renders jsonb columns holding the JSON value null', () => {
    /*
     * `preflight_checks.detail` and `browser_test_steps.assertion_detail` are
     * NOT NULL, so no row today holds one — but jsonb NOT NULL still permits
     * the JSON value `null`, and both were dereferenced through a cast with no
     * check. A cast is a claim about a value, not a guarantee about it.
     */
    const run = browserRun(1, 'desktop');
    run.steps[0]!.assertionDetail = null as never;

    renderEveryTab(
      makeDetail({
        scores: fullScores(),
        summary: summary(),
        browserRuns: [run],
        preflight: [
          {
            id: 'check-1',
            jobId: 'job-1',
            checkKey: 'deck_readable',
            status: 'warn',
            attemptNumber: 1,
            failureClass: 'none',
            detail: null,
            checkedAt: ISO,
          },
        ],
      }),
    );
  });
});
