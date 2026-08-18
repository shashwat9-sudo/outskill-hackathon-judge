-- ==========================================================================
-- Operations hardening
--
-- Forward-only. Four unrelated-looking changes that all come from operating the
-- product for real:
--
--   1. The real Outskill learner sheet is one row per LEARNER, with no
--      designated team lead. The schema currently demands one.
--   2. That sheet carries a WhatsApp group link per group, which is useful
--      operational metadata and has nowhere to live.
--   3. Audit entries cannot survive deleting the cohort they reference, because
--      the foreign key wants to modify them and they are append-only.
--   4. Nothing stops two cohorts being open to learners at once.
--
-- Nothing here drops a column or removes data.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. Teams no longer require a lead
--
-- The allocation sheet lists learners, not leads. Inventing one — "the first row
-- in the group" — would put a name in front of the programme team that nobody
-- chose and that means nothing.
-- --------------------------------------------------------------------------

alter table teams alter column lead_name drop not null;
alter table teams alter column lead_email drop not null;

comment on column teams.lead_name is
  'Optional. The learner allocation sheet does not designate a lead; the manual CSV import may still supply one.';

-- --------------------------------------------------------------------------
-- 2. Operational metadata from the allocation sheet
--
-- The WhatsApp link is how the programme team reaches a group. It is metadata
-- and is NEVER authentication — holding the link grants nothing.
-- --------------------------------------------------------------------------

alter table teams add column whatsapp_link text;

comment on column teams.whatsapp_link is
  'Operational contact link from the learner allocation sheet. Never used for authentication.';

-- Learner emails, so a group is a list of people rather than a number.
alter table team_members add column email citext;

-- Makes re-uploading the same allocation sheet idempotent rather than
-- duplicating every learner.
create unique index team_members_unique_email
  on team_members (team_id, email) where email is not null;

comment on column team_members.email is
  'Learner email from the allocation sheet. Used to recognise the same learner on re-import.';

-- --------------------------------------------------------------------------
-- 3. Audit entries outlive what they describe
--
-- `audit_logs` is append-only, enforced by a trigger that rejects UPDATE and
-- DELETE. The foreign key on `cohort_id` was declared `on delete set null`,
-- which is an UPDATE — so the trigger refused it, and deleting a cohort became
-- impossible for any cohort that had ever been touched. Since creating a cohort
-- writes an audit entry, that was every cohort.
--
-- The foreign key is the part that is wrong. An audit entry is a historical
-- fact; referential integrity to a mutable table asks it to change when history
-- did not. The column and its index stay, holding the id as a plain value.
-- --------------------------------------------------------------------------

alter table audit_logs drop constraint if exists audit_logs_cohort_id_fkey;

comment on column audit_logs.cohort_id is
  'The cohort this entry concerned. Deliberately NOT a foreign key: an audit entry must survive the deletion of what it describes.';

-- --------------------------------------------------------------------------
-- 4. At most one cohort faces learners
--
-- A unique index on a constant, filtered to the learner-facing statuses, permits
-- exactly one such row. The application checks this too and gives a far better
-- message; this is the backstop for anything that bypasses it.
--
-- ⚠️ APPLYING THIS FAILS IF TWO COHORTS ARE ALREADY open OR paused.
--    Reconcile the data first — archive or close all but one — then apply.
-- --------------------------------------------------------------------------

create unique index cohorts_single_learner_facing
  on cohorts ((true))
  where status in ('open', 'paused');

comment on index cohorts_single_learner_facing is
  'At most one cohort may be open or paused. Two would make the learner entry page guess which cohort a team belongs to.';
