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

-- The role must not be able to step around RLS by being a superuser, inheriting
-- one, or carrying BYPASSRLS. Stated rather than assumed: this is the property
-- the whole migration depends on.
alter role ohj_worker with nosuperuser nocreatedb nocreaterole nobypassrls noinherit;

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
-- Its own output, and only its own. Delete is absent throughout: nothing in the
-- pipeline removes a row, and a worker that could would be able to erase the
-- evidence behind a score.

grant select, insert, update on
  assessment_jobs, preflight_checks, artifact_analyses, test_plans,
  test_plan_steps, browser_test_runs, browser_test_steps,
  assessment_evidence, category_scores, assessment_summaries,
  consistency_reviews, manual_review_flags, disqualifications,
  feedback_reports
to ohj_worker;

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
--   team_invites, submission_events, resource_documents
--       Participant-facing records the worker has no business in.

revoke all on
  ranking_snapshots, ranking_entries, final_selections,
  admin_account, admin_sessions, team_invites, submission_events,
  resource_documents
from ohj_worker;

-- Access-code hashes live on `teams`. The grant above is SELECT-only, so the
-- worker cannot alter one; it can read the hash column, which is Argon2id and
-- useless without the code. Splitting the column out is the stronger fix and is
-- a schema change, not a permissions one — recorded here rather than done
-- quietly as part of a grants migration.

-- Future tables are not granted by default. A new table is unreachable by the
-- worker until somebody writes the grant, which is the direction the mistake
-- should fall in.
alter default privileges in schema public revoke all on tables from ohj_worker;
