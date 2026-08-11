-- ==========================================================================
-- Row-level security
--
-- Defence in depth behind the application's authorisation checks. Both layers
-- must agree, and the negative E2E tests assert the participant boundary from
-- outside the process.
--
-- The central design point (ADR-010): the participant role has NO SELECT policy
-- on any assessment table. The policy is ABSENT, not restrictive — so the
-- answer to "can a participant read scores?" is always zero rows, and adding a
-- new participant surface cannot accidentally grant access.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- Roles
-- --------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ohj_participant') then
    create role ohj_participant nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ohj_admin') then
    create role ohj_admin nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ohj_worker') then
    create role ohj_worker nologin;
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- Request context
--
-- The application sets `app.team_id` after validating an invite token
-- server-side. A participant never supplies this value directly.
-- --------------------------------------------------------------------------

create or replace function current_team_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.team_id', true), '')::uuid;
$$;

create or replace function is_admin() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.is_admin', true), 'false') = 'true';
$$;

-- --------------------------------------------------------------------------
-- Enable RLS everywhere
-- --------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'admin_account', 'admin_sessions', 'rubric_versions', 'rubric_categories',
    'cohorts', 'cohort_ideas', 'teams', 'team_members', 'team_invites',
    'submissions', 'submission_artifacts', 'submission_credentials',
    'submission_declarations', 'submission_events', 'assessment_jobs',
    'preflight_checks', 'artifact_analyses', 'test_plans', 'test_plan_steps',
    'browser_test_runs', 'browser_test_steps', 'assessment_evidence',
    'category_scores', 'assessment_summaries', 'consistency_reviews',
    'manual_review_flags', 'disqualifications', 'ranking_snapshots',
    'ranking_entries', 'final_selections', 'feedback_reports',
    'resource_documents', 'audit_logs', 'system_settings'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;

-- --------------------------------------------------------------------------
-- Admin: full access, gated on a verified shared-admin session
-- --------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'admin_account', 'admin_sessions', 'rubric_versions', 'rubric_categories',
    'cohorts', 'cohort_ideas', 'teams', 'team_members', 'team_invites',
    'submissions', 'submission_artifacts', 'submission_credentials',
    'submission_declarations', 'submission_events', 'assessment_jobs',
    'preflight_checks', 'artifact_analyses', 'test_plans', 'test_plan_steps',
    'browser_test_runs', 'browser_test_steps', 'assessment_evidence',
    'category_scores', 'assessment_summaries', 'consistency_reviews',
    'manual_review_flags', 'disqualifications', 'ranking_snapshots',
    'ranking_entries', 'final_selections', 'feedback_reports',
    'resource_documents', 'system_settings'
  ] loop
    execute format(
      'create policy admin_all on %I for all to ohj_admin using (is_admin()) with check (is_admin())',
      t
    );
  end loop;
end;
$$;

-- Audit logs: admins read and append, but never update or delete.
create policy admin_read_audit on audit_logs for select to ohj_admin using (is_admin());
create policy admin_append_audit on audit_logs for insert to ohj_admin with check (is_admin());

-- --------------------------------------------------------------------------
-- Participant: their own submission tree, and nothing else
-- --------------------------------------------------------------------------

create policy participant_own_team on teams
  for select to ohj_participant
  using (id = current_team_id());

create policy participant_own_members on team_members
  for select to ohj_participant
  using (team_id = current_team_id());

-- Cohort details the participant is entitled to see. Note there is no policy
-- exposing assessment_config beyond this row-level grant; the application
-- projects only the participant-safe fields.
create policy participant_own_cohort on cohorts
  for select to ohj_participant
  using (id in (select cohort_id from teams where id = current_team_id()));

create policy participant_cohort_ideas on cohort_ideas
  for select to ohj_participant
  using (
    is_active
    and cohort_id in (select cohort_id from teams where id = current_team_id())
  );

create policy participant_own_submission_select on submissions
  for select to ohj_participant
  using (team_id = current_team_id());

-- Editing is allowed only while the cohort is open AND the submission is in an
-- editable state. Both conditions, mirroring canParticipantEdit().
create policy participant_own_submission_update on submissions
  for update to ohj_participant
  using (
    team_id = current_team_id()
    and status in ('draft', 'reopened')
    and cohort_id in (select id from cohorts where status = 'open')
  )
  with check (
    team_id = current_team_id()
    and status in ('draft', 'reopened', 'submitted', 'locked')
  );

create policy participant_own_artifacts on submission_artifacts
  for all to ohj_participant
  using (submission_id in (select id from submissions where team_id = current_team_id()))
  with check (submission_id in (select id from submissions where team_id = current_team_id()));

-- Credentials: a participant may WRITE their own but never READ them back.
-- There is deliberately no SELECT policy on this table for participants.
create policy participant_write_credentials on submission_credentials
  for insert to ohj_participant
  with check (submission_id in (select id from submissions where team_id = current_team_id()));

create policy participant_update_credentials on submission_credentials
  for update to ohj_participant
  using (submission_id in (select id from submissions where team_id = current_team_id()))
  with check (submission_id in (select id from submissions where team_id = current_team_id()));

create policy participant_own_declarations on submission_declarations
  for all to ohj_participant
  using (submission_id in (select id from submissions where team_id = current_team_id()))
  with check (submission_id in (select id from submissions where team_id = current_team_id()));

create policy participant_own_events on submission_events
  for select to ohj_participant
  using (submission_id in (select id from submissions where team_id = current_team_id()));

create policy participant_visible_resources on resource_documents
  for select to ohj_participant
  using (
    is_participant_visible
    and (cohort_id is null or cohort_id in (select cohort_id from teams where id = current_team_id()))
  );

-- ==========================================================================
-- DELIBERATELY ABSENT
--
-- No participant policy exists on any of:
--
--   assessment_jobs, preflight_checks, artifact_analyses, test_plans,
--   test_plan_steps, browser_test_runs, browser_test_steps,
--   assessment_evidence, category_scores, assessment_summaries,
--   consistency_reviews, manual_review_flags, disqualifications,
--   ranking_snapshots, ranking_entries, final_selections, feedback_reports,
--   audit_logs, system_settings, admin_account, admin_sessions, team_invites
--
-- With RLS forced and no policy, these tables return zero rows to
-- ohj_participant under every query. This is the structural guarantee behind
-- "participants must never see judging information". Do not add a participant
-- policy to any table in this list.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- Worker: reads submissions, writes assessment output
-- --------------------------------------------------------------------------

do $$
declare t text;
begin
  -- Read-only inputs.
  foreach t in array array[
    'cohorts', 'cohort_ideas', 'teams', 'team_members', 'submissions',
    'submission_artifacts', 'submission_declarations', 'rubric_versions',
    'rubric_categories', 'system_settings'
  ] loop
    execute format('create policy worker_read on %I for select to ohj_worker using (true)', t);
  end loop;

  -- Assessment output the worker owns.
  foreach t in array array[
    'assessment_jobs', 'preflight_checks', 'artifact_analyses', 'test_plans',
    'test_plan_steps', 'browser_test_runs', 'browser_test_steps',
    'assessment_evidence', 'category_scores', 'assessment_summaries',
    'consistency_reviews', 'manual_review_flags', 'disqualifications',
    'feedback_reports'
  ] loop
    execute format('create policy worker_all on %I for all to ohj_worker using (true) with check (true)', t);
  end loop;
end;
$$;

-- The worker decrypts credentials at the moment of use, so it reads this table
-- but may never modify it.
create policy worker_read_credentials on submission_credentials
  for select to ohj_worker using (true);

-- The worker appends to the audit log and can read nothing else there.
create policy worker_append_audit on audit_logs
  for insert to ohj_worker with check (actor_type = 'worker');

-- The worker has NO policy on ranking_snapshots, ranking_entries or
-- final_selections. It cannot rank, and it certainly cannot pick winners
-- (ADR-018).

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------

grant usage on schema public to ohj_participant, ohj_admin, ohj_worker;
grant select, insert, update on all tables in schema public to ohj_admin;
grant select, insert, update on all tables in schema public to ohj_worker;
grant select, insert, update on all tables in schema public to ohj_participant;

-- Nobody deletes through the application. Removal is an admin retention job
-- running with elevated privileges, and it is audit-logged.
revoke delete on all tables in schema public from ohj_participant, ohj_admin, ohj_worker;
