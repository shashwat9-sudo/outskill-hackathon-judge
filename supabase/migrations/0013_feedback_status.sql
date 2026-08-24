-- ---------------------------------------------------------------------------
-- 0013 — say whether a feedback report was produced
-- ---------------------------------------------------------------------------
--
-- 43 of 69 completed submissions had no participant feedback report, and
-- nothing anywhere recorded that. The stage generated one, the safety check
-- rejected it, and the code returned — leaving a job marked `completed` with a
-- missing artefact and a warning line in a log nobody was reading.
--
-- The absence itself was the only evidence, and absence is ambiguous: not yet
-- attempted, refused, and failed all look identical from the database. So the
-- admin page could say nothing more useful than "no feedback report generated
-- yet", which was true of every one of those states.
--
-- Judging and feedback are separate concerns and are now separately observable.
-- `stage` continues to describe judging alone, exactly as it did; these columns
-- describe the downstream artefact. A job may legitimately be
-- `stage = completed` with `feedback_status = failed`, and that combination is
-- the point of the change rather than a state to be avoided.
--
-- Nothing here touches scores, ranking, evidence or confidence.
-- ---------------------------------------------------------------------------

alter table assessment_jobs
  add column if not exists feedback_status text not null default 'pending',
  add column if not exists feedback_error text,
  add column if not exists feedback_attempts integer not null default 0,
  add column if not exists feedback_updated_at timestamptz;

/*
 * Constrained rather than free text.
 *
 * A status column that accepts anything ends up holding four spellings of the
 * same state, and the queries that matter — "what still needs feedback" — then
 * quietly miss rows.
 *
 *   pending    nothing has been attempted yet, or a retry has been requested
 *   generating an attempt is in flight
 *   generated  a report exists
 *   failed     attempts were exhausted; `feedback_error` says why
 */
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assessment_jobs_feedback_status_check'
  ) then
    alter table assessment_jobs
      add constraint assessment_jobs_feedback_status_check
      check (feedback_status in ('pending', 'generating', 'generated', 'failed'));
  end if;
end;
$$;

/*
 * Backfill from the truth already on disk.
 *
 * A job whose submission has a report is `generated`; everything else stays
 * `pending`, which is honest — those were attempted and refused, but the
 * attempt count and the reason were never written down, and inventing either
 * would be worse than saying "not done yet". `pending` is also what makes them
 * eligible for the backfill, which is the outcome that matters.
 */
update assessment_jobs j
   set feedback_status = 'generated',
       feedback_updated_at = f.generated_at
  from feedback_reports f
 where f.submission_id = j.submission_id
   and j.feedback_status <> 'generated';

-- The backfill and the worker's sweep both ask the same question: which jobs
-- still owe a report.
create index if not exists assessment_jobs_feedback_status
  on assessment_jobs (feedback_status)
  where feedback_status in ('pending', 'generating');

-- The worker already holds `all` on assessment_jobs (0002), so it can write
-- these. No new grant is needed, and none is given.
