-- ---------------------------------------------------------------------------
-- 0007 — say out loud which cohorts are synthetic
-- ---------------------------------------------------------------------------
--
-- `AI_EVALUATION_MODE=synthetic_only` exists so that a deployment can exercise
-- the judging pipeline without any learner's work reaching a provider. Until
-- now it decided what counted as synthetic by looking at the database driver:
-- the in-memory store was synthetic, Postgres was real. That was a reasonable
-- shorthand and it had a consequence — a fixture cohort living in production
-- Postgres could not be judged at all, because nothing could distinguish it
-- from the real ones sitting beside it.
--
-- The alternative was to relax `synthetic_only`, which would have removed the
-- refusal for every cohort in the database at once. This column is the smaller
-- and more honest change: the fact is recorded where it belongs, on the cohort,
-- and every other cohort keeps exactly the protection it had.
--
-- Three properties this column is worth having:
--
--   It defaults to false, so this migration cannot mark anything synthetic by
--   running. Every cohort that exists today stays real, including the ones with
--   "TEST" in their names — a name is not a fact, and inferring from it is how
--   a team called "Synthetic Coffee" ends up having their deck sent somewhere.
--
--   It is NOT NULL, so there is no third state. A null would eventually be read
--   as falsy in one place and truthy in another, and the whole point is that
--   this question has one answer.
--
--   Nothing in the application writes it. `createCohort` names its columns
--   explicitly and does not include this one; `updateCohort` strips it from any
--   patch it is given. Setting it is a deliberate act by an operator with
--   database access, which is the correct amount of friction for a flag whose
--   meaning is "it is safe to send this to a third party".
-- ---------------------------------------------------------------------------

alter table cohorts
  add column if not exists is_synthetic boolean not null default false;

comment on column cohorts.is_synthetic is
  'True only for fixture cohorts created for testing. Permits AI dispatch under '
  'AI_EVALUATION_MODE=synthetic_only. Never set by participant, import or admin '
  'application paths — only deliberately, by an operator, on a cohort known to '
  'contain no learner work.';

-- Participants may already read cohorts through their own policy; they have no
-- update policy on the table and gain nothing here. Stated anyway, because the
-- one thing that must never happen is a participant flipping this bit.
revoke update on cohorts from ohj_participant;

-- The worker reads cohorts and has only SELECT (migration 0006), so it cannot
-- promote a real cohort to synthetic in order to talk to a provider. Restated
-- for the same reason: the guarantee is worth more than the line costs.
revoke update on cohorts from ohj_worker;
