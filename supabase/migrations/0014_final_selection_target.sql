-- ---------------------------------------------------------------------------
-- 0014 — how many winners a cohort picks is a fact about the cohort
-- ---------------------------------------------------------------------------
--
-- The final selection was "the final four" everywhere: a constant in the
-- domain code, a CHECK constraint of `position between 1 and 4`, four slots on
-- the page. AIAP C14 announces three winners. Replacing the four with a three
-- would have rewritten history for every cohort already recorded with four,
-- and a cohort after C14 may want something else again.
--
-- So the number lives on the cohort, next to `shortlist_target`, which already
-- works this way. Existing rows default to 4, which is exactly what they were
-- selected under — nothing about a past cohort changes by this migration
-- running. The application reads the cohort's value; it never guesses.
--
-- The `position` bound on `final_selections` becomes the same wide bound as
-- `shortlist_target` (1–100). The per-cohort exactness — exactly N positions,
-- 1..N, no gaps, no duplicates — is enforced by `validateFinalSelection`
-- against the cohort's own target on the single admin write path (ADR-018).
-- ---------------------------------------------------------------------------

alter table cohorts
  add column if not exists final_selection_target integer not null default 4
    check (final_selection_target between 1 and 100);

comment on column cohorts.final_selection_target is
  'How many winners a person records for this cohort (1st, 2nd, 3rd, …). '
  'Defaults to 4, the historical Final Four. Never chosen by the system; '
  'the number of positions a human fills on the Finalists page.';

-- `check (position between 1 and 4)` was declared inline on the column in
-- 0001, so Postgres named it <table>_<column>_check.
alter table final_selections drop constraint if exists final_selections_position_check;
alter table final_selections
  add constraint final_selections_position_check check (position between 1 and 100);

-- Same rule as 0007 and 0010: participants and the worker have no business
-- changing how many winners a cohort has. Restated so it survives on its own.
revoke update on cohorts from ohj_participant;
revoke update on cohorts from ohj_worker;
