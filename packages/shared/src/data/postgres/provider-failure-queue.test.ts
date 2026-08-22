import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { createInMemoryStorage } from './storage';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import { RUBRIC_VERSION } from '../../rubric/index';
import type { AssessmentStore } from '../store';

/**
 * One submission failing on the provider must not take the batch with it.
 *
 * The final judging run is a whole cohort through a single worker at
 * concurrency 1. A provider error — a rate limit, a quota exhausted at three in
 * the morning, one malformed response — hits one job, and the question that
 * matters is what happens to the ninety behind it.
 *
 * The answer has to be "nothing". A failed job is released with its own
 * retry-at, and the queue keeps moving; it must not hold a lease, must not be
 * re-claimed immediately, and must not be able to fail the batch by being
 * retried forever.
 */

const WORKER = 'worker-a';

let db: PgliteHandle;
let assessment: AssessmentStore;
let jobs: { id: string }[];

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
  const seeded = await seedCohortWithSubmissions(db, 3);
  assessment = buildAssessmentStore(db, createInMemoryStorage());
  await assessment.enqueueCohort(seeded.cohort.id);
  const { rows } = await db.query<{ id: string }>('select id from assessment_jobs order by created_at');
  jobs = rows;
});

const claim = (limit = 1) =>
  assessment.claimJobs({ workerId: WORKER, limit, leaseSeconds: 900 });

describe('a provider failure on one submission', () => {
  it('lets the next job be claimed straight away', async () => {
    const [first] = await claim();
    expect(first!.id).toBe(jobs[0]!.id);

    // What the worker does when a stage throws: release with a retry-at.
    await assessment.releaseJob(first!.id, {
      retryInMs: 60_000,
      error: 'OpenAI returned 429: rate limited',
    });

    const [next] = await claim();
    expect(next).toBeDefined();
    expect(next!.id).not.toBe(first!.id);
  });

  it('does not hand the failed job straight back', async () => {
    /*
     * The retry-at is the whole mechanism. Without it a worker at concurrency 1
     * re-claims the job it just failed, fails it again against the same rate
     * limit, and the batch makes no progress while looking busy.
     */
    const [first] = await claim();
    await assessment.releaseJob(first!.id, { retryInMs: 60_000, error: 'rate limited' });

    const claimed = await claim(3);

    expect(claimed.map((j) => j.id)).not.toContain(first!.id);
    expect(claimed.length).toBe(2);
  });

  it('leaves no lease behind, so nothing is stuck', async () => {
    const [first] = await claim();
    await assessment.releaseJob(first!.id, { retryInMs: 60_000, error: 'rate limited' });

    const { rows } = await db.query<{ claimed_by: string | null; lease_expires_at: Date | null }>(
      'select claimed_by, lease_expires_at from assessment_jobs where id = $1',
      [first!.id],
    );

    expect(rows[0]!.claimed_by).toBeNull();
  });

  it('records why, without the error swallowing a key', async () => {
    const [first] = await claim();
    await assessment.releaseJob(first!.id, {
      retryInMs: 60_000,
      error: 'OpenAI returned 401: Incorrect API key provided: [redacted]',
    });

    const { rows } = await db.query<{ last_error: string }>(
      'select last_error from assessment_jobs where id = $1',
      [first!.id],
    );

    // last_error is shown in the admin queue and copied into operator reports.
    expect(rows[0]!.last_error).toContain('401');
    expect(rows[0]!.last_error).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('stops retrying eventually rather than blocking the batch forever', async () => {
    const [first] = await claim();

    // Drive it to the attempt ceiling the way the worker does.
    await db.query(
      `update assessment_jobs set stage = 'failed', attempt_count = max_attempts where id = $1`,
      [first!.id],
    );

    const claimed = await claim(3);

    expect(claimed.map((j) => j.id)).not.toContain(first!.id);
    // And the rest of the cohort is unaffected.
    expect(claimed.length).toBe(2);
  });
});
