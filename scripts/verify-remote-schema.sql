-- ==========================================================================
-- Post-migration verification — READ ONLY
--
-- Run in the Supabase dashboard SQL editor after `supabase db push`.
-- Every statement is a SELECT. Nothing here writes, drops or deletes.
--
-- Each row prints what it checked, what it found, and what it should be, so a
-- wrong answer is obvious without cross-referencing anything.
-- ==========================================================================

select 'tables in public' as check_name,
       count(*)::text as found,
       '38' as expected
from pg_tables where schemaname = 'public'

union all
select 'tables WITHOUT row-level security',
       count(*)::text, '0'
from pg_tables where schemaname = 'public' and not rowsecurity

union all
select 'application roles created',
       count(*)::text, '3'
from pg_roles where rolname in ('ohj_participant', 'ohj_admin', 'ohj_worker')

union all
select 'migrations recorded remotely',
       count(*)::text, '4'
from supabase_migrations.schema_migrations

-- Participant isolation (ADR-010). A participant policy on any assessment
-- table would make scores reachable from the learner surface.
union all
select 'participant policies on ASSESSMENT tables',
       count(*)::text, '0'
from pg_policies
where schemaname = 'public' and 'ohj_participant' = any (roles)
  and tablename in ('category_scores', 'assessment_summaries', 'assessment_evidence',
                    'browser_test_runs', 'browser_test_steps', 'ranking_snapshots',
                    'ranking_entries', 'final_selections', 'feedback_reports',
                    'manual_review_flags', 'disqualifications', 'audit_logs',
                    'consistency_reviews')

-- A participant able to read team_access_codes could enumerate every group in
-- the cohort, which is what the generic verification error exists to prevent.
union all
select 'participant policies on ENTRY tables',
       count(*)::text, '0'
from pg_policies
where schemaname = 'public' and 'ohj_participant' = any (roles)
  and tablename in ('team_access_codes', 'participant_sessions', 'verification_attempts')

union all
select 'participant policy on team_activity (own team only)',
       count(*)::text, '1'
from pg_policies
where schemaname = 'public' and tablename = 'team_activity'
  and 'ohj_participant' = any (roles)

union all
select 'DELETE granted to any application role',
       count(*)::text, '0'
from information_schema.role_table_grants
where table_schema = 'public' and privilege_type = 'DELETE'
  and grantee in ('ohj_participant', 'ohj_admin', 'ohj_worker')

-- Storage
union all
select 'storage buckets', count(*)::text, '6' from storage.buckets

union all
select 'PUBLIC storage buckets', count(*)::text, '0'
from storage.buckets where public

union all
select 'bucket names',
       coalesce(string_agg(id, ', ' order by id), '(none)'),
       'admin-resources, browser-evidence, internal-reports, submission-decks, submission-screenshots, traces'
from storage.buckets

union all
select 'RLS on storage.objects',
       coalesce((select rowsecurity::text from pg_tables
                 where schemaname = 'storage' and tablename = 'objects'), 'MISSING'),
       'true'

-- These four are the statements most at risk of being refused on hosted
-- Supabase, because storage.objects is owned by supabase_storage_admin.
union all
select 'our storage.objects policies',
       count(*)::text, '4'
from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('participant_upload_deck', 'admin_manage_objects',
                     'worker_write_evidence', 'worker_read_decks')

-- No synthetic data. Actual counts, not planner estimates.
union all
select 'rows: cohorts / teams / team_members',
       (select count(*) from cohorts)::text || ' / ' ||
       (select count(*) from teams)::text || ' / ' ||
       (select count(*) from team_members)::text,
       '0 / 0 / 0'

union all
select 'rows: submissions / artifacts / credentials',
       (select count(*) from submissions)::text || ' / ' ||
       (select count(*) from submission_artifacts)::text || ' / ' ||
       (select count(*) from submission_credentials)::text,
       '0 / 0 / 0'

union all
select 'rows: assessment jobs / scores / summaries',
       (select count(*) from assessment_jobs)::text || ' / ' ||
       (select count(*) from category_scores)::text || ' / ' ||
       (select count(*) from assessment_summaries)::text,
       '0 / 0 / 0'

union all
select 'rows: ranking snapshots / entries / final selections',
       (select count(*) from ranking_snapshots)::text || ' / ' ||
       (select count(*) from ranking_entries)::text || ' / ' ||
       (select count(*) from final_selections)::text,
       '0 / 0 / 0'

union all
select 'rows: access codes / sessions / activity',
       (select count(*) from team_access_codes)::text || ' / ' ||
       (select count(*) from participant_sessions)::text || ' / ' ||
       (select count(*) from team_activity)::text,
       '0 / 0 / 0'

union all
select 'rows: admin accounts (0 until first app start)',
       (select count(*) from admin_account)::text, '0'

order by check_name;
