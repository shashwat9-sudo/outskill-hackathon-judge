import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { buildSubmissionStore } from './repositories/submissions';
import { createInMemoryStorage } from './storage';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';
import type { AssessmentStore, SubmissionStore } from '../store';
import type { CategoryScore } from '../types';

/**
 * The numbers the admin detail page is handed.
 *
 * `numeric` columns come back from Postgres as strings — the value is exact
 * and JavaScript numbers are not, so the driver refuses to lose precision on
 * your behalf. Every reader therefore has to convert, and the worker's mappers
 * always did.
 *
 * `loadAssessmentSections` did not. It used the generic `mapRows`, which
 * renames columns and stops, so the admin page received `totalScore` as
 * "56.00". Rendering calls `.toFixed(2)` on it, strings have no `toFixed`, and
 * the resulting TypeError took down the whole page as "a client-side exception
 * has occurred" — for every completed submission, not for any unusual one.
 *
 * Types made it invisible: `AssessmentSummary.totalScore` is declared `number`
 * and `mapRows` casts, so the compiler was told a fact that was false. These
 * tests assert the runtime type, which is the only thing that was ever wrong.
 */

const CREDENTIAL_KEY = Buffer.alloc(32, 3).toString('base64');

let db: PgliteHandle;
let assessment: AssessmentStore;
let submissions: SubmissionStore;
let submissionId: string;
let jobId: string;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ($1, 'Test', true)`,
    [RUBRIC_VERSION],
  );
  const seeded = await seedCohortWithSubmissions(db, 1);
  submissionId = seeded.submissions[0]!.id;
  assessment = buildAssessmentStore(db, createInMemoryStorage());
  submissions = buildSubmissionStore({ db, credentialKey: CREDENTIAL_KEY });
  await assessment.enqueueCohort(seeded.cohort.id);
  jobId = (await assessment.getJobBySubmission(submissionId))!.id;
});

const scores = () =>
  RUBRIC_CATEGORIES.map((category) => ({
    categoryKey: category.key,
    rawScore: category.maxPoints / 2,
    maxPoints: category.maxPoints,
    weightedScore: category.maxPoints / 2,
    confidence: 0.7,
    rationale: 'Because of what was observed.',
    supportingEvidence: ['step 3 passed'],
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
  })) as Omit<CategoryScore, 'id' | 'jobId' | 'createdAt' | 'updatedAt'>[];

const judge = async () => {
  await assessment.saveScores(jobId, scores());
  await assessment.saveSummary({
    jobId,
    totalScore: 56,
    meanConfidence: 0.78,
    minConfidence: 0.7,
    lowConfidence: false,
    risks: ['One risk.'],
    strengths: ['One strength.'],
    weaknesses: [],
    bugsFound: [],
    internalNotes: null,
    modelVersion: 'test-model',
    promptVersion: 'test-prompt',
    completedAt: new Date(),
  });
};

describe('the numbers on a completed submission', () => {
  it('hands the page numbers, not the strings the driver sends', async () => {
    await judge();

    const detail = await submissions.getSubmissionDetail(submissionId);

    // `typeof`, not a value comparison: "56.00" == 56 is true in JavaScript,
    // so an equality assertion would have passed throughout the outage.
    expect(typeof detail!.summary!.totalScore).toBe('number');
    expect(typeof detail!.summary!.meanConfidence).toBe('number');
    expect(typeof detail!.summary!.minConfidence).toBe('number');
  });

  it('does the same for every category score', async () => {
    await judge();

    const detail = await submissions.getSubmissionDetail(submissionId);

    expect(detail!.scores).toHaveLength(RUBRIC_CATEGORIES.length);
    for (const score of detail!.scores) {
      expect(typeof score.rawScore).toBe('number');
      expect(typeof score.maxPoints).toBe('number');
      expect(typeof score.weightedScore).toBe('number');
      expect(typeof score.confidence).toBe('number');
    }
  });

  it('survives the call the page actually makes', async () => {
    /*
     * The precise failure. `.toFixed` is what the scores tab calls, and a
     * string does not have it — so this is the assertion that would have
     * caught the outage rather than describing it.
     */
    await judge();

    const detail = await submissions.getSubmissionDetail(submissionId);

    expect(() => detail!.summary!.totalScore.toFixed(2)).not.toThrow();
    // 50: the summary total is derived from the saved scores, not taken on
    // trust from the caller, so it is the sum of the weighted scores above.
    expect(detail!.summary!.totalScore.toFixed(2)).toBe('50.00');
    for (const score of detail!.scores) {
      expect(() => score.confidence.toFixed(2)).not.toThrow();
    }
  });

  it('keeps the score itself unchanged', async () => {
    // Converting must not round, rescale or otherwise touch the mark.
    await judge();

    const detail = await submissions.getSubmissionDetail(submissionId);

    expect(detail!.summary!.totalScore).toBe(50);
    expect(detail!.scores.find((s) => s.categoryKey === 'core_workflow')?.rawScore).toBe(12.5);
  });

  it('reports no summary rather than a broken one before judging', async () => {
    const detail = await submissions.getSubmissionDetail(submissionId);

    expect(detail!.summary).toBeNull();
    expect(detail!.scores).toEqual([]);
    expect(detail!.feedbackReport).toBeNull();
  });

  it('parses the jsonb the page iterates over', async () => {
    // `risks.map(...)` is called directly. A JSON string would throw the same
    // way `.toFixed` did.
    await judge();

    const detail = await submissions.getSubmissionDetail(submissionId);

    expect(Array.isArray(detail!.summary!.risks)).toBe(true);
    expect(Array.isArray(detail!.scores[0]!.supportingEvidence)).toBe(true);
  });
});

describe('a submission that was judged more than once', () => {
  it('still returns one set of scores, as numbers', async () => {
    /*
     * A re-judge replaces scores rather than appending, but preflight checks
     * and browser runs accumulate by attempt. The page has to cope with both
     * at once.
     */
    await judge();
    await assessment.recordPreflight(jobId, [
      {
        checkKey: 'deck_readable',
        status: 'warn',
        attemptNumber: 1,
        failureClass: 'none',
        detail: { message: 'No pitch deck link was supplied.' },
        checkedAt: new Date(),
      },
    ]);
    await assessment.recordPreflight(jobId, [
      {
        checkKey: 'deck_readable',
        status: 'pass',
        attemptNumber: 2,
        failureClass: 'none',
        detail: { message: 'Deck link is reachable (200).' },
        checkedAt: new Date(),
      },
    ]);
    await judge();

    const detail = await submissions.getSubmissionDetail(submissionId);

    expect(detail!.scores).toHaveLength(RUBRIC_CATEGORIES.length);
    expect(typeof detail!.summary!.totalScore).toBe('number');
    // Both attempts stay visible — that is the point of recording them.
    expect(detail!.preflight).toHaveLength(2);
    expect(detail!.preflight.map((c) => c.attemptNumber).sort()).toEqual([1, 2]);
  });
});
