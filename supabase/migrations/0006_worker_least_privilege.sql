-- ---------------------------------------------------------------------------
-- 0006 — the worker stops being a superuser
-- ---------------------------------------------------------------------------
--
-- Migration 0002 wrote a careful set of policies for `ohj_worker`: it reads
-- submissions, writes assessment output, may read a credential at the moment it
-- uses one, and has no policy at all on the ranking tables because a machine
-- does not choose winners (ADR-018).
--
-- None of that was in force. `ohj_worker` was created `nologin`, so the worker
-- process connected as `postgres` instead — an owner and a superuser, which
-- bypasses row-level security entirely. Every policy above was decoration. A
-- bug in the worker, or a prompt injection that reached a query, had the whole
-- database: access-code hashes, admin sessions, the ranking tables, DELETE on
-- anything.
--
-- This migration makes the role real and narrows the grants underneath it to
-- match what the policies already say. Two layers, not one: the grants decide
-- which tables exist for this role at all, and the policies decide which rows.
--
-- No password appears here. A password in a migration is a password in Git.
-- The operator sets it once, out of band:
--
--   alter role ohj_worker with login password '<from the password manager>';
--
-- and puts the resulting connection string in the worker's DATABASE_URL. See
-- docs/WORKER_DEPLOYMENT.md.
-- ---------------------------------------------------------------------------

-- The role must not be able to step around RLS by being a superuser or carrying
-- BYPASSRLS. This is the property the whole migration depends on: a role with
-- either flag ignores every policy below, silently and with no error.
--
-- Checked rather than set. Changing those two attributes requires a true
-- superuser, which the `postgres` role on Supabase is not — so an `alter role
-- ... nosuperuser nobypassrls` fails outright on the platform this runs on. An
-- assertion is the better shape regardless: if the property is ever violated,
-- this migration stops and says so, instead of appearing to fix something it
-- cannot reach.
do $$
declare r record;
begin
  select rolsuper, rolbypassrls into r from pg_roles where rolname = 'ohj_worker';

  if not found then
    raise exception 'ohj_worker does not exist. Apply 0002_rls.sql first.';
  end if;

  if r.rolsuper or r.rolbypassrls then
    raise exception
      'ohj_worker bypasses row-level security (superuser=%, bypassrls=%). Every policy in 0002 is decoration until a superuser clears those flags.',
      r.rolsuper, r.rolbypassrls;
  end if;
end;
$$;

-- These the owner can set, and they are worth setting: a judging role has no
-- business creating databases or roles.
alter role ohj_worker with nocreatedb nocreaterole noinherit;

-- ---------------------------------------------------------------------------
-- Start from nothing
-- ---------------------------------------------------------------------------
--
-- 0002 granted `select, insert, update on all tables` and left RLS to do the
-- rest. That is one layer where there should be two: it means a table added
-- later, or a policy dropped by accident, silently becomes reachable. Revoking
-- everything first makes each grant below a deliberate statement.

revoke all on all tables in schema public from ohj_worker;
revoke all on all sequences in schema public from ohj_worker;
revoke all on all functions in schema public from ohj_worker;

grant usage on schema public to ohj_worker;

-- ---------------------------------------------------------------------------
-- What the worker reads
-- ---------------------------------------------------------------------------
--
-- The inputs to judging. Read-only: the worker never edits a learner's
-- submission, and a submission that changed under assessment would make the
-- evidence describe something that no longer exists.

grant select on
  cohorts, cohort_ideas, teams, team_members, submissions,
  submission_artifacts, submission_declarations, rubric_versions,
  rubric_categories, system_settings
to ohj_worker;

-- Credentials a team supplied for their own product, decrypted in memory at the
-- moment of use and never written back.
grant select on submission_credentials to ohj_worker;

-- ---------------------------------------------------------------------------
-- What the worker writes
-- ---------------------------------------------------------------------------
--
-- Its own output, and only its own.

grant select, insert, update on
  assessment_jobs, preflight_checks, artifact_analyses, test_plans,
  test_plan_steps, browser_test_runs, browser_test_steps,
  assessment_evidence, category_scores, assessment_summaries,
  consistency_reviews, manual_review_flags, disqualifications,
  feedback_reports
to ohj_worker;

-- ---------------------------------------------------------------------------
-- The two deletes the pipeline actually performs
-- ---------------------------------------------------------------------------
--
-- This migration originally said "nothing in the pipeline removes a row", and
-- that was simply untrue. Two stages replace their own output rather than
-- appending to it, and both died on `permission denied` the first time a job
-- reached them:
--
--   test_plan_steps      — regenerating a plan clears its steps and re-inserts
--                          them, scoped to that one plan.
--   assessment_evidence  — re-scoring clears the job's evidence rows and writes
--                          them again, in one transaction, so a re-run cannot
--                          double every downstream count.
--
-- Both are the worker rewriting rows it wrote itself, for the job it holds.
-- Neither can reach a learner's submission, an artifact, or the browser
-- evidence in Storage — those live in tables where DELETE is still absent, and
-- the objects themselves are not the database's to remove.
grant delete on test_plan_steps, assessment_evidence to ohj_worker;

-- Append-only. The policy in 0002 additionally requires actor_type = 'worker',
-- so the worker cannot write an entry that looks like an admin's.
grant insert on audit_logs to ohj_worker;

-- ---------------------------------------------------------------------------
-- What the worker must never touch
-- ---------------------------------------------------------------------------
--
-- Left ungranted above, and revoked explicitly so the intent survives someone
-- later running `grant ... on all tables` without reading this file.
--
--   ranking_snapshots, ranking_entries, final_selections
--       The system ranks privately and Outskill humans choose the Final Four.
--       A worker with write access to these could, in principle, produce a
--       winner. It has no read access either: a machine that cannot see the
--       ranking cannot be steered by it.
--
--   admin_account, admin_sessions
--       Password hashes and live session tokens. Nothing in judging needs them.
--
--   team_invites, resource_documents, submission_events
--       Participant-facing records the worker has no business in.
--
--   audit_logs
--       Append-only. The worker writes its own entries and cannot read any
--       back, so it can neither watch admin activity nor revise its own trail.
--
-- These were briefly granted at SELECT while the worker still called the admin
-- submission read, which touched them. It now uses `getJudgingInput`, which
-- does not, so the grants are gone again — the query not existing is a stronger
-- guarantee than a policy returning no rows.

--   team_access_codes, participant_sessions
--       Argon2id access-code hashes and live participant sessions. Never
--       granted to the worker, before or after this migration — listed here so
--       a later `grant ... on all tables` cannot quietly reach them.
revoke all on
  ranking_snapshots, ranking_entries, final_selections,
  admin_account, admin_sessions, team_invites, submission_events,
  resource_documents, team_access_codes, participant_sessions,
  submission_events
from ohj_worker;

-- audit_logs keeps its INSERT and nothing else: revoking wholesale here would
-- undo the append grant above.
revoke select, update, delete, truncate, references, trigger on audit_logs from ohj_worker;

-- Future tables are not granted by default. A new table is unreachable by the
-- worker until somebody writes the grant, which is the direction the mistake
-- should fall in.
alter default privileges in schema public revoke all on tables from ohj_worker;
