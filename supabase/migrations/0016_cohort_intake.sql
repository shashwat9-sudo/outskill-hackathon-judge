-- 0016: where a cohort's submissions come from, recorded on the cohort.
--
-- Until now the Google Sheet intake was three environment variables: one
-- spreadsheet, one tab, one external cohort id. That is one cohort at a time,
-- and switching cohorts meant changing deployment configuration. Two cohorts
-- now run in parallel from two tabs (AIAP C15 IST and EST), in a newer
-- spreadsheet than the one the historical cohorts came from, so the mapping
-- moves onto the cohort row:
--
--   intake_mode            'portal'  — teams submit through the Judge's /submit
--                          'sheet'   — submissions are imported from a Google
--                                      Sheet tab named on the cohort
--                          'partner' — submissions arrive through the partner API
--   intake_spreadsheet_id  the spreadsheet this cohort reads; null means the
--                          deployment's default spreadsheet (the historical one),
--                          so C13/C14 keep working without any change
--   intake_tab_name        the tab this cohort reads (sheet mode); unique within
--                          a spreadsheet, so a tab can only ever feed one cohort
--   intake_timezone        the IANA zone the sheet's Form timestamps are written
--                          in, so lateness never depends on the server clock
--
-- The service account stays server-side configuration: every cohort reads
-- through it. `external_cohort_id` keeps its unique index (0010), so each
-- external id maps to exactly one cohort.
--
-- Additive. Historical cohorts keep every row. The backfill labels a cohort
-- by what it actually holds: rows ingested from a sheet carry the sheet's
-- `group-<n>` submission ids; rows that arrived through the partner API carry
-- the partner's own ids. A cohort with neither stays 'portal'. The two
-- historical sheet cohorts are also given the tab they were read from, so
-- their intake page keeps working against the default spreadsheet.

alter table cohorts
  add column if not exists intake_mode text not null default 'portal'
    constraint cohorts_intake_mode_check check (intake_mode in ('portal', 'sheet', 'partner')),
  add column if not exists intake_spreadsheet_id text,
  add column if not exists intake_tab_name text,
  add column if not exists intake_timezone text;

comment on column cohorts.intake_mode is 'portal: teams submit via the Judge; sheet: imported from the cohort''s Google Sheet tab; partner: delivered through the partner API.';
comment on column cohorts.intake_spreadsheet_id is 'Spreadsheet this cohort imports from; null means the deployment default (GOOGLE_SHEETS_SPREADSHEET_ID).';
comment on column cohorts.intake_tab_name is 'The Google Sheet tab this cohort imports from. One tab per cohort within a spreadsheet.';
comment on column cohorts.intake_timezone is 'IANA zone the sheet''s Form timestamps are written in (e.g. Asia/Kolkata); null means the cohort timezone.';

-- One tab feeds one cohort within a spreadsheet; the same tab name may exist
-- in two different spreadsheets.
create unique index if not exists cohorts_intake_tab_name
  on cohorts (coalesce(intake_spreadsheet_id, ''), lower(intake_tab_name))
  where intake_tab_name is not null;

-- Sheet-fed: holds rows the sheet intake ingested (group-<n> submission ids).
update cohorts c
   set intake_mode = 'sheet'
 where c.external_cohort_id is not null
   and c.intake_mode = 'portal'
   and exists (
     select 1 from submissions s
      where s.cohort_id = c.id and s.external_submission_id ~ '^group-[0-9]+$'
   );

-- Partner-fed: holds externally delivered rows that did not come from a sheet.
update cohorts c
   set intake_mode = 'partner'
 where c.external_cohort_id is not null
   and c.intake_mode = 'portal'
   and exists (
     select 1 from submissions s
      where s.cohort_id = c.id and s.external_submission_id is not null
   );

-- The two historical sheet cohorts read these tabs of the default spreadsheet.
update cohorts
   set intake_tab_name = 'Submissions - AIAP C13'
 where external_cohort_id = 'AIAP-C13' and intake_mode = 'sheet' and intake_tab_name is null;

update cohorts
   set intake_tab_name = 'Submissions - AIAP C14'
 where external_cohort_id = 'AIAP-C14' and intake_mode = 'sheet' and intake_tab_name is null;
