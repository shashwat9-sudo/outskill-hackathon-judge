-- ---------------------------------------------------------------------------
-- 0010 — a submission's identity includes the cohort it came from
-- ---------------------------------------------------------------------------
--
-- 0009 made `external_submission_id` globally unique, which was one assumption
-- too many. It says that no two cohorts can ever issue the same identifier —
-- true today, because the Hackathon product mints opaque ids, and not something
-- the Judge should depend on. If C14 ever restarts its numbering, or a second
-- internal product starts sending work, a collision would silently attach new
-- submissions to an assessment from a previous cohort.
--
-- Identity is now (source, external_cohort_id, external_submission_id). The
-- cohort is part of who a submission *is*, not merely a field it carries, and
-- the same identifier arriving from two cohorts is two submissions.
--
-- Cohort isolation matters beyond identity. Group 42 in C13 and Group 42 in C14
-- are different teams; ranking, the private Top 10 and re-judging all have to
-- stay inside one cohort. Each external cohort maps to exactly one Judge cohort
-- row, and everything downstream is already scoped by that row's id — so the
-- mapping being one-to-one and enforced is what makes the rest of it hold.
-- ---------------------------------------------------------------------------

alter table cohorts
  add column if not exists external_cohort_id text;

-- One Judge cohort per external cohort. This is the mapping the whole
-- integration turns on: AIAP-C13 resolves to exactly one uuid, forever.
create unique index if not exists cohorts_external_cohort_id
  on cohorts (external_cohort_id)
  where external_cohort_id is not null;

comment on column cohorts.external_cohort_id is
  'The internal Hackathon product''s own cohort identifier, e.g. AIAP-C13. Set '
  'only by the authenticated cohort-sync endpoint; never by a learner path.';

-- ---------------------------------------------------------------------------
-- Scoped submission identity
-- ---------------------------------------------------------------------------

drop index if exists submissions_external_submission_id;

create unique index if not exists submissions_external_identity
  on submissions (source, external_cohort_id, external_submission_id)
  where external_submission_id is not null;

-- ---------------------------------------------------------------------------
-- Who may write the mapping
-- ---------------------------------------------------------------------------
--
-- Creating a Judge cohort decides where a whole cohort's submissions land and
-- which ranking they compete in. Participants have no update policy on
-- `cohorts` and the worker holds SELECT only (0006); restated here because the
-- consequence of getting it wrong is a learner steering their own submission
-- into a different cohort's Top 10.
revoke update on cohorts from ohj_participant;
revoke update on cohorts from ohj_worker;
