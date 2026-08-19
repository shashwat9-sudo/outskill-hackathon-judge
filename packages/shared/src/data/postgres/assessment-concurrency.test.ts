import { createInMemoryStorage } from './storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueryResult, SqlClient, SqlDatabase } from './client';
import { buildAssessmentStore } from './repositories/assessment';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';

/**
 * Two workers, one queue: the property everything else depends on.
 *
 * If two workers ever hold the same job, one submission is assessed twice, two
 * sets of scores exist for one team, and whichever run finishes last silently
 * overwrites the other. Nothing downstream detects it.
 *
 * **This test needs a real Postgres server.** The rest of the suite runs on
 * PGlite, which is a genuine Postgres engine but a single-connection one — and
 * a single connection cannot demonstrate that two simultaneous transactions
 * take disjoint rows, because there is no second transaction to run. Asserting
 * this against PGlite would produce a green test that proves nothing, which is
 * worse than no test.
 *
 * So it runs against `TEST_DATABASE_URL` and otherwise skips loudly. Point it
 * at any throwaway Postgres:
 *
 *   TEST_DATABASE_URL=postgres://localhost:5432/ohj_test npm run test
 *
 * Never point it at production. It creates and truncates the full schema.
 */

const CONNECTION_STRING = process.env.TEST_DATABASE_URL;
const WORKERS = 8;
const JOBS = 40;

let db: SqlDatabase | null = null;
let pool: { end: () => Promise<void> } | null = null;

beforeAll(async () => {
  if (!CONNECTION_STRING) return;

  const { Pool } = await import('pg');
  const created = new Pool({ connectionString: CONNECTION_STRING, max: WORKERS + 2 });
  pool = created;

  const run = async <T>(text: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const result = await created.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  };

  db = {
    query: run,
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
      const client = await created.connect();
      try {
        await client.query('begin');
        const value = await fn({
          query: async <R>(text: string, params?: unknown[]) => {
            const r = await client.query(text, params as unknown[]);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query('commit');
        return value;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await created.end();
    },
  };

  const migrations = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../supabase/migrations',
  );
  for (const name of ['0001_schema', '0002_rls', '0004_production_entry', '0005_operations_hardening']) {
    const sql = await readFile(resolve(migrations, `${name}.sql`), 'utf8');
    await created.query(sql).catch((error: Error) => {
      // Already applied from a previous run is fine; anything else is not.
      if (!/already exists/i.test(error.message)) throw error;
    });
  }
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
});

const describeIfServer = CONNECTION_STRING ? describe : describe.skip;

if (!CONNECTION_STRING) {
  // Visible in the run output rather than a silent skip, so nobody reads the
  // suite as having proven this.
  console.warn(
    '\n  ⚠ Queue concurrency proof SKIPPED — no TEST_DATABASE_URL.\n' +
      '    The single-worker claim behaviour is covered by assessment-queue.test.ts,\n' +
      '    but "two workers never claim the same job" has NOT been demonstrated here.\n',
  );
}

describeIfServer('two workers claiming at the same instant', () => {
  it('never hand the same job to both', async () => {
    const store = db!;
    await store.query('truncate cohorts, rubric_versions restart identity cascade');
    await store.query(
      `insert into rubric_versions (version, name, is_active)
       values ('rubric-v2', 'Test rubric', true)
       on conflict (version) do nothing`,
    );

    const { cohort } = await seedCohortWithSubmissions(store, JOBS);
    const assessment = buildAssessmentStore(store, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    // Every worker issues its claim without waiting for the others. This is the
    // race the queue exists to survive.
    const claims = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        assessment.claimJobs({ workerId: `worker-${i}`, limit: 10, leaseSeconds: 120 }),
      ),
    );

    const allIds = claims.flat().map((job) => job.id);
    const uniqueIds = new Set(allIds);

    expect(allIds.length).toBe(uniqueIds.size);
    expect(allIds.length).toBeGreaterThan(0);

    // Every claimed job names exactly one worker, and it is the one that got it.
    for (const [index, claimed] of claims.entries()) {
      for (const job of claimed) {
        expect(job.claimedBy).toBe(`worker-${index}`);
      }
    }
  }, 120_000);

  it('claim every job exactly once between them', async () => {
    const store = db!;
    await store.query('truncate cohorts restart identity cascade');
    const { cohort } = await seedCohortWithSubmissions(store, JOBS, { code: 'RACE2' });
    const assessment = buildAssessmentStore(store, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    const claims = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        assessment.claimJobs({ workerId: `w${i}`, limit: JOBS, leaseSeconds: 120 }),
      ),
    );

    const claimed = claims.flat();
    expect(new Set(claimed.map((j) => j.id)).size).toBe(JOBS);

    // Nothing left behind: SKIP LOCKED must not cause a worker to give up on
    // rows another worker had merely looked at.
    const remaining = await assessment.claimJobs({
      workerId: 'late',
      limit: JOBS,
      leaseSeconds: 120,
    });
    expect(remaining).toEqual([]);
  }, 120_000);

  it('do not double-count attempts on a single job', async () => {
    // A job claimed once must show one attempt. Two workers incrementing the
    // same counter would exhaust max_attempts in a third of the time and fail
    // submissions that were never actually retried.
    const store = db!;
    await store.query('truncate cohorts restart identity cascade');
    const { cohort } = await seedCohortWithSubmissions(store, 5, { code: 'RACE3' });
    const assessment = buildAssessmentStore(store, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        assessment.claimJobs({ workerId: `x${i}`, limit: 5, leaseSeconds: 120 }),
      ),
    );

    const jobs = await assessment.listJobs(cohort.id);
    expect(jobs.every((j) => j.attemptCount === 1)).toBe(true);
  }, 120_000);

  it('let a second worker in only once the lease has expired', async () => {
    const store = db!;
    await store.query('truncate cohorts restart identity cascade');
    const { cohort } = await seedCohortWithSubmissions(store, 1, { code: 'RACE4' });
    const assessment = buildAssessmentStore(store, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    await assessment.claimJobs({ workerId: 'holder', limit: 1, leaseSeconds: 120 });

    const contenders = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        assessment.claimJobs({ workerId: `c${i}`, limit: 1, leaseSeconds: 120 }),
      ),
    );
    expect(contenders.flat()).toEqual([]);

    await store.query("update assessment_jobs set lease_expires_at = now() - interval '1 second'");
    const after = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        assessment.claimJobs({ workerId: `d${i}`, limit: 1, leaseSeconds: 120 }),
      ),
    );

    // Exactly one of them takes it — not none, and not several.
    expect(after.flat()).toHaveLength(1);
  }, 120_000);

  it('let the owner walk its job through every stage while eight rivals tried to take it', async () => {
    /*
     * The stage-progression fix, proved on real connections.
     *
     * A worker runs one stage per claim and keeps ownership between stages, so
     * it must be able to re-claim its own live lease — otherwise a job advances
     * once and then waits out JOB_LEASE_SECONDS, which at the default is one
     * stage every fifteen minutes.
     *
     * The danger in allowing that is obvious, so it is tested here rather than
     * argued: on every single stage, eight other workers poll at the same
     * moment. None of them may ever come away with the job.
     */
    const store = db!;
    await store.query('truncate cohorts restart identity cascade');
    const { cohort } = await seedCohortWithSubmissions(store, 1, { code: 'RACE5' });
    const assessment = buildAssessmentStore(store, createInMemoryStorage());
    await assessment.enqueueCohort(cohort.id);

    const [mine] = await assessment.claimJobs({ workerId: 'owner', limit: 1, leaseSeconds: 900 });
    expect(mine).toBeDefined();
    const jobId = mine!.id;

    const stages = [
      'preflight', 'artifact_analysis', 'test_plan_generation', 'browser_testing',
      'evidence_review', 'scoring', 'consistency_review', 'completed',
    ] as const;

    for (const next of stages) {
      const [owner, ...rivals] = await Promise.all([
        assessment.claimJobs({ workerId: 'owner', limit: 1, leaseSeconds: 900 }),
        ...Array.from({ length: WORKERS }, (_, i) =>
          assessment.claimJobs({ workerId: `rival${i}`, limit: 1, leaseSeconds: 900 }),
        ),
      ]);

      expect(owner, `owner could not continue into ${next}`).toHaveLength(1);
      expect(rivals.flat(), `a rival stole the job before ${next}`).toEqual([]);

      await assessment.advanceStage(jobId, next, null);
    }

    const { rows } = await store.query<{
      stage: string; claimed_by: string | null; attempt_count: number;
    }>('select stage, claimed_by, attempt_count from assessment_jobs where id = $1', [jobId]);

    expect(rows[0]!.stage).toBe('completed');
    // Ownership released at the end, and eight stages cost exactly one attempt.
    expect(rows[0]!.claimed_by).toBeNull();
    expect(rows[0]!.attempt_count).toBe(1);
  }, 120_000);
});