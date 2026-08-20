import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { createInMemoryStorage } from './storage';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import type { AssessmentStore } from '../store';

/**
 * Which browser runs a judgement is allowed to see.
 *
 * Scores and rubric evidence already replaced themselves on a re-judge; browser
 * runs did not. They were appended, so a submission judged twice held a
 * desktop/mobile pair per attempt and `listBrowserRuns` — the read scoring uses
 * — returned all of them. A mark computed that way counts console errors and
 * failed steps from a run that no longer describes the product, and is
 * defensible to nobody.
 *
 * The fix records the attempt instead of deleting the history, so these tests
 * are about two things at once: that judging sees only the current attempt, and
 * that everything earlier is still there to audit.
 *
 * The distinction that matters throughout: a worker restarting mid-stage keeps
 * its lease and resumes the *same* attempt, while a re-queue or a takeover
 * after a crash begins a new one.
 */

let db: PgliteHandle;
let assessment: AssessmentStore;
let cohortId: string;
let jobId: string;

const WORKER = 'worker-a';

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Test', true)`,
  );
  const seeded = await seedCohortWithSubmissions(db, 1);
  cohortId = seeded.cohort.id;
  assessment = buildAssessmentStore(db, createInMemoryStorage());
  await assessment.enqueueCohort(cohortId);
  const { rows } = await db.query<{ id: string }>('select id from assessment_jobs');
  jobId = rows[0]!.id;
});

const claim = () => assessment.claimJobs({ workerId: WORKER, limit: 1, leaseSeconds: 900 });

/** One browser run, as the pipeline saves it. */
const saveRun = (viewport: 'desktop' | 'mobile', consoleErrors: number, stepCount = 2) =>
  assessment.saveBrowserRun(
    {
      jobId,
      viewport,
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 1000,
      status: 'passed',
      browserVersion: 'chromium-1.62.1',
      tracePath: null,
      consoleErrorCount: consoleErrors,
      networkFailureCount: 0,
      a11yViolationCount: 0,
      a11ySummary: {},
      cleanupStatus: 'complete',
      timedOut: false,
    },
    Array.from({ length: stepCount }, (_, i) => ({
      stepIndex: i,
      action: 'navigate',
      status: 'passed' as const,
      durationMs: 10,
      errorMessage: null,
      screenshotPath: null,
      assertionDetail: {},
    })),
  );

/** Every run ever recorded, the way the admin view reads them. */
const allRuns = async () => {
  const { rows } = await db.query<{ attempt: number; viewport: string; console_error_count: number }>(
    'select attempt, viewport, console_error_count from browser_test_runs where job_id = $1 order by attempt, viewport',
    [jobId],
  );
  return rows;
};

describe('a first judgement', () => {
  it('records one run per viewport, stamped with the attempt that produced it', async () => {
    await claim();
    await saveRun('desktop', 1);
    await saveRun('mobile', 2);

    const runs = await allRuns();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.attempt === 1)).toBe(true);

    const visible = await assessment.listBrowserRuns(jobId);
    expect(visible).toHaveLength(2);
  });
});

describe('a restart during the same attempt', () => {
  it('replaces its own partial run rather than adding a second', async () => {
    /*
     * The worker owns a live lease, so re-claiming continues the same attempt.
     * The second execution describes the product better than the first and
     * takes its place — one run per viewport, not two.
     */
    await claim();
    await saveRun('desktop', 9);
    await claim(); // restart: same worker, live lease, same attempt
    await saveRun('desktop', 1);

    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.attempt).toBe(1);
    expect(runs[0]!.console_error_count).toBe(1);
  });

  it('rewrites the steps instead of hanging both executions off one run', async () => {
    await claim();
    await saveRun('desktop', 0, 5);
    await saveRun('desktop', 0, 2);

    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from browser_test_steps s
         join browser_test_runs r on r.id = s.run_id where r.job_id = $1`,
      [jobId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe('a genuine re-judge', () => {
  it('starts a new attempt beside the old one, without destroying it', async () => {
    await claim();
    await saveRun('desktop', 7);
    await saveRun('mobile', 7);

    // A takeover after the lease lapsed is a new attempt — the same thing a
    // re-queue produces.
    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );
    await assessment.claimJobs({ workerId: 'worker-b', limit: 1, leaseSeconds: 900 });
    await saveRun('desktop', 0);
    await saveRun('mobile', 0);

    const runs = await allRuns();
    expect(runs).toHaveLength(4);
    expect(runs.filter((r) => r.attempt === 1)).toHaveLength(2);
    expect(runs.filter((r) => r.attempt === 2)).toHaveLength(2);
  });

  it('shows judging only the current attempt', async () => {
    // The property the whole change exists for.
    await claim();
    await saveRun('desktop', 7);
    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );
    await assessment.claimJobs({ workerId: 'worker-b', limit: 1, leaseSeconds: 900 });
    await saveRun('desktop', 0);

    const visible = await assessment.listBrowserRuns(jobId);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.consoleErrorCount).toBe(0);
    expect(visible[0]!.attempt).toBe(2);
  });

  it('keeps every earlier attempt readable for audit', async () => {
    await claim();
    await saveRun('desktop', 7);
    for (const worker of ['worker-b', 'worker-c']) {
      await db.query(
        `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
        [jobId],
      );
      await assessment.claimJobs({ workerId: worker, limit: 1, leaseSeconds: 900 });
      await saveRun('desktop', 0);
    }

    // Three attempts on record, one visible to judging.
    expect(await allRuns()).toHaveLength(3);
    expect(await assessment.listBrowserRuns(jobId)).toHaveLength(1);
  });
});

describe('evidence isolation between attempts', () => {
  it('never mixes an old attempt’s steps into the current run set', async () => {
    await claim();
    await saveRun('desktop', 0, 4);
    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );
    await assessment.claimJobs({ workerId: 'worker-b', limit: 1, leaseSeconds: 900 });
    await saveRun('desktop', 0, 1);

    const visible = await assessment.listBrowserRuns(jobId);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.steps).toHaveLength(1);
  });

  it('cannot be handed an attempt by its caller', async () => {
    /*
     * The attempt is read from the job. A caller able to choose one could write
     * into a previous attempt's slot and put stale evidence back in front of
     * scoring — which is the failure this change removes, reintroduced by hand.
     */
    await claim();
    await assessment.saveBrowserRun(
      { attempt: 99, jobId, viewport: 'desktop', startedAt: new Date(),
        finishedAt: new Date(), durationMs: 1, status: 'passed', browserVersion: 'c',
        tracePath: null, consoleErrorCount: 0, networkFailureCount: 0, a11yViolationCount: 0,
        a11ySummary: {}, cleanupStatus: 'complete', timedOut: false } as never,
      [],
    );

    const runs = await allRuns();
    expect(runs[0]!.attempt).toBe(1);
  });
});

describe('scoring and ranking', () => {
  it('produces one set of category scores across a re-judge', async () => {
    // Scores already replaced themselves; asserted here so the attempt work
    // cannot quietly change that.
    const scores = (attempt: number) =>
      Array.from({ length: 8 }, (_, i) => ({
        categoryKey: ['problem_clarity','core_workflow','solution_usefulness','ai_usefulness',
          'two_day_execution','ease_of_use','practical_potential','deck_demo'][i]!,
        rawScore: attempt, maxPoints: 10, weightedScore: attempt, confidence: 0.9,
        rationale: 'r', supportingEvidence: [], contradictoryEvidence: [], missingEvidence: [],
        modelVersion: 'm', promptVersion: 'p', rubricVersion: 'rubric-v2',
      }));

    await claim();
    await assessment.saveScores(jobId, scores(1) as never);
    await assessment.saveScores(jobId, scores(2) as never);

    const { rows } = await db.query<{ n: string }>(
      'select count(*) n from category_scores where job_id = $1',
      [jobId],
    );
    expect(Number(rows[0]!.n)).toBe(8);
  });

  it('ranks from the current assessment only', async () => {
    /*
     * Ranking reads the summary, and there is one summary per job. With browser
     * runs now scoped to the current attempt, every input to a rank describes
     * the same execution.
     */
    await claim();
    await saveRun('desktop', 0);
    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from browser_test_runs r join assessment_jobs j on j.id = r.job_id
        where r.job_id = $1 and r.attempt = j.attempt_count`,
      [jobId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('migrating a database that already has repeat runs', () => {
  it('numbers historical runs so none of them collide', async () => {
    /*
     * The migration failed against production the first time it was run. Jobs
     * that had been re-judged already held two runs per viewport, and marking
     * every historical row `attempt = 0` made them duplicates under the unique
     * index — so the databases with the most history were exactly the ones that
     * could not be migrated.
     *
     * This asserts the shape the migration now produces: every historical run
     * kept, each with its own number, all at or below zero so none can ever be
     * mistaken for the current attempt.
     */
    await claim();
    await saveRun('desktop', 1);
    await saveRun('mobile', 1);

    /*
     * Rewind to the pre-migration state. The index has to come off first — its
     * absence is precisely the condition the backfill runs under.
     */
    await db.query(`drop index if exists browser_test_runs_job_attempt_viewport`);
    await db.query(`update browser_test_runs set attempt = 0`);
    await db.query(
      `insert into browser_test_runs
         (job_id, attempt, viewport, started_at, finished_at, duration_ms, status,
          browser_version, console_error_count, network_failure_count,
          a11y_violation_count, a11y_summary, cleanup_status, timed_out)
       select job_id, 0, viewport, started_at - interval '1 hour', finished_at, duration_ms, status,
              browser_version, console_error_count, network_failure_count,
              a11y_violation_count, a11y_summary, cleanup_status, timed_out
         from browser_test_runs`,
    );

    // The migration's backfill, applied to that state.
    await db.query(
      `with numbered as (
         select id, -(row_number() over (partition by job_id, viewport order by started_at desc) - 1) as attempt
           from browser_test_runs
       )
       update browser_test_runs r set attempt = numbered.attempt
         from numbered where numbered.id = r.id`,
    );

    // The index the migration then creates. If the backfill left a collision,
    // this throws — which is exactly how production refused the first attempt.
    await db.query(
      `create unique index browser_test_runs_job_attempt_viewport
         on browser_test_runs (job_id, attempt, viewport)`,
    );

    const after = await db.query<{ job_id: string; viewport: string; attempt: number }>(
      'select job_id, viewport, attempt from browser_test_runs',
    );
    // Four rows, all preserved, and every (job, viewport, attempt) distinct.
    expect(after.rows).toHaveLength(4);
    const keys = after.rows.map((r) => `${r.job_id}|${r.viewport}|${r.attempt}`);
    expect(new Set(keys).size).toBe(keys.length);
    // And none can be mistaken for a live attempt, which starts at 1.
    expect(after.rows.every((r) => r.attempt <= 0)).toBe(true);
  });
});
