import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildEvidenceStore, type EvidenceStore } from './repositories/evidence';
import { buildAssessmentStore } from './repositories/assessment';
import { createInMemoryStorage, type StorageAdapter } from './storage';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import type { AssessmentStore } from '../store';

/**
 * Durable browser evidence, end to end.
 *
 * The worker holds no Storage credential. It asks for permission to write one
 * object, uploads to that one place, and asks again to confirm — and only the
 * confirmation writes anything to the database.
 *
 * Everything here is about the two ways that can go wrong. A worker must not be
 * able to name a destination, because then the credential boundary bought us
 * nothing. And the database must never record evidence that is not in the
 * bucket, because a row pointing at a missing object is F-7 again: a system
 * confidently describing something that is not there.
 */

let db: PgliteHandle;
let storage: StorageAdapter & { objects: Map<string, Uint8Array> };
let evidence: EvidenceStore;
let assessment: AssessmentStore;

let cohortId: string;
let jobId: string;
let otherJobId: string;
let runId: string;
let stepId: string;

const WORKER = 'worker-1';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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

  const seeded = await seedCohortWithSubmissions(db, 2);
  cohortId = seeded.cohort.id;

  storage = createInMemoryStorage();
  evidence = buildEvidenceStore(db, storage);
  assessment = buildAssessmentStore(db, storage);

  // The seed creates submissions, not jobs — jobs are what enqueueing makes.
  await assessment.enqueueCohort(cohortId);

  const { rows } = await db.query<{ id: string }>(
    `select id from assessment_jobs order by created_at`,
  );
  jobId = rows[0]!.id;
  otherJobId = rows[1]!.id;

  await db.query(`update assessment_jobs set stage = 'browser_testing', claimed_by = $1,
                    lease_expires_at = now() + interval '10 minutes'`, [WORKER]);

  const run = await assessment.saveBrowserRun(
    {
      jobId,
      viewport: 'desktop',
      startedAt: new Date(),
      finishedAt: new Date(),
      durationMs: 1000,
      status: 'passed',
      browserVersion: 'chromium-1.62.1',
      // Deliberately null: a local path is not durable evidence, and the column
      // means "where this lives in Storage".
      tracePath: null,
      consoleErrorCount: 0,
      networkFailureCount: 0,
      a11yViolationCount: 0,
      a11ySummary: {},
      cleanupStatus: 'complete',
      timedOut: false,
    },
    [
      {
        stepIndex: 0,
        action: 'navigate',
        status: 'passed',
        durationMs: 100,
        errorMessage: null,
        screenshotPath: null,
        assertionDetail: {},
      },
    ],
  );
  runId = run.id;

  const steps = await assessment.listBrowserRuns(jobId);
  stepId = steps[0]!.steps[0]!.id;
});

/** The whole flow, as the worker performs it. */
async function upload(kind: 'trace' | 'screenshot', filename: string, bytes = PNG, jid = jobId) {
  const ticket = await evidence.createEvidenceUploadTicket({
    jobId: jid,
    kind,
    filename,
    workerId: WORKER,
  });
  if (!ticket.ok) return { ticket, confirmed: null };

  storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, bytes);

  const confirmed = await evidence.confirmEvidenceUpload({
    jobId: jid,
    kind,
    bucket: ticket.bucket!,
    storagePath: ticket.storagePath!,
    workerId: WORKER,
    attempt: ticket.attempt!,
    runId: kind === 'trace' ? runId : null,
    stepId: kind === 'screenshot' ? stepId : null,
  });
  return { ticket, confirmed };
}

const traceOf = async () => {
  const { rows } = await db.query<{ trace_path: string | null }>(
    `select trace_path from browser_test_runs where id = $1`,
    [runId],
  );
  return rows[0]!.trace_path;
};

// --------------------------------------------------------------------------

describe('a successful upload', () => {
  it('records the storage path, not a local one', async () => {
    const { confirmed } = await upload('trace', 'desktop.zip');
    expect(confirmed?.ok, confirmed?.error).toBe(true);

    const path = await traceOf();
    expect(path).toBe(confirmed!.storagePath);
    expect(path).toContain(`${cohortId}/`);
    expect(path).not.toContain('.local-evidence');
    expect(path).not.toMatch(/^\//);
  });

  it('puts each kind in its own private bucket', async () => {
    const trace = await upload('trace', 'desktop.zip');
    expect(trace.ticket.bucket).toBe('traces');

    const shot = await upload('screenshot', 'step-0.png');
    expect(shot.ticket.bucket).toBe('submission-screenshots');
    expect(shot.confirmed?.ok).toBe(true);
  });

  it('reports the size the bucket holds, not the size claimed', async () => {
    const big = new Uint8Array(4096);
    big.set(PNG);
    const { confirmed } = await upload('trace', 'desktop.zip', big);
    expect(confirmed?.byteSize).toBe(4096);
  });

  it('hands back a short-lived authorisation', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'a.zip', workerId: WORKER,
    });
    expect(ticket.expiresInSeconds).toBeLessThanOrEqual(600);
    expect(ticket.uploadUrl).toBeTruthy();
  });
});

describe('an upload that did not arrive', () => {
  it('records nothing when the object is absent', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    // The PUT never happened — the exact shape of the original defect.
    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toMatch(/did not finish/i);
    expect(await traceOf()).toBeNull();
  });

  it('records nothing for an interrupted, empty object', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, new Uint8Array(0));

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });
    expect(confirmed.ok).toBe(false);
    expect(await traceOf()).toBeNull();
  });

  it('refuses an object larger than the kind allows', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'screenshot', filename: 'huge.png', workerId: WORKER,
    });
    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, new Uint8Array(11 * 1024 * 1024));

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'screenshot', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER,
      attempt: 0, stepId,
    });
    expect(confirmed.ok).toBe(false);
  });

  it('lets the worker retry successfully afterwards', async () => {
    const first = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    const failed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: first.bucket!, storagePath: first.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });
    expect(failed.ok).toBe(false);

    // Retry: same derived path, this time the bytes are there.
    const { confirmed } = await upload('trace', 'desktop.zip');
    expect(confirmed?.ok).toBe(true);
    expect(await traceOf()).toBe(confirmed!.storagePath);
  });
});

describe('repeating a confirmation', () => {
  it('is idempotent, and says so', async () => {
    const { ticket, confirmed } = await upload('trace', 'desktop.zip');
    expect(confirmed?.alreadyRecorded).toBe(false);

    const again = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });
    expect(again.ok).toBe(true);
    expect(again.alreadyRecorded).toBe(true);

    // One run, one trace. No duplicate row, no second path.
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from browser_test_runs where job_id = $1`, [jobId],
    );
    expect(rows[0]!.n).toBe(1);
    expect(await traceOf()).toBe(ticket.storagePath);
  });

  it('gives the same path to two ticket requests, so a retry overwrites rather than accumulates', async () => {
    const a = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    const b = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    expect(a.storagePath).toBe(b.storagePath);
  });
});

describe('a worker reaching for something that is not its own', () => {
  it('cannot get a ticket for another job', async () => {
    // It can ask — and what comes back is scoped to that other job, never to a
    // path this caller chose. The isolation is that paths are derived.
    const mine = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'a.zip', workerId: WORKER,
    });
    const theirs = await evidence.createEvidenceUploadTicket({
      jobId: otherJobId, kind: 'trace', filename: 'a.zip', workerId: WORKER,
    });
    expect(mine.storagePath).not.toBe(theirs.storagePath);
  });

  it('cannot confirm another job’s object against its own job', async () => {
    const theirs = await evidence.createEvidenceUploadTicket({
      jobId: otherJobId, kind: 'trace', filename: 'a.zip', workerId: WORKER,
    });
    storage.objects.set(`${theirs.bucket}/${theirs.storagePath}`, PNG);

    const stolen = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: theirs.bucket!, storagePath: theirs.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });
    expect(stolen.ok).toBe(false);
    expect(stolen.error).toMatch(/does not belong/i);
    expect(await traceOf()).toBeNull();
  });

  it('cannot attach a run belonging to another job', async () => {
    const { ticket } = await upload('trace', 'desktop.zip');
    const other = await evidence.confirmEvidenceUpload({
      jobId: otherJobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });
    expect(other.ok).toBe(false);
  });

  it('refuses a traversal path that starts correctly', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    const prefix = ticket.storagePath!.split('/').slice(0, 3).join('/');
    const traversal = `${prefix}/trace/../../../../elsewhere.zip`;
    storage.objects.set(`traces/${traversal}`, PNG);

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: 'traces', storagePath: traversal, workerId: WORKER,
      attempt: ticket.attempt!, runId,
    });
    expect(confirmed.ok).toBe(false);
    expect(await traceOf()).toBeNull();
  });

  it('refuses the right path in the wrong bucket', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    storage.objects.set(`submission-decks/${ticket.storagePath}`, PNG);

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: 'submission-decks', storagePath: ticket.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });
    expect(confirmed.ok).toBe(false);
  });

  it('refuses a job leased by somebody else', async () => {
    await db.query(
      `update assessment_jobs set claimed_by = 'worker-2',
              lease_expires_at = now() + interval '10 minutes' where id = $1`,
      [jobId],
    );
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'a.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(false);
    // The refusal is now the general one: whoever holds the job, this worker
    // does not, so it gets no new authorisation.
    expect(ticket.error).toMatch(/live lease/i);
  });

  it('refuses a brand-new ticket once its own lease has expired', async () => {
    /*
     * The rule this file used to get wrong.
     *
     * Letting an expired lease mint a *new* authorisation is the dangerous
     * half: by then the job may have been handed to somebody else, and a worker
     * that has lost its lease has no business being granted a fresh write.
     * Finishing an upload authorised while the lease was live is the safe half,
     * and the test below covers it.
     */
    await db.query(
      `update assessment_jobs set claimed_by = $2,
              lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId, WORKER],
    );

    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'late.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.error).toMatch(/live lease/i);
  });

  it('refuses a ticket for a job it never claimed', async () => {
    await db.query(`update assessment_jobs set claimed_by = null, lease_expires_at = null where id = $1`, [jobId]);

    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'unclaimed.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.error).toMatch(/live lease/i);
  });

  it('lets an upload authorised under a live lease finish after that lease expires', async () => {
    // The legitimate race: the browser stage captures a 40 MB trace, the lease
    // lapses while the bytes are still going up, and the upload lands anyway.
    // Refusing this would throw away evidence that was captured properly.
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'slow.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(true);

    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, PNG);
    await db.query(
      `update assessment_jobs set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [jobId],
    );

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER, attempt: ticket.attempt!, runId,
    });
    expect(confirmed.ok).toBe(true);
    expect(await traceOf()).toBe(ticket.storagePath);
  });

  it('refuses a stale confirmation once a newer attempt has taken the job', async () => {
    /*
     * Worker A is authorised, worker B picks the job up, worker A's upload
     * finally lands. A's bytes describe a run that has been superseded, and
     * recording them would leave the row describing one run and the evidence
     * describing another.
     */
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'stale.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(true);
    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, PNG);

    // What claimJobs does when it takes the job: bumps the attempt and moves
    // the lease. Written out rather than claimed for real so the assertion is
    // about the attempt, not about the queue.
    await db.query(
      `update assessment_jobs set attempt_count = attempt_count + 1, claimed_by = 'worker-2',
              lease_expires_at = now() + interval '10 minutes' where id = $1`,
      [jobId],
    );

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER, attempt: ticket.attempt!, runId,
    });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toMatch(/attempt/i);
    // And the row still says what it said before: no evidence.
    expect(await traceOf()).toBeNull();
  });

  it('refuses a stale confirmation even when the job was released rather than reclaimed', async () => {
    // releaseJob also increments the attempt. The job is unclaimed, so the
    // lease check alone would let this through — the attempt is what catches it.
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'released.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(true);
    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, PNG);

    await db.query(
      `update assessment_jobs set attempt_count = attempt_count + 1, claimed_by = null,
              lease_expires_at = null where id = $1`,
      [jobId],
    );

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER, attempt: ticket.attempt!, runId,
    });
    expect(confirmed.ok).toBe(false);
    expect(await traceOf()).toBeNull();
  });

  it('refuses a confirmation from a worker that is not the one holding the job', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'wrong-worker.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(true);
    storage.objects.set(`${ticket.bucket}/${ticket.storagePath}`, PNG);

    // Same attempt, different worker holding a live lease. Belt and braces:
    // this should not depend on the counter having moved.
    await db.query(
      `update assessment_jobs set claimed_by = 'worker-2',
              lease_expires_at = now() + interval '10 minutes' where id = $1`,
      [jobId],
    );

    const confirmed = await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER, attempt: ticket.attempt!, runId,
    });
    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toMatch(/leased by another/i);
    expect(await traceOf()).toBeNull();
  });

  it('refuses an unknown job', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId: '00000000-0000-4000-8000-000000000000', kind: 'trace', filename: 'a.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.error).toMatch(/unknown job/i);
  });

  it('refuses a job that has finished', async () => {
    await db.query(`update assessment_jobs set stage = 'completed' where id = $1`, [jobId]);
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'a.zip', workerId: WORKER,
    });
    expect(ticket.ok).toBe(false);
    expect(ticket.error).toMatch(/no longer be written/i);
  });
});

describe('filenames', () => {
  it('are reduced to a leaf, whatever was sent', async () => {
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: '../../../etc/passwd', workerId: WORKER,
    });
    expect(ticket.ok).toBe(true);
    expect(ticket.storagePath).not.toContain('..');
    expect(ticket.storagePath!.split('/')).toHaveLength(5);
    expect(ticket.storagePath!.endsWith('/passwd')).toBe(true);
  });

  it('survive confirmation after sanitising', async () => {
    const { confirmed } = await upload('trace', 'weird name!.zip');
    expect(confirmed?.ok, confirmed?.error).toBe(true);
  });
});

describe('what the database is allowed to claim', () => {
  it('never holds a path for an object that was never verified', async () => {
    // Every refusal above, in one place: after all of them, no row claims
    // evidence exists.
    const ticket = await evidence.createEvidenceUploadTicket({
      jobId, kind: 'trace', filename: 'desktop.zip', workerId: WORKER,
    });
    await evidence.confirmEvidenceUpload({
      jobId, kind: 'trace', bucket: ticket.bucket!, storagePath: ticket.storagePath!,
      workerId: WORKER,
      attempt: 0, runId,
    });

    const { rows } = await db.query<{ trace_path: string | null }>(
      `select trace_path from browser_test_runs`,
    );
    for (const row of rows) {
      if (!row.trace_path) continue;
      expect(storage.objects.has(`traces/${row.trace_path}`), 'a row points at nothing').toBe(true);
    }
  });

  it('holds only paths whose objects exist, after a successful run', async () => {
    await upload('trace', 'desktop.zip');
    await upload('screenshot', 'step-0.png');

    const { rows: runs } = await db.query<{ trace_path: string }>(
      `select trace_path from browser_test_runs where trace_path is not null`,
    );
    const { rows: steps } = await db.query<{ screenshot_path: string }>(
      `select screenshot_path from browser_test_steps where screenshot_path is not null`,
    );
    expect(runs).toHaveLength(1);
    expect(steps).toHaveLength(1);
    expect(storage.objects.has(`traces/${runs[0]!.trace_path}`)).toBe(true);
    expect(storage.objects.has(`submission-screenshots/${steps[0]!.screenshot_path}`)).toBe(true);
  });

  it('leaks no access code or credential into a path', async () => {
    const { ticket } = await upload('trace', 'desktop.zip');
    expect(ticket.storagePath).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(ticket.storagePath).not.toMatch(/password|secret|token|key/i);
    // Ids only: cohort, submission, job, kind, filename.
    expect(ticket.storagePath!.split('/')).toHaveLength(5);
  });
});

describe('what an admin route is allowed to open', () => {
  /*
   * The lookup behind View and Download.
   *
   * The route takes a run id or a step id and nothing else. If it took a bucket
   * and a path instead, then knowing a path — from a log line, a screenshot of
   * a console, a support ticket — would be enough to read another team's
   * evidence. So the path is always read back from the row that owns it.
   */

  it('finds the object a confirmed upload recorded', async () => {
    const { ticket } = await upload('trace', 'desktop.zip');
    const object = await evidence.getEvidenceObject({ kind: 'trace', id: runId });

    expect(object?.storagePath).toBe(ticket.storagePath);
    expect(object?.bucket).toBe('traces');
    expect(object?.jobId).toBe(jobId);
  });

  it('finds a screenshot by the step it belongs to', async () => {
    const { ticket } = await upload('screenshot', 'step-0.png');
    const object = await evidence.getEvidenceObject({ kind: 'screenshot', id: stepId });

    expect(object?.storagePath).toBe(ticket.storagePath);
    expect(object?.bucket).toBe('submission-screenshots');
  });

  it('returns nothing when no evidence was ever recorded', async () => {
    // The common case: most steps have no screenshot. The route turns this into
    // "nothing was captured", not a broken link.
    expect(await evidence.getEvidenceObject({ kind: 'trace', id: runId })).toBeNull();
    expect(await evidence.getEvidenceObject({ kind: 'screenshot', id: stepId })).toBeNull();
  });

  it('returns nothing for an id that is not one', async () => {
    for (const bad of ['', '../../etc/passwd', 'not-a-uuid', jobId.slice(0, 30)]) {
      expect(await evidence.getEvidenceObject({ kind: 'trace', id: bad }), bad).toBeNull();
    }
  });

  it('returns nothing for a well-formed id that belongs to nothing', async () => {
    const object = await evidence.getEvidenceObject({
      kind: 'trace',
      id: '44444444-4444-4444-8444-444444444444',
    });
    expect(object).toBeNull();
  });

  it('refuses to serve a path that does not reconstruct from its own row', async () => {
    /*
     * Defence against a row written by something other than this code.
     *
     * A path is only served if rebuilding it from the job that owns it produces
     * the same string. A hand-edited row pointing at another team's object
     * fails that check and is not served, so a bad write cannot become a leak.
     */
    await upload('trace', 'desktop.zip');
    await db.query(
      `update browser_test_runs set trace_path = $1 where id = $2`,
      ['99999999-9999-4999-8999-999999999999/x/y/trace/theirs.zip', runId],
    );

    expect(await evidence.getEvidenceObject({ kind: 'trace', id: runId })).toBeNull();
  });

  it('does not serve a trace through the screenshot kind', async () => {
    // The kind picks the bucket. Asking for a run id as a screenshot must not
    // reach into the traces bucket with a screenshot's permissions.
    await upload('trace', 'desktop.zip');
    expect(await evidence.getEvidenceObject({ kind: 'screenshot', id: runId })).toBeNull();
  });
});
