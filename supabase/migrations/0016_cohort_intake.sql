-- 0016: where a cohort's submissions come from, recorded on the cohort.
--
-- Until now the Google Sheet intake was three environment variables: one tab,
-- one external cohort id, one display name. That is one cohort at a time, and
-- switching cohorts meant changing deployment configuration. Two cohorts run
-- in parallel from two tabs of the same spreadsheet (AIAP C15 IST and EST), so
-- the mapping moves onto the cohort row:
--
--   intake_mode      'portal' — teams submit through the Judge's own /submit
--                    'sheet'  — submissions arrive from a Google Sheet tab
--   intake_tab_name  the tab this cohort reads (sheet mode); unique, so a tab
--                    can only ever feed one cohort
--   intake_timezone  the IANA zone the sheet's Form timestamps are written in,
--                    so a deadline comparison never depends on the server clock
--
-- The spreadsheet id and the service account stay server-side configuration:
-- both cohorts share them. `external_cohort_id` keeps its unique index (0010),
-- so each external id maps to exactly one cohort.
--
-- Additive. Historical cohorts keep every row; cohorts that already carry an
-- external id were fed by the sheet or the partner API, and are labelled so.

alter table cohorts
  add column if not exists intake_mode text not null default 'portal'
    constraint cohorts_intake_mode_check check (intake_mode in ('portal', 'sheet')),
  add column if not exists intake_tab_name text,
  add column if not exists intake_timezone text;

comment on column cohorts.intake_mode is 'portal: teams submit via the Judge; sheet: submissions are imported from the cohort''s Google Sheet tab.';
comment on column cohorts.intake_tab_name is 'The Google Sheet tab this cohort imports from. One tab feeds one cohort.';
comment on column cohorts.intake_timezone is 'IANA zone the sheet''s Form timestamps are written in (e.g. Asia/Kolkata); null means the cohort timezone.';

create unique index if not exists cohorts_intake_tab_name
  on cohorts (lower(intake_tab_name))
  where intake_tab_name is not null;

update cohorts
   set intake_mode = 'sheet'
 where external_cohort_id is not null
   and intake_mode = 'portal';
