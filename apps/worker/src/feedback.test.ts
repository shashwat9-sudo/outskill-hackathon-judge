import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  type PgliteHandle,
} from '../../../packages/shared/src/data/postgres/testing/pglite';
import { buildAssessmentStore } from '../../../packages/shared/src/data/postgres/repositories/assessment';
import { composePostgresDataStore } from '../../../packages/shared/src/data/postgres/store';
import { createInMemoryStorage } from '../../../packages/shared/src/data/postgres/storage';
import { seedCohortWithSubmissions } from '../../../packages/shared/src/data/postgres/testing/assessment-fixtures';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION, Logger, type DataStore } from '@ohj/shared';
import type { AiClient } from '@ohj/ai';
import { generateFeedbackForSubmission } from './feedback';

/**
 * Producing a participant's feedback report, separately from judging it.
 *
 * The failure this replaces: feedback was a tail call inside the scoring stage,
 * and a report that was refused or errored produced a warning line and nothing
 * else. The job was still `completed`, so a missing report was indistinguishable
 * from one that had never been attempted. 43 of 69 submissions on the C13 run
 * were in that state and nobody knew until somebody opened the page.
 *
 * These tests are mostly about what must NOT happen: a score must not move, a
 * ranking must not be recalculated, and an existing report must not be
 * overwritten by a maintenance run.
 */

const CREDENTIAL_KEY = Buffer.alloc(32, 9).toString('base64');

let db: PgliteHandle;
let store: DataStore;
let submissionId: string;
let jobId: string;
let cohortId: string;

const validReport = {
  productSummary: 'A recipe app that saves what you actually cook.',
  strengths: ['The core flow works.', 'It is fast.', 'The empty state is clear.'],
  improvements: [
    { title: 'Empty states', detail: 'Show something before the first recipe.', priority: 1 },
    { title: 'Errors', detail: 'Say what went wrong.', priority: 2 },
    { title: 'Mobile', detail: 'The button is small on mobile.', priority: 3 },
  ],
  bugs: [{ description: 'Saving twice duplicates.', evidence: 'step 4' }],
  nextSevenDayPlan: ['Add an empty state.'],
};

/** An AI client that answers with whatever the test queues up. */
function fakeAi(responses: (unknown | Error)[]): AiClient {
  let call = 0;
  return {
    modelVersion: 'gpt-5.6-terra',
    providerName: 'openai',
    run: vi.fn(async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) throw next;
      return {
        data: next,
        modelVersion: 'gpt-5.6-terra',
        promptVersion: 'v1',
        usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, requests: 1 },
        degraded: false,
        attempts: 1,
      };
    }),
  } as unknown as AiClient;
}

const deps = (ai: AiClient) => ({ store, ai, log: new Logger({ name: 'test' }) });

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(`insert into rubric_versions (version, name, is_active) values ($1, 'Test', true)`, [
    RUBRIC_VERSION,
  ]);
  const seeded = await seedCohortWithSubmissions(db, 1);
  cohortId = seeded.cohort.id;
  submissionId = seeded.submissions[0]!.id;
  store = composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: 's'.repeat(48),
    credentialKey: CREDENTIAL_KEY,
    credentialKeyVersion: 1,
  });
  const assessment = buildAssessmentStore(db, createInMemoryStorage());
  await assessment.enqueueCohort(cohortId);
  jobId = (await assessment.getJobBySubmission(submissionId))!.id;

  // A judged submission: scores on disk, judging finished.
  await assessment.saveScores(
    jobId,
    RUBRIC_CATEGORIES.map((c) => ({
      categoryKey: c.key,
      rawScore: c.maxPoints / 2,
      maxPoints: c.maxPoints,
      weightedScore: c.maxPoints / 2,
      confidence: 0.8,
      rationale: 'Because of what was observed.',
      supportingEvidence: [],
      contradictoryEvidence: [],
      missingEvidence: [],
      isOverridden: false,
      overrideReason: null,
      overriddenBy: null,
      overriddenAt: null,
      originalRawScore: null,
      modelVersion: 'gpt-5.6-terra',
      promptVersion: 'v1',
      rubricVersion: RUBRIC_VERSION,
    })) as never,
  );
  await db.query(`update assessment_jobs set stage = 'completed' where id = $1`, [jobId]);
});

const scoreFingerprint = async () => {
  const { rows } = await db.query<{ f: string }>(
    `select coalesce(string_agg(category_key || ':' || raw_score || ':' || confidence, ',' order by category_key), '') f
       from category_scores where job_id = $1`,
    [jobId],
  );
  return rows[0]!.f;
};

const feedbackStatus = async () => {
  const { rows } = await db.query<{ s: string; e: string | null; a: number; stage: string }>(
    'select feedback_status s, feedback_error e, feedback_attempts a, stage from assessment_jobs where id = $1',
    [jobId],
  );
  return rows[0]!;
};

// --------------------------------------------------------------------------

describe('Case 1 — completed, scored, feedback missing', () => {
  it('generates and persists the report', async () => {
    const before = await scoreFingerprint();

    const result = await generateFeedbackForSubmission(submissionId, deps(fakeAi([validReport])));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skipped).toBe(false);
    expect(await store.assessment.getFeedbackReport(submissionId)).not.toBeNull();

    // Scores untouched — the whole point of doing this separately.
    expect(await scoreFingerprint()).toBe(before);
    const status = await feedbackStatus();
    expect(status.s).toBe('generated');
    expect(status.stage).toBe('completed');
  });
});

describe('Case 2 — feedback already exists', () => {
  it('skips without overwriting', async () => {
    await generateFeedbackForSubmission(submissionId, deps(fakeAi([validReport])));
    const original = await store.assessment.getFeedbackReport(submissionId);

    const second = await generateFeedbackForSubmission(
      submissionId,
      deps(fakeAi([{ ...validReport, productSummary: 'A COMPLETELY DIFFERENT SUMMARY.' }])),
    );

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skipped).toBe(true);
    const after = await store.assessment.getFeedbackReport(submissionId);
    expect(after!.productSummary).toBe(original!.productSummary);
    expect(after!.generatedAt.getTime()).toBe(original!.generatedAt.getTime());
  });

  it('regenerates only when explicitly forced', async () => {
    await generateFeedbackForSubmission(submissionId, deps(fakeAi([validReport])));

    const forced = await generateFeedbackForSubmission(
      submissionId,
      deps(fakeAi([{ ...validReport, productSummary: 'Rewritten on purpose.' }])),
      { force: true },
    );

    expect(forced.ok).toBe(true);
    if (forced.ok) expect(forced.skipped).toBe(false);
    const after = await store.assessment.getFeedbackReport(submissionId);
    expect(after!.productSummary).toBe('Rewritten on purpose.');
  });
});

describe('Case 3 — the AI fails once', () => {
  it('retries and succeeds', async () => {
    const result = await generateFeedbackForSubmission(
      submissionId,
      deps(fakeAi([new Error('503 upstream'), validReport])),
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect((await feedbackStatus()).s).toBe('generated');
  });

  it('retries when a report is refused for naming a mark', async () => {
    /*
     * The safety rule is unchanged — a report naming a rank or a score is still
     * refused. What changed is that a refusal now costs a retry rather than the
     * whole report.
     */
    const leaky = { ...validReport, productSummary: 'You scored 61/100 overall.' };
    const result = await generateFeedbackForSubmission(
      submissionId,
      deps(fakeAi([leaky, validReport])),
    );

    expect(result.ok).toBe(true);
    const saved = await store.assessment.getFeedbackReport(submissionId);
    expect(saved!.productSummary).not.toContain('61/100');
  });
});

describe('Case 4 — the AI keeps failing', () => {
  it('stops after three attempts and records the failure', async () => {
    const before = await scoreFingerprint();

    const result = await generateFeedbackForSubmission(
      submissionId,
      deps(fakeAi([new Error('persistent outage')])),
    );

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);

    const status = await feedbackStatus();
    expect(status.s).toBe('failed');
    expect(status.e).toContain('persistent outage');
    // Judging is untouched: the score stands and the stage stays completed.
    expect(status.stage).toBe('completed');
    expect(await scoreFingerprint()).toBe(before);
  });

  it('records a failure when every attempt is refused as unsafe', async () => {
    const leaky = { ...validReport, productSummary: 'You are in the top 10.' };

    const result = await generateFeedbackForSubmission(submissionId, deps(fakeAi([leaky])));

    expect(result.ok).toBe(false);
    expect((await feedbackStatus()).s).toBe('failed');
    // Nothing unsafe was stored.
    expect(await store.assessment.getFeedbackReport(submissionId)).toBeNull();
  });
});

describe('Case 5 — the database write fails', () => {
  it('leaves a retryable failure and does not lose the score', async () => {
    const before = await scoreFingerprint();
    const broken = {
      ...store,
      assessment: {
        ...store.assessment,
        saveFeedbackReport: async () => {
          throw new Error('saveFeedbackReport: connection terminated');
        },
      },
    } as unknown as DataStore;

    const result = await generateFeedbackForSubmission(submissionId, {
      store: broken,
      ai: fakeAi([validReport]),
      log: new Logger({ name: 'test' }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('connection terminated');
    const status = await feedbackStatus();
    expect(status.s).toBe('failed');
    expect(await scoreFingerprint()).toBe(before);
  });
});

describe('Case 6 — two retries at once', () => {
  it('persists exactly one report', async () => {
    /*
     * `feedback_reports` is unique per submission, so the second write is an
     * upsert rather than a duplicate row — two operators pressing retry cannot
     * produce two reports for one team.
     */
    const [a, b] = await Promise.all([
      generateFeedbackForSubmission(submissionId, deps(fakeAi([validReport]))),
      generateFeedbackForSubmission(submissionId, deps(fakeAi([validReport]))),
    ]);

    expect(a.ok && b.ok).toBe(true);
    const { rows } = await db.query<{ n: string }>(
      'select count(*) n from feedback_reports where submission_id = $1',
      [submissionId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('finding what is missing', () => {
  it('lists completed submissions with no report, and stops listing them once generated', async () => {
    expect(await store.assessment.listJobsNeedingFeedback(cohortId)).toHaveLength(1);

    await generateFeedbackForSubmission(submissionId, deps(fakeAi([validReport])));

    expect(await store.assessment.listJobsNeedingFeedback(cohortId)).toHaveLength(0);
  });

  it('refuses to write a report for a submission that was never scored', async () => {
    await db.query('delete from category_scores where job_id = $1', [jobId]);

    const result = await generateFeedbackForSubmission(submissionId, deps(fakeAi([validReport])));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no scores/i);
  });
});
