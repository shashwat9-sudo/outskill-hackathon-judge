import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { createInMemoryStorage } from './storage';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import type { AssessmentStore } from '../store';

/**
 * The worker's own read of a submission.
 *
 * Two things have to be true at once, and they pull in opposite directions.
 *
 * The pipeline must be able to finish: a read so narrow that judging cannot
 * complete is not a safer system, it is a broken one, and the first half of
 * this file asserts every field the stages actually dereference.
 *
 * And the worker must not be able to see the ranking. `getSubmissionDetail`
 * returned `rank` and `inShortlist` straight out of `ranking_entries`, which
 * under least privilege failed the whole query — but the deeper problem was
 * that a judging process was reading the standings at all. ADR-018 puts the
 * Final Four in human hands; a machine that cannot see the ranking cannot be
 * steered by it. The second half asserts that absence, by field and by SQL.
 */

let db: PgliteHandle;
let assessment: AssessmentStore;
let cohortId: string;
let submissionId: string;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v1', 'Test', true)`,
  );
  const seeded = await seedCohortWithSubmissions(db, 1);
  cohortId = seeded.cohort.id;
  submissionId = seeded.submissions[0]!.id;
  assessment = buildAssessmentStore(db, createInMemoryStorage());
  await assessment.enqueueCohort(cohortId);
});

describe('what judging is given', () => {
  it('has every field the pipeline dereferences', async () => {
    /*
     * Taken from the pipeline itself rather than from imagination: this is the
     * set of paths `apps/worker/src/pipeline.ts` reads off the loaded detail.
     * If a stage starts needing something new, this test is where it gets
     * declared — alongside the database grant that makes it readable.
     */
    const input = await assessment.getJudgingInput(submissionId);
    expect(input).not.toBeNull();

    // Identity and state.
    expect(input!.submission.id).toBe(submissionId);
    expect(input!.submission.status).toBeDefined();
    expect(input!.submission.isLate).toBeTypeOf('boolean');

    // What the browser stage drives.
    expect(input!.submission).toHaveProperty('productUrl');
    expect(input!.submission).toHaveProperty('loginRequired');
    expect(input!.submission).toHaveProperty('coreTestSteps');
    expect(input!.submission).toHaveProperty('safeSampleInputs');
    expect(input!.submission).toHaveProperty('mustHaveWorkflow');

    // What scoring reads.
    expect(input!.submission).toHaveProperty('productName');
    expect(input!.submission).toHaveProperty('knownLimitations');
    expect(input!.submission).toHaveProperty('nextSevenDayPlan');

    // Cohort configuration the worker runs by.
    expect(input!.cohort.id).toBe(cohortId);
    expect(input!.cohort.rubricVersion).toBe('rubric-v1');
    expect(input!.cohort.assessmentConfig).toBeDefined();
    expect(input!.cohort.assessmentConfig.browserBudgetMs).toBeTypeOf('number');
    expect(input!.cohort.assessmentConfig.lowConfidenceThreshold).toBeTypeOf('number');

    // Team context, used to spot a team judging its own work.
    expect(input!.team.leadName).toBeDefined();
    expect(Array.isArray(input!.members)).toBe(true);

    // The idea being built against, and the artifacts to analyse.
    expect(input!.idea).not.toBeUndefined();
    expect(Array.isArray(input!.artifacts)).toBe(true);
    expect(input!.artifactAnalysis).not.toBeUndefined();
  });

  it('returns the deck artifact the analysis stage looks for', async () => {
    await db.query(
      `insert into submission_artifacts (submission_id, kind, storage_bucket, storage_path, byte_size)
       values ($1, 'deck_pdf', 'submission-decks', 'c/s/deck.pdf', 1024)`,
      [submissionId],
    );

    const input = await assessment.getJudgingInput(submissionId);
    const deck = input!.artifacts.find((a) => a.kind === 'deck_pdf');
    expect(deck?.storageBucket).toBe('submission-decks');
    expect(deck?.storagePath).toBe('c/s/deck.pdf');
  });

  it('carries the idea’s minimum core flow as a list, which drives test planning', async () => {
    const input = await assessment.getJudgingInput(submissionId);
    if (input!.idea) {
      expect(Array.isArray(input!.idea.minimumCoreFlow)).toBe(true);
      expect(Array.isArray(input!.idea.expectedEntities)).toBe(true);
    }
  });

  it('picks up the artifact analysis once a previous stage has written one', async () => {
    const { rows } = await db.query<{ id: string }>(
      `select id from assessment_jobs where submission_id = $1`,
      [submissionId],
    );
    await db.query(
      `insert into artifact_analyses (job_id, deck_page_count, deck_text_extracted,
         deck_analysis, video_analysis_limited, transcript_available, written_analysis,
         injection_flags, model_version, prompt_version)
       values ($1, 7, true, '{}'::jsonb, false, false, '{}'::jsonb, '[]'::jsonb, 'm', 'p')`,
      [rows[0]!.id],
    );

    const input = await assessment.getJudgingInput(submissionId);
    expect(input!.artifactAnalysis?.deckPageCount).toBe(7);
  });

  it('is null for a submission that does not exist, or an id that is not one', async () => {
    expect(await assessment.getJudgingInput('44444444-4444-4444-8444-444444444444')).toBeNull();
    for (const bad of ['', 'not-a-uuid', '../../etc/passwd']) {
      expect(await assessment.getJudgingInput(bad), bad).toBeNull();
    }
  });

  it('is null when the cohort has no active rubric, because there is nothing to score against', async () => {
    await db.query(`update cohorts set rubric_version_id = null where id = $1`, [cohortId]);
    expect(await assessment.getJudgingInput(submissionId)).toBeNull();
  });
});

describe('what judging is not given', () => {
  it('does not carry rank or shortlist state, even when a ranking exists', async () => {
    /*
     * The reason this read exists.
     *
     * A snapshot is generated and marked current, so the data is genuinely
     * there to be leaked. The judging input still knows nothing about it.
     */
    const { rows: snap } = await db.query<{ id: string }>(
      `insert into ranking_snapshots (cohort_id, is_current, rubric_version)
       values ($1, true, 'rubric-v1') returning id`,
      [cohortId],
    );
    await db.query(
      `insert into ranking_entries (snapshot_id, submission_id, rank, total_score, in_shortlist)
       values ($1, $2, 1, 99, true)`,
      [snap[0]!.id, submissionId],
    );

    const input = await assessment.getJudgingInput(submissionId);
    expect(input).not.toBeNull();
    expect(input).not.toHaveProperty('rank');
    expect(input).not.toHaveProperty('inShortlist');

    // Nothing anywhere in the payload mentions the ranking, at any depth.
    const serialised = JSON.stringify(input);
    expect(serialised).not.toContain('inShortlist');
    expect(serialised).not.toContain(snap[0]!.id);
  });

  it('does not carry the audit trail, event timeline or review state', async () => {
    for (const absent of [
      'auditLogs',
      'events',
      'manualReviewFlags',
      'disqualifications',
      'feedbackReport',
      'scores',
      'summary',
      'consistencyReviews',
      'declarations',
      'credentials',
    ]) {
      const input = await assessment.getJudgingInput(submissionId);
      expect(input, absent).not.toHaveProperty(absent);
    }
  });

  it('returns exactly the documented keys and no others', async () => {
    // A whitelist rather than a blacklist: a field added to the query shows up
    // here as a failure, which is the moment to ask whether the worker may see it.
    const input = await assessment.getJudgingInput(submissionId);
    expect(Object.keys(input!).sort()).toEqual(
      ['artifactAnalysis', 'artifacts', 'cohort', 'idea', 'members', 'submission', 'team'].sort(),
    );
  });

  it('never mentions a forbidden table in its SQL', async () => {
    /*
     * Asserted against the source, because the guarantee is that the query does
     * not exist — not that it returns nothing. A policy can be changed by a
     * later migration; a query that was never written cannot start leaking.
     */
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'repositories/judging-input.ts'), 'utf8');
    const sql = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');

    for (const table of [
      'ranking_entries',
      'ranking_snapshots',
      'final_selections',
      'admin_account',
      'admin_sessions',
      'team_access_codes',
      'participant_sessions',
      'audit_logs',
      'submission_events',
    ]) {
      expect(sql, `judging-input.ts queries ${table}`).not.toContain(table);
    }
  });

  it('is not the admin detail type wearing a different name', async () => {
    // The admin view has more than twenty keys. If these ever converge again,
    // the worker has quietly been handed the submission page.
    const input = await assessment.getJudgingInput(submissionId);
    expect(Object.keys(input!).length).toBeLessThan(10);
  });
});
