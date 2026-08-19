-- ---------------------------------------------------------------------------
-- 0008 — say which attempt a browser run belongs to
-- ---------------------------------------------------------------------------
--
-- Scores and rubric evidence already behave like current-attempt state: both
-- stages clear their own rows and write them again, so a job judged twice ends
-- with one set. Browser runs did not. They were appended, so a re-judged
-- submission accumulated a desktop/mobile pair per attempt and
-- `listBrowserRuns` — which scoring reads — returned all of them.
--
-- That is worse than untidy. Scoring would have counted console errors and
-- failed steps from a run that no longer describes the product, and the
-- resulting mark would be defensible to nobody. It was found on a synthetic
-- cohort where three re-judged jobs held four runs each.
--
-- The fix is to record the attempt rather than to delete the history. A run
-- says which attempt produced it, scoring reads only the current one, and every
-- earlier run stays exactly where it is for anyone auditing how a score came
-- about.
--
-- What counts as an attempt is already decided by the queue: `attempt_count`
-- increments when a job is claimed fresh — unowned, or after its lease expired
-- — and does not move when the worker that owns a live lease continues it. So a
-- worker restarting mid-run resumes the same attempt and overwrites its own
-- partial results, while a re-queue or a takeover after a crash starts a new
-- one. Those are exactly the two cases that need telling apart.
-- ---------------------------------------------------------------------------

alter table browser_test_runs
  add column if not exists attempt integer not null default 1;

/*
 * Existing rows predate the model, so they are marked attempt 0.
 *
 * Not 1: guessing that old rows belong to the current attempt would make a
 * historical run look authoritative, which is the exact confusion this
 * migration exists to remove. Zero never equals a live `attempt_count`, which
 * starts at 1, so nothing already recorded is read as current — and all of it
 * remains visible to the admin submission view, which has always queried these
 * tables directly.
 */
update browser_test_runs set attempt = 0 where attempt = 1;

-- One run per viewport per attempt. This is what makes a restart within an
-- attempt an upsert rather than a duplicate: the second execution collides with
-- the first and replaces it.
create unique index if not exists browser_test_runs_job_attempt_viewport
  on browser_test_runs (job_id, attempt, viewport);

-- Scoring and the evidence lookup both filter on this.
create index if not exists browser_test_runs_job_attempt
  on browser_test_runs (job_id, attempt);

-- ---------------------------------------------------------------------------
-- Replacing a run's steps
-- ---------------------------------------------------------------------------
--
-- The run row is upserted, so its id survives a restart and its steps have to
-- be rewritten rather than added to. Same shape as `test_plan_steps` in 0006,
-- and the same reasoning: these are child rows of output the worker produced
-- itself, for the job it currently holds. DELETE stays absent from
-- `browser_test_runs`, so the worker still cannot remove the record of a run
-- having happened — only rewrite the steps inside the one it is running now.
grant delete on browser_test_steps to ohj_worker;
