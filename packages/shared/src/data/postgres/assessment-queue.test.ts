import { createInMemoryStorage } from './storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';

/**
 * The assessment queue, against a real Postgres engine.
 *
 * One property matters more than the rest: **two workers never hold the same
 * job**. If that breaks, a submission is assessed twice, two sets of scores
 * exist for one team, and whichever finishes last silently wins.
 *
 * PGlite runs one connection, which is enough for every test here except the
 * concurrency proof — a single connection cannot demonstrate that two
 * simultaneous transactions take disjoint rows, because there is no second
 * transaction. That proof lives in `assessment-concurrency.test.ts` and runs
 * against a real multi-connection server when one is available.
 */

let db: PgliteHandle;

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
});

describe('queueing a cohort', () => {
  it('queues every final submission', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 3);
    const result = await buildAssessmentStore(db, createInMemoryStorage()).enqueueCohort(cohort.id);

    expect(result.queued).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('is idempotent — a second run creates nothing', async () => {
    // The operator presses the button twice, or two operators press it at once.
    // A second job for one submission would assess the team twice.
    const { cohort } = await seedCohortWithSubmissions(db, 3);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());

    await assessment.enqueueCohort(cohort.id);
    const second = await assessment.enqueueCohort(cohort.id);

    expect(second.queued).toBe(0);
    expect(second.skipped).toBe(3);
    expect(await assessment.listJobs(cohort.id)).toHaveLength(3);
  });

  it('leaves drafts alone', async () => {
    // A draft is work in progress. Judging it would score a team on something
    // they had not finished.
    const { cohort } = await seedCohortWithSubmissions(db, 2, { drafts: 2 });
    const result = await buildAssessmentStore(db, createInMemoryStorage()).enqueueCohort(cohort.id);

    expect(result.queued).toBe(2);
  });

  it('returns the existing job when one submission is queued twice', async () => {
    const { submissions } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());

    const first = await assessment.enqueueSubmission(submissions[0]!.id);
    const second = await assessment.enqueueSubmission(submissions[0]!.id);

    expect(second.id).toBe(first.id);
  });
});

describe('claiming', () => {
  it('claims up to the limit and marks the worker', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 5);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    const claimed = await assessment.claimJobs({
      workerId: 'worker-a',
      limit: 3,
      leaseSeconds: 60,
    });

    expect(claimed).toHaveLength(3);
    expect(claimed.every((j) => j.claimedBy === 'worker-a')).toBe(true);
    expect(claimed.every((j) => j.leaseExpiresAt !== null)).toBe(true);
  });

  it('does not hand the same job to a second worker', async () => {
    // Sequential rather than simultaneous — this proves the claim is recorded,
    // not that the lock works. The lock proof needs two connections.
    const { cohort } = await seedCohortWithSubmissions(db, 3);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    const a = await assessment.claimJobs({ workerId: 'a', limit: 3, leaseSeconds: 60 });
    const b = await assessment.claimJobs({ workerId: 'b', limit: 3, leaseSeconds: 60 });

    expect(a).toHaveLength(3);
    expect(b).toHaveLength(0);
  });

  it('counts an attempt on every claim', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    const [claimed] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });
    expect(claimed?.attemptCount).toBe(1);
  });

  it('returns nothing when the limit is zero', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 2);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    expect(await assessment.claimJobs({ workerId: 'a', limit: 0, leaseSeconds: 60 })).toEqual([]);
  });

  it('will not claim a job that has used every attempt', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    await db.query('update assessment_jobs set attempt_count = max_attempts');

    expect(await assessment.claimJobs({ workerId: 'a', limit: 5, leaseSeconds: 60 })).toEqual([]);
  });

  it('respects a retry backoff', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    await db.query("update assessment_jobs set next_attempt_at = now() + interval '1 hour'");

    expect(await assessment.claimJobs({ workerId: 'a', limit: 5, leaseSeconds: 60 })).toEqual([]);
  });
});

describe('leases', () => {
  it('lets another worker take over once a lease has expired', async () => {
    // The reason a crashed worker's jobs come back. Without it, one crash
    // strands a submission for the rest of the night.
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    await assessment.claimJobs({ workerId: 'dead', limit: 1, leaseSeconds: 60 });
    await db.query("update assessment_jobs set lease_expires_at = now() - interval '1 second'");

    const taken = await assessment.claimJobs({ workerId: 'alive', limit: 1, leaseSeconds: 60 });
    expect(taken).toHaveLength(1);
    expect(taken[0]?.claimedBy).toBe('alive');
  });

  it('reclaims expired leases so the queue reads honestly', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 2);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    await assessment.claimJobs({ workerId: 'dead', limit: 2, leaseSeconds: 60 });
    await db.query("update assessment_jobs set lease_expires_at = now() - interval '1 second'");

    expect(await assessment.reclaimExpiredLeases()).toBe(2);

    const jobs = await assessment.listJobs(cohort.id);
    expect(jobs.every((j) => j.claimedBy === null)).toBe(true);
    expect(jobs.every((j) => j.lastError?.includes('lease expired'))).toBe(true);
  });

  it('leaves a live lease alone', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    await assessment.claimJobs({ workerId: 'busy', limit: 1, leaseSeconds: 600 });

    expect(await assessment.reclaimExpiredLeases()).toBe(0);
  });

  it('refuses a heartbeat from a worker that no longer holds the job', async () => {
    // Otherwise a worker that stalled past its lease could extend it back and
    // start writing over the worker that took its place.
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });

    await assessment.heartbeat(job!.id, 'someone-else');

    const after = await assessment.getJob(job!.id);
    expect(after?.claimedBy).toBe('a');
    expect(after?.heartbeatAt?.getTime()).toBe(job!.heartbeatAt?.getTime());
  });

  it('extends the lease for the worker that holds it', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });

    await assessment.heartbeat(job!.id, 'a');

    const after = await assessment.getJob(job!.id);
    expect(after?.leaseExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      job!.leaseExpiresAt!.getTime(),
    );
  });
});

describe('stages', () => {
  it('moves a job forward', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });

    const moved = await assessment.advanceStage(job!.id, 'preflight');
    expect(moved.stage).toBe('preflight');
  });

  it('releases the claim when a job reaches a terminal stage', async () => {
    // A finished job still naming a worker reads as "something is running".
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });

    const done = await assessment.advanceStage(job!.id, 'completed');

    expect(done.claimedBy).toBeNull();
    expect(done.leaseExpiresAt).toBeNull();
    expect(done.completedAt).not.toBeNull();
  });

  it('treats manual review as terminal, not as a failure', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });

    const flagged = await assessment.advanceStage(job!.id, 'manual_review');

    expect(flagged.stage).toBe('manual_review');
    expect(flagged.claimedBy).toBeNull();
    // Not retried: a human has to look, and re-running would not change that.
    expect(await assessment.claimJobs({ workerId: 'b', limit: 5, leaseSeconds: 60 })).toEqual([]);
  });

  it('filters a job listing by stage', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 3);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });
    await assessment.advanceStage(job!.id, 'scoring');

    expect(await assessment.listJobs(cohort.id, { stage: 'scoring' })).toHaveLength(1);
    expect(await assessment.listJobs(cohort.id, { stage: 'queued' })).toHaveLength(2);
  });
});

describe('releasing a job', () => {
  it('schedules a retry and frees the claim', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });

    const released = await assessment.releaseJob(job!.id, {
      retryInMs: 60_000,
      error: 'Product did not respond.',
    });

    expect(released.claimedBy).toBeNull();
    expect(released.stage).toBe('queued');
    expect(released.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(released.lastError).toBe('Product did not respond.');
  });

  it('fails the job when the last attempt is used up', async () => {
    // Releasing it for a retry it can never be claimed for would leave a job
    // that looks retryable in the admin view and is silently stuck.
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    await db.query('update assessment_jobs set attempt_count = max_attempts - 1');
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });

    const released = await assessment.releaseJob(job!.id, { error: 'Timed out again.' });

    expect(released.stage).toBe('failed');
    expect(released.nextAttemptAt).toBeNull();
    expect(released.completedAt).not.toBeNull();
  });

  it('makes a retried job claimable again once the backoff passes', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });
    await assessment.releaseJob(job!.id, { retryInMs: 0, error: 'transient' });

    const again = await assessment.claimJobs({ workerId: 'b', limit: 1, leaseSeconds: 60 });
    expect(again).toHaveLength(1);
    expect(again[0]?.attemptCount).toBe(2);
  });
});

describe('queue stats', () => {
  it('counts nothing for an empty cohort without inventing an ETA', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 0);
    const stats = await buildAssessmentStore(db, createInMemoryStorage()).getQueueStats(cohort.id);

    expect(stats.total).toBe(0);
    expect(stats.projectedCompletionAt).toBeNull();
    expect(stats.averageDurationMs).toBeNull();
  });

  it('has no ETA until something has actually completed', async () => {
    // A projection from zero samples is a guess presented as a measurement, and
    // an operator deciding whether to extend a deadline needs the difference.
    const { cohort } = await seedCohortWithSubmissions(db, 4);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    const stats = await assessment.getQueueStats(cohort.id);
    expect(stats.total).toBe(4);
    expect(stats.averageDurationMs).toBeNull();
    expect(stats.projectedCompletionAt).toBeNull();
  });

  it('breaks the queue down by stage', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 3);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const [job] = await assessment.claimJobs({ workerId: 'a', limit: 1, leaseSeconds: 60 });
    await assessment.advanceStage(job!.id, 'browser_testing');

    const stats = await assessment.getQueueStats(cohort.id);
    expect(stats.byStage.queued).toBe(2);
    expect(stats.byStage.browser_testing).toBe(1);
    expect(stats.byStage.completed).toBe(0);
  });

  it('counts a live claim as running and a finished one as completed', async () => {
    const { cohort } = await seedCohortWithSubmissions(db, 2);
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);
    const claimed = await assessment.claimJobs({ workerId: 'a', limit: 2, leaseSeconds: 600 });
    await assessment.advanceStage(claimed[0]!.id, 'completed');

    const stats = await assessment.getQueueStats(cohort.id);
    expect(stats.completed).toBe(1);
    expect(stats.running).toBe(1);
  });

  it('reports zero tokens rather than a plausible-looking estimate', async () => {
    // Nothing measures token use yet. A number here would be a fabricated cost
    // figure on a budget screen.
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const stats = await buildAssessmentStore(db, createInMemoryStorage()).getQueueStats(cohort.id);
    expect(stats.estimatedTokensUsed).toBe(0);
  });
});

describe('a job that does not exist', () => {
  it('is reported rather than silently ignored', async () => {
    const assessment = buildAssessmentStore(db, createInMemoryStorage());
    const missing = '00000000-0000-4000-8000-000000000000';

    expect(await assessment.getJob(missing)).toBeNull();
    await expect(assessment.advanceStage(missing, 'completed')).rejects.toThrow();
    await expect(assessment.releaseJob(missing, {})).rejects.toThrow();
  });
});
