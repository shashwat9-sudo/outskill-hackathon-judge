import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { buildEvidenceStore, type EvidenceStore } from './repositories/evidence';
import { createInMemoryStorage } from './storage';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import type { AssessmentStore } from '../store';

/**
 * How a job moves from one stage to the next.
 *
 * The worker runs one stage per claim, and `advanceStage` keeps ownership
 * between stages so nobody else picks up a job that is halfway through. Those
 * two facts together meant a job could not move: the claim predicate excluded
 * everything with a live lease, including the claiming worker's own work, so a
 * job advanced one stage and then waited for its lease to expire. At the
 * default 900 seconds that is one stage every fifteen minutes.
 *
 * It was invisible in tests because every existing test claimed a job once.
 * It was invisible in production until a job was watched for longer than a
 * poll interval. These tests watch the second claim, which is where the bug
 * lived, and they pin the invariants that make continuing safe: a worker may
 * resume its own live lease, nobody else may, and resuming is not a new
 * attempt.
 */

const LEASE = 900;
const A = 'worker-a';
const B = 'worker-b';

let db: PgliteHandle;
let assessment: AssessmentStore;
let evidence: EvidenceStore;
let cohortId: string;
let storage: ReturnType<typeof createInMemoryStorage>;

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
  storage = createInMemoryStorage();
  assessment = buildAssessmentStore(db, storage);
  evidence = buildEvidenceStore(db, storage);
  await assessment.enqueueCohort(cohortId);
});

const claim = (workerId: string, limit = 5) =>
  assessment.claimJobs({ workerId, limit, leaseSeconds: LEASE });

const jobRow = async (id: string) => {
  const { rows } = await db.query<{
    stage: string;
    claimed_by: string | null;
    attempt_count: number;
    lease_expires_at: Date | null;
  }>(`select stage, claimed_by, attempt_count, lease_expires_at from assessment_jobs where id = $1`, [
    id,
  ]);
  return rows[0]!;
};

/** The stages a healthy job walks through, in order. */
const HAPPY_PATH = [
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
  'completed',
] as const;

describe('a healthy job moving through its stages', () => {
  it('advances every stage without waiting for a lease to expire', async () => {
    /*
     * The regression test for the defect itself.
     *
     * No clock is moved and no lease is expired anywhere in this test. If the
     * claim predicate ever again excludes a worker's own live lease, the second
     * iteration claims nothing and this fails on the first assertion.
     */
    const [first] = await claim(A);
    expect(first).toBeDefined();
    const jobId = first!.id;

    for (const next of HAPPY_PATH) {
      const [claimed] = await claim(A);
      expect(claimed, `should have re-claimed its own job to run ${next}`).toBeDefined();
      expect(claimed!.id).toBe(jobId);
      await assessment.advanceStage(jobId, next, null);
    }

    const done = await jobRow(jobId);
    expect(done.stage).toBe('completed');
  });

  it('does not spend an attempt per stage', async () => {
    /*
     * Continuing is the same attempt. If it were not, a job with more stages
     * than `max_attempts` could never finish — it would be filtered out by
     * `attempt_count < max_attempts` partway through and stall silently, which
     * is a worse failure than the one being fixed because the job looks
     * retryable while being unreachable.
     */
    const [first] = await claim(A);
    const jobId = first!.id;
    expect((await jobRow(jobId)).attempt_count).toBe(1);

    for (const next of HAPPY_PATH.slice(0, 5)) {
      await claim(A);
      await assessment.advanceStage(jobId, next, null);
    }

    expect((await jobRow(jobId)).attempt_count).toBe(1);
  });

  it('keeps the same worker as owner throughout', async () => {
    const [first] = await claim(A);
    const jobId = first!.id;
    for (const next of HAPPY_PATH.slice(0, 4)) {
      await claim(A);
      await assessment.advanceStage(jobId, next, null);
      expect((await jobRow(jobId)).claimed_by).toBe(A);
    }
  });

  it('clears ownership when it finally completes', async () => {
    const [first] = await claim(A);
    const jobId = first!.id;
    await assessment.advanceStage(jobId, 'completed', null);

    const done = await jobRow(jobId);
    expect(done.claimed_by).toBeNull();
    expect(done.lease_expires_at).toBeNull();
    // And it is not claimable again by anybody.
    expect(await claim(B)).toHaveLength(0);
  });

  it('clears ownership on every terminal stage, not just completion', async () => {
    for (const terminal of ['failed', 'manual_review', 'disqualified'] as const) {
      await db.query(`update assessment_jobs set stage = 'queued', claimed_by = null,
                        lease_expires_at = null, attempt_count = 0`);
      const [job] = await claim(A);
      await assessment.advanceStage(job!.id, terminal, null);
      const row = await jobRow(job!.id);
      expect(row.claimed_by, terminal).toBeNull();
      expect(row.lease_expires_at, terminal).toBeNull();
    }
  });
});

describe('another worker, while the lease is live', () => {
  it('cannot claim a job that is mid-flight', async () => {
    // The property the whole design rests on: continuing is something only the
    // owner may do. B's id can never satisfy `claimed_by = B` on A's job.
    const [mine] = await claim(A);
    await assessment.advanceStage(mine!.id, 'preflight', null);

    expect(await claim(B)).toHaveLength(0);
    expect((await jobRow(mine!.id)).claimed_by).toBe(A);
  });

  it('cannot claim it at any stage of the walk', async () => {
    const [mine] = await claim(A);
    const jobId = mine!.id;

    for (const next of HAPPY_PATH.slice(0, 6)) {
      await claim(A);
      await assessment.advanceStage(jobId, next, null);
      expect(await claim(B), `B claimed during ${next}`).toHaveLength(0);
    }
  });

  it('does not double-claim when both workers poll at once', async () => {
    /*
     * Ten interleaved claims against one job. Exactly one worker may hold it,
     * and re-claiming your own job must not hand it to the other — the outer
     * re-check after the row lock is what makes that true rather than likely.
     */
    const [mine] = await claim(A);
    const jobId = mine!.id;

    for (let i = 0; i < 10; i += 1) {
      const [a, b] = await Promise.all([claim(A), claim(B)]);
      const holders = [...a, ...b].filter((j) => j.id === jobId);
      expect(holders.length, `iteration ${i} produced ${holders.length} holders`).toBeLessThanOrEqual(1);
      expect((await jobRow(jobId)).claimed_by).toBe(A);
    }
  });

  it('gives each of two workers a different job, never the same one', async () => {
    // Four more jobs in the same cohort, so two workers polling together have
    // something to divide. SKIP LOCKED should hand them disjoint sets, and the
    // continuation clause must not turn that into an overlap.
    for (let i = 0; i < 4; i += 1) {
      // A team each: the schema allows one submission per team per cohort.
      const { rows: team } = await db.query<{ id: string }>(
        `insert into teams (cohort_id, group_number, lead_name, status)
         values ($1, $2, 'Lead', 'active') returning id`,
        [cohortId, 900 + i]);
      const { rows } = await db.query<{ id: string }>(
        `insert into submissions (cohort_id, team_id, status, product_url)
         values ($1, $2, 'submitted', 'https://example.invalid/p') returning id`,
        [cohortId, team[0]!.id]);
      await db.query(
        `insert into assessment_jobs (submission_id, cohort_id) values ($1, $2)`,
        [rows[0]!.id, cohortId]);
    }

    const [a, b] = await Promise.all([claim(A, 10), claim(B, 10)]);
    const ids = [...a.map((j) => j.id), ...b.map((j) => j.id)];
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('when a worker dies mid-stage', () => {
  it('leaves the lease in place, so nothing is stolen while it might still be alive', async () => {
    // Crash recovery is expiry-based on purpose. A worker that is merely slow —
    // inside an eight-minute browser run, say — must not have its job taken.
    const [mine] = await claim(A);
    await assessment.advanceStage(mine!.id, 'browser_testing', null);

    const row = await jobRow(mine!.id);
    expect(row.claimed_by).toBe(A);
    expect(row.lease_expires_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await claim(B)).toHaveLength(0);
  });

  it('lets another worker recover it once the lease expires', async () => {
    const [mine] = await claim(A);
    const jobId = mine!.id;
    await assessment.advanceStage(jobId, 'browser_testing', null);

    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );

    const [recovered] = await claim(B);
    expect(recovered?.id).toBe(jobId);
    expect((await jobRow(jobId)).claimed_by).toBe(B);
  });

  it('counts the recovery as a new attempt, and the continuation as none', async () => {
    /*
     * The two cases side by side, because the difference between them is the
     * whole of the change: resuming your own live lease is the same attempt,
     * taking over an expired one is a new attempt at a job that went wrong.
     */
    const [mine] = await claim(A);
    const jobId = mine!.id;
    expect((await jobRow(jobId)).attempt_count).toBe(1);

    await claim(A); // continuation
    expect((await jobRow(jobId)).attempt_count).toBe(1);

    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );
    await claim(B); // recovery
    expect((await jobRow(jobId)).attempt_count).toBe(2);
  });

  it('stops being claimable once it has used every attempt', async () => {
    const [mine] = await claim(A);
    const jobId = mine!.id;
    const { rows } = await db.query<{ max_attempts: number }>(
      `select max_attempts from assessment_jobs where id = $1`,
      [jobId],
    );
    await db.query(
      `update assessment_jobs set attempt_count = $2, claimed_by = null, lease_expires_at = null
        where id = $1`,
      [jobId, rows[0]!.max_attempts],
    );

    expect(await claim(A)).toHaveLength(0);
    expect(await claim(B)).toHaveLength(0);
  });
});

describe('evidence, across a stage transition', () => {
  it('accepts an upload authorised before the job stepped forward', async () => {
    /*
     * The interaction that made "just clear claimed_by after every stage" the
     * wrong fix.
     *
     * Evidence tickets are bound to an attempt. If advancing a stage counted as
     * a new attempt, a trace still uploading when the browser stage finished
     * would be refused at confirmation — evidence captured correctly and thrown
     * away by bookkeeping.
     */
    const [mine] = await claim(A);
    const jobId = mine!.id;
    await assessment.advanceStage(jobId, 'browser_testing', null);
    await claim(A);

    const run = await assessment.saveBrowserRun(
      {
        jobId, viewport: 'desktop', startedAt: new Date(), finishedAt: new Date(),
        durationMs: 10, status: 'passed', browserVersion: 'chromium-1.62.1', tracePath: null,
        consoleErrorCount: 0, networkFailureCount: 0, a11yViolationCount: 0, a11ySummary: {},
        cleanupStatus: 'complete', timedOut: false,
      },
      [],
    );

    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: A,
    });
    expect(ticket.ok).toBe(true);
    // The bytes land in the bucket, as a real upload would put them there.
    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, new Uint8Array([1, 2, 3]));

    // The job moves on while the bytes are still going up.
    await assessment.advanceStage(jobId, 'evidence_review', null);
    await claim(A);

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: A, attempt: ticket.attempt!, runId: run.id,
    });
    expect(confirmed.ok).toBe(true);
  });

  it('rejects an upload from an attempt another worker has superseded', async () => {
    const [mine] = await claim(A);
    const jobId = mine!.id;
    await assessment.advanceStage(jobId, 'browser_testing', null);

    const run = await assessment.saveBrowserRun(
      {
        jobId, viewport: 'desktop', startedAt: new Date(), finishedAt: new Date(),
        durationMs: 10, status: 'passed', browserVersion: 'chromium-1.62.1', tracePath: null,
        consoleErrorCount: 0, networkFailureCount: 0, a11yViolationCount: 0, a11ySummary: {},
        cleanupStatus: 'complete', timedOut: false,
      },
      [],
    );
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: A,
    });
    expect(ticket.ok).toBe(true);
    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, new Uint8Array([1, 2, 3]));

    // A dies; B recovers the job, which is a new attempt.
    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );
    await claim(B);

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: A, attempt: ticket.attempt!, runId: run.id,
    });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toMatch(/attempt/i);
  });

  it('refuses a new ticket to a worker that has lost the job', async () => {
    const [mine] = await claim(A);
    const jobId = mine!.id;
    await assessment.advanceStage(jobId, 'browser_testing', null);

    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );
    await claim(B);

    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'late.zip', workerId: A,
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.error).toMatch(/live lease/i);
  });
});
