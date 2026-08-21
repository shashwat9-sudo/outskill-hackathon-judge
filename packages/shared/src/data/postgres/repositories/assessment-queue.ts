/**
 * The assessment queue.
 *
 * Several workers pull from one table. The whole design rests on a single
 * property: **a job is claimed by exactly one worker**. Everything else here
 * follows from making that true even when workers crash, stall, or race.
 *
 * `SELECT ... FOR UPDATE SKIP LOCKED` is what provides it. Two workers issuing
 * the claim statement at the same instant do not see the same rows: the first
 * locks them, and the second skips past to the next unlocked ones rather than
 * blocking. Without `SKIP LOCKED` the second worker would wait for the first
 * transaction and then read rows it had already taken.
 *
 * A lease rather than a lock is what survives a crash. A worker that dies
 * holding a claim releases its database lock immediately, but the row still
 * says `claimed_by = 'worker-3'`, so nothing else would ever take it. The
 * lease expiry is the reason a dead worker's jobs come back — `heartbeat`
 * extends it while the worker is alive, and `reclaimExpiredLeases` returns
 * anything whose worker stopped saying so.
 */

import type { AssessmentJob } from '../../types';
import type { AssessmentStage } from '../../../domain/status';
import type { AssessmentStore } from '../../store';
import { RowNotFoundError, type SqlClient, type SqlDatabase } from '../client';
import { mapRow, toDate, toNumber } from '../rows';

/** Stages a job can be claimed out of. `completed`, `failed` and the review states are terminal. */
const CLAIMABLE_STAGES = [
  'queued',
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
] as const;

/** Stages that mean the job is finished, whatever the outcome. */
const TERMINAL_STAGES: AssessmentStage[] = [
  'completed',
  'failed',
  'manual_review',
  'disqualified',
];

const ALL_STAGES: AssessmentStage[] = [...CLAIMABLE_STAGES, ...TERMINAL_STAGES];

export type QueueMethods = Pick<
  AssessmentStore,
  | 'enqueueCohort'
  | 'enqueueSubmission'
  | 'getJob'
  | 'getJobBySubmission'
  | 'listJobs'
  | 'claimJobs'
  | 'heartbeat'
  | 'advanceStage'
  | 'releaseJob'
  | 'reclaimExpiredLeases'
  | 'getQueueStats'
>;

export function buildQueueMethods(db: SqlDatabase): QueueMethods {
  return {
    /**
     * Queue every final submission in a cohort.
     *
     * Idempotent by way of `on conflict (submission_id) do nothing` — the
     * column is unique, so a second run cannot create a second job even if two
     * operators press the button at the same moment. The count of skipped rows
     * is the difference between what was eligible and what was inserted, which
     * is also the honest answer to "did I just double-queue everything?".
     *
     * Drafts are excluded. A draft is work in progress; assessing it would
     * judge a team on something they had not finished.
     */
    async enqueueCohort(cohortId) {
      const { rows } = await db.query<{ id: string }>(
        `insert into assessment_jobs (submission_id, cohort_id)
         select s.id, s.cohort_id
           from submissions s
          where s.cohort_id = $1
            and s.status in ('submitted', 'locked')
         on conflict (submission_id) do nothing
         returning id`,
        [cohortId],
      );

      const eligible = await db.query<{ count: unknown }>(
        `select count(*) as count from submissions
          where cohort_id = $1 and status in ('submitted', 'locked')`,
        [cohortId],
      );

      const total = toNumber(eligible.rows[0]?.count);
      return { queued: rows.length, skipped: total - rows.length };
    },

    /**
     * Queue one submission — or send an existing job round again.
     *
     * This is the re-judge. It is reached from one place, the admin's "Retry
     * failed assessment", and it used to do nothing at all: the conflict clause
     * assigned `updated_at` to itself, purely so `returning` would produce a
     * row. A job sitting in `failed` stayed in `failed`, which is terminal, so
     * the worker never looked at it again and the button reported success
     * having changed nothing. The memory driver did reset the job, so this
     * diverged silently — demo mode worked, production did not.
     *
     * `attempt_count` is deliberately kept. It is the audit trail: preflight
     * checks and browser runs are both stamped with the attempt that produced
     * them, so the next run appends to that history rather than overwriting it.
     * What is refreshed is the allowance — an admin pressing re-judge is a new
     * decision to try, and a job that had exhausted its automatic retries must
     * not silently refuse one.
     */
    async enqueueSubmission(submissionId) {
      const { rows } = await db.query(
        `insert into assessment_jobs (submission_id, cohort_id)
         select s.id, s.cohort_id from submissions s where s.id = $1
         on conflict (submission_id) do update
            set stage = 'queued',
                claimed_by = null,
                claimed_at = null,
                lease_expires_at = null,
                heartbeat_at = null,
                next_attempt_at = null,
                last_error = null,
                completed_at = null,
                max_attempts = greatest(
                  assessment_jobs.max_attempts,
                  assessment_jobs.attempt_count + 3
                ),
                updated_at = now()
         returning *`,
        [submissionId],
      );
      const row = rows[0];
      if (!row) throw new RowNotFoundError('submission', submissionId);
      return mapJob(row);
    },

    async getJob(jobId) {
      const { rows } = await db.query('select * from assessment_jobs where id = $1', [jobId]);
      return rows[0] ? mapJob(rows[0]) : null;
    },

    async getJobBySubmission(submissionId) {
      const { rows } = await db.query('select * from assessment_jobs where submission_id = $1', [
        submissionId,
      ]);
      return rows[0] ? mapJob(rows[0]) : null;
    },

    async listJobs(cohortId, filter) {
      const { rows } = await db.query(
        `select * from assessment_jobs
          where cohort_id = $1
            and ($2::assessment_stage is null or stage = $2::assessment_stage)
          order by priority desc, created_at`,
        [cohortId, filter?.stage ?? null],
      );
      return rows.map(mapJob);
    },

    /**
     * Claim up to `limit` jobs for one worker.
     *
     * The `SKIP LOCKED` subquery is the whole mechanism. Two workers running
     * this statement concurrently take disjoint sets of rows: whichever
     * transaction locks a row first owns it, and the other one steps over it
     * instead of waiting. `for update` alone would serialise the workers and —
     * worse — the second would then re-read rows the first had just claimed,
     * because its snapshot was taken before the first committed.
     *
     * The lease is set here rather than by the worker, so a worker cannot grant
     * itself an unbounded one.
     *
     * A worker may also re-claim a job it already holds, and this is not a
     * detail — it is what lets a job move.
     *
     * The loop runs one stage per claim and `advanceStage` deliberately keeps
     * ownership between stages, so that nobody else picks up a job that is
     * halfway through. Without the clause below, the owning worker could not
     * see its own job either: the predicate excluded everything with a live
     * lease, so a job advanced one stage and then sat until the lease expired.
     * At the default 900s that is one stage every fifteen minutes — around two
     * hours per submission, which for a 500-submission cohort is not a slow
     * system but a stalled one.
     *
     * Continuing is not a new attempt, so `attempt_count` does not move. That
     * matters in three places: the claim filter would otherwise exhaust
     * `max_attempts` after a few stages and strand a healthy job; the retry
     * backoff would count stages as failures; and evidence upload tickets are
     * bound to an attempt, so an in-flight upload would be refused the moment
     * its job stepped forward. Only a genuinely fresh claim — unowned, or a
     * lease that has expired — counts as an attempt.
     */
    async claimJobs(input) {
      const leaseSeconds = Math.max(1, Math.floor(input.leaseSeconds));
      const limit = Math.max(0, Math.floor(input.limit));
      if (limit === 0) return [];

      const { rows } = await db.query(
        `update assessment_jobs j
            set claimed_by = $1,
                claimed_at = now(),
                lease_expires_at = now() + make_interval(secs => $2::double precision),
                heartbeat_at = now(),
                started_at = coalesce(j.started_at, now()),
                -- Zero when this worker is continuing a job it already owns.
                -- The j alias is the pre-update row, so this reads the state
                -- that decided whether the row was claimable in the first place.
                attempt_count = j.attempt_count + (
                  case when j.claimed_by = $1 and j.lease_expires_at > now() then 0 else 1 end
                ),
                updated_at = now()
          where j.id in (
            select c.id
              from assessment_jobs c
             -- text[] then cast, rather than a direct enum[] parameter: the
             -- WASM engine the tests run on cannot serialise a JS array into an
             -- enum array, and this form is identical to Postgres. Verified to
             -- still use assessment_jobs_claim via an index scan.
             where c.stage = any($3::text[]::assessment_stage[])
               and (
                 c.claimed_by is null
                 or c.lease_expires_at < now()
                 -- Mine already, and still live: continue it.
                 or (c.claimed_by = $1 and c.lease_expires_at > now())
               )
               and (c.next_attempt_at is null or c.next_attempt_at <= now())
               and c.attempt_count < c.max_attempts
             -- Finish what this worker started before taking anything new.
             -- Otherwise a worker at concurrency 1 could pick up a fresh job
             -- and leave its own half-done one leased and idle until expiry —
             -- the same stall, arrived at differently.
             order by (case when c.claimed_by = $1 then 0 else 1 end),
                      c.priority desc, c.next_attempt_at nulls first, c.created_at
             limit $4
             for update skip locked
          )
          -- Re-checked here, after the row lock is held.
          --
          -- SKIP LOCKED is what keeps two workers from queueing behind each
          -- other, but on its own it is a throughput device, not the safety
          -- property. Under READ COMMITTED the outer UPDATE re-evaluates this
          -- predicate once it holds the lock, so even if two transactions
          -- somehow selected the same row, the second sees claimed_by already
          -- set and updates nothing. The invariant then holds without depending
          -- on the subquery locking behaviour alone.
          -- The continuation case is re-checked too: another worker cannot
          -- satisfy claimed_by = its own id, so this stays a statement about
          -- one worker resuming its own work.
          and (
            j.claimed_by is null
            or j.lease_expires_at < now()
            or (j.claimed_by = $1 and j.lease_expires_at > now())
          )
        returning j.*`,
        [input.workerId, leaseSeconds, [...CLAIMABLE_STAGES], limit],
      );

      return rows.map(mapJob);
    },

    /**
     * Extend a lease.
     *
     * Scoped to the claiming worker. A worker whose lease already expired and
     * was reclaimed by another must not be able to extend it back — by then the
     * job belongs to someone else, and two workers processing one submission is
     * exactly what the lease exists to prevent. The no-op is silent because the
     * worker's correct response is to notice at its next claim, not to crash.
     */
    async heartbeat(jobId, workerId) {
      await db.query(
        `update assessment_jobs
            set heartbeat_at = now(),
                lease_expires_at = greatest(
                  lease_expires_at,
                  now() + (lease_expires_at - claimed_at)
                ),
                updated_at = now()
          where id = $1 and claimed_by = $2 and lease_expires_at > now()`,
        [jobId, workerId],
      );
    },

    /**
     * Move a job to its next stage.
     *
     * Reaching a terminal stage releases the claim: the job is finished, and a
     * `claimed_by` left behind would make it look like a worker was still
     * holding something. `completed_at` is stamped only for stages that mean
     * the pipeline actually ran to an end.
     */
    async advanceStage(jobId, stage, error) {
      const terminal = TERMINAL_STAGES.includes(stage);
      const { rows } = await db.query(
        `update assessment_jobs
            set stage = $2::assessment_stage,
                last_error = $3,
                completed_at = case when $4 then now() else completed_at end,
                claimed_by = case when $4 then null else claimed_by end,
                lease_expires_at = case when $4 then null else lease_expires_at end,
                updated_at = now()
          where id = $1
        returning *`,
        [jobId, stage, error ?? null, terminal],
      );
      const row = rows[0];
      if (!row) throw new RowNotFoundError('assessment job', jobId);
      return mapJob(row);
    },

    /**
     * Hand a job back, either for a retry or as a failure.
     *
     * A job that has used its last attempt goes to `failed` rather than being
     * released for a retry that would never be claimed — the claim query filters
     * on `attempt_count < max_attempts`, so releasing it would leave a job that
     * looks retryable in the admin view and is silently stuck.
     *
     * `failed` is not a verdict on the submission. It means the system could not
     * assess it, which is the system's problem to explain, not the team's to
     * absorb.
     */
    async releaseJob(jobId, options) {
      const current = await db.query('select * from assessment_jobs where id = $1', [jobId]);
      const existing = current.rows[0];
      if (!existing) throw new RowNotFoundError('assessment job', jobId);

      const job = mapJob(existing);
      const exhausted = job.attemptCount >= job.maxAttempts;
      const retryInMs = Math.max(0, options.retryInMs ?? 0);

      const { rows } = await db.query(
        `update assessment_jobs
            set claimed_by = null,
                lease_expires_at = null,
                heartbeat_at = null,
                last_error = $2,
                stage = case when $3 then 'failed'::assessment_stage else stage end,
                completed_at = case when $3 then now() else completed_at end,
                next_attempt_at = case
                  when $3 then null
                  else now() + make_interval(secs => $4::double precision)
                end,
                updated_at = now()
          where id = $1
        returning *`,
        [jobId, options.error ?? null, exhausted, retryInMs / 1000],
      );
      return mapJob(rows[0]!);
    },

    /**
     * Return jobs whose worker stopped reporting.
     *
     * The claim query already ignores an expired lease, so this is not what
     * makes those jobs claimable again — it is what makes the queue *legible*.
     * A row still naming a worker that died an hour ago tells an operator that
     * something is running when nothing is.
     */
    async reclaimExpiredLeases() {
      const { rowCount } = await db.query(
        `update assessment_jobs
            set claimed_by = null,
                lease_expires_at = null,
                heartbeat_at = null,
                last_error = coalesce(last_error, 'Worker lease expired before the job finished.'),
                updated_at = now()
          where claimed_by is not null
            and lease_expires_at is not null
            and lease_expires_at < now()`,
      );
      return rowCount;
    },

    /**
     * What the operator sees on the progress screen.
     *
     * Every figure comes from one statement, so the parts cannot disagree —
     * counting stages and then counting completions separately would let the
     * two reads straddle a commit and produce a total that does not add up.
     *
     * The ETA is deliberately null until something has actually completed. A
     * projection from zero samples is a guess presented as a measurement, and
     * an operator deciding whether to extend a deadline is entitled to know the
     * difference.
     */
    async getQueueStats(cohortId) {
      const { rows } = await db.query<Record<string, unknown>>(
        `select
            count(*) as total,
            count(*) filter (where j.stage = 'completed') as completed,
            count(*) filter (where j.claimed_by is not null and j.lease_expires_at > now()) as running,
            count(*) filter (where j.stage = 'failed') as failed,
            count(*) filter (where j.stage = 'manual_review') as manual_review,
            avg(extract(epoch from (j.completed_at - j.started_at)) * 1000)
              filter (where j.stage = 'completed' and j.started_at is not null) as avg_ms,
            coalesce(sum(r.duration_ms), 0) as browser_ms,
            (select count(*) from artifact_analyses a
               join assessment_jobs aj on aj.id = a.job_id where aj.cohort_id = $1)
            + (select count(*) from test_plans t
               join assessment_jobs tj on tj.id = t.job_id where tj.cohort_id = $1)
            + (select count(*) from assessment_summaries s
               join assessment_jobs sj on sj.id = s.job_id where sj.cohort_id = $1) as ai_calls
           from assessment_jobs j
           left join browser_test_runs r on r.job_id = j.id
          where j.cohort_id = $1`,
        [cohortId],
      );

      const stageRows = await db.query<{ stage: string; count: unknown }>(
        'select stage, count(*) as count from assessment_jobs where cohort_id = $1 group by stage',
        [cohortId],
      );

      const row = rows[0] ?? {};
      const byStage = Object.fromEntries(ALL_STAGES.map((s) => [s, 0])) as Record<
        AssessmentStage,
        number
      >;
      for (const r of stageRows.rows) {
        byStage[r.stage as AssessmentStage] = toNumber(r.count);
      }

      const total = toNumber(row.total);
      const completed = toNumber(row.completed);
      const failed = toNumber(row.failed);
      const manualReview = toNumber(row.manual_review);
      const averageDurationMs = row.avg_ms === null ? null : toNumber(row.avg_ms);

      // Anything not finished still has to run. `running` is a subset of these,
      // not an addition to them.
      const outstanding = total - completed - failed - manualReview;

      return {
        total,
        byStage,
        completed,
        running: toNumber(row.running),
        failed,
        manualReview,
        averageDurationMs,
        projectedCompletionAt:
          averageDurationMs === null || outstanding <= 0
            ? null
            : new Date(Date.now() + outstanding * averageDurationMs),
        browserMinutesUsed: Math.round(toNumber(row.browser_ms) / 60_000),
        aiCallCount: toNumber(row.ai_calls),
        // Not measured yet: the AI provider is not wired. Reporting a plausible
        // number here would be a fabricated cost figure on a budget screen.
        estimatedTokensUsed: 0,
      };
    },
  };
}

// --------------------------------------------------------------------------

export function mapJob(row: Record<string, unknown>): AssessmentJob {
  const job = mapRow<AssessmentJob>(row);
  return {
    ...job,
    priority: toNumber(row.priority),
    attemptCount: toNumber(row.attempt_count),
    maxAttempts: toNumber(row.max_attempts),
    claimedAt: toDate(row.claimed_at),
    leaseExpiresAt: toDate(row.lease_expires_at),
    heartbeatAt: toDate(row.heartbeat_at),
    startedAt: toDate(row.started_at),
    completedAt: toDate(row.completed_at),
    nextAttemptAt: toDate(row.next_attempt_at),
  };
}

/** Shared by the other assessment repositories, which all need a job to exist. */
export async function requireJob(tx: SqlClient, jobId: string): Promise<AssessmentJob> {
  const { rows } = await tx.query('select * from assessment_jobs where id = $1', [jobId]);
  const row = rows[0];
  if (!row) throw new RowNotFoundError('assessment job', jobId);
  return mapJob(row);
}


