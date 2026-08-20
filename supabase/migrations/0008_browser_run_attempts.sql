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
 * Existing rows predate the model, so they are numbered at or below zero.
 *
 * Not 1: guessing that old rows belong to the current attempt would make a
 * historical run look authoritative, which is the exact confusion this
 * migration exists to remove. A live `attempt_count` starts at 1, so nothing
 * already recorded can be read as current — and all of it stays visible to the
 * admin submission view, which has always queried these tables directly.
 *
 * Numbered rather than flattened to a single 0, because a job that was ever
 * re-run already holds more than one row per viewport. A blanket zero would
 * make those collide under the unique index below, and the migration would fail
 * on exactly the databases that have the most history. Found that way: this
 * refused to apply to production, where six job/viewport pairs held two runs
 * each from re-judged submissions.
 *
 * The newest historical run gets 0 and each older one counts downwards, so the
 * ordering still reads correctly and no row is deleted to make an index fit.
 */
with numbered as (
  select id,
         -(row_number() over (partition by job_id, viewport order by started_at desc) - 1) as attempt
    from browser_test_runs
)
update browser_test_runs r
   set attempt = numbered.attempt
  from numbered
 where numbered.id = r.id;

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
