-- ==========================================================================
-- Production learner entry
--
-- Forward-only. Adds everything the common /submit flow needs:
--
--   * team access codes (Argon2id-hashed, versioned)
--   * participant sessions (opaque, revocable, version-bound)
--   * learner-safe team activity
--   * verification rate limiting
--   * optimistic-concurrency versioning on submissions
--   * explicit cohort closure and reopening state
--   * approval state for expanded idea definitions
--
-- Nothing here drops or rewrites existing data.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- Team access codes
-- --------------------------------------------------------------------------

create table team_access_codes (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  cohort_id uuid not null references cohorts (id) on delete cascade,
  group_number integer not null,
  -- Argon2id. There is deliberately no column that could hold plaintext.
  code_hash text not null,
  -- Incrementing this invalidates every session minted under the old code,
  -- without having to find those sessions.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_verified_at timestamptz,
  verify_count integer not null default 0,
  unique (team_id, version)
);

-- At most one live code per team.
create unique index team_access_codes_one_live
  on team_access_codes (team_id) where revoked_at is null;
create index team_access_codes_lookup on team_access_codes (group_number, cohort_id);

-- --------------------------------------------------------------------------
-- Participant sessions
-- --------------------------------------------------------------------------

create table participant_sessions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  cohort_id uuid not null references cohorts (id) on delete cascade,
  -- Only the hash. The cookie value never lands in the database.
  session_token_hash text not null unique,
  -- An ACTIVITY LABEL, not verified identity. Anyone with the shared code can
  -- type any name; nothing security-relevant may depend on it.
  editor_name text not null,
  editor_role text,
  -- Bound to the code version, so regeneration revokes in one write.
  access_code_version integer not null,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text
);

create index participant_sessions_team on participant_sessions (team_id)
  where revoked_at is null;
create index participant_sessions_expiry on participant_sessions (expires_at)
  where revoked_at is null;

-- --------------------------------------------------------------------------
-- Learner-safe team activity
--
-- Distinct from audit_logs on purpose: this is shown BACK to the team, so it
-- carries only a closed set of participant-safe events.
-- --------------------------------------------------------------------------

create table team_activity (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  team_id uuid not null references teams (id) on delete cascade,
  kind text not null check (kind in (
    'draft_opened', 'section_saved', 'deck_replaced',
    'demo_link_saved', 'review_opened', 'final_submitted'
  )),
  editor_name text not null,
  section text,
  created_at timestamptz not null default now()
);
create index team_activity_submission on team_activity (submission_id, created_at desc);

-- --------------------------------------------------------------------------
-- Verification rate limiting
--
-- Keyed on hashed IP AND group number, so one hostile client cannot lock out a
-- legitimate team, and one fumbling team cannot lock out an office behind a NAT.
-- --------------------------------------------------------------------------

create table verification_attempts (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references cohorts (id) on delete cascade,
  group_number integer not null,
  ip_hash text not null,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  unique (ip_hash, group_number)
);
create index verification_attempts_locked on verification_attempts (locked_until)
  where locked_until is not null;

-- --------------------------------------------------------------------------
-- Submissions: optimistic concurrency and editor labels
-- --------------------------------------------------------------------------

alter table submissions
  -- Every write carries the version it read. A stale write is refused rather
  -- than allowed to silently overwrite a teammate.
  add column version integer not null default 1,
  add column last_edited_by text,
  add column submitted_by_name text;

-- --------------------------------------------------------------------------
-- Cohorts: explicit closure and reopening
-- --------------------------------------------------------------------------

alter table cohorts
  add column closed_at timestamptz,
  add column closure_type text check (closure_type in ('manual', 'deadline')),
  -- Set when reopening after the official deadline. Writes are accepted until
  -- this instant, so "reopened" never means "open but rejecting every save".
  add column accepting_until timestamptz;

alter table cohorts
  add constraint accepting_until_after_deadline
  check (accepting_until is null or accepting_until > day13_deadline_at);

-- --------------------------------------------------------------------------
-- Idea definitions: source vs expanded, and approval
--
-- Title and description come from the approved source catalogue. The expanded
-- judging fields are our interpretation and only influence real judging once
-- approved (ADR-025).
-- --------------------------------------------------------------------------

alter table cohort_ideas
  add column definition_status text not null default 'draft'
    check (definition_status in ('draft', 'approved')),
  add column definition_approved_at timestamptz,
  add column definition_approved_by text;

comment on column cohort_ideas.definition_status is
  'Expanded fields (minimum_core_flow, expected_entities, ai_opportunity, allowed_scope, unsafe_interpretations) influence real judging only when approved. Source title and description are always usable.';

-- --------------------------------------------------------------------------
-- Row-level security
-- --------------------------------------------------------------------------

alter table team_access_codes enable row level security;
alter table team_access_codes force row level security;
alter table participant_sessions enable row level security;
alter table participant_sessions force row level security;
alter table team_activity enable row level security;
alter table team_activity force row level security;
alter table verification_attempts enable row level security;
alter table verification_attempts force row level security;

-- Admin: full access to all four.
create policy admin_all on team_access_codes for all to ohj_admin
  using (is_admin()) with check (is_admin());
create policy admin_all on participant_sessions for all to ohj_admin
  using (is_admin()) with check (is_admin());
create policy admin_all on team_activity for all to ohj_admin
  using (is_admin()) with check (is_admin());
create policy admin_all on verification_attempts for all to ohj_admin
  using (is_admin()) with check (is_admin());

-- Participants may read their own team's activity, and nothing else.
create policy participant_own_activity on team_activity
  for select to ohj_participant
  using (team_id = current_team_id());

-- ==========================================================================
-- DELIBERATELY ABSENT
--
-- No participant policy on team_access_codes, participant_sessions or
-- verification_attempts.
--
-- Verification and session handling run server-side with elevated privilege.
-- A participant role that could SELECT team_access_codes could enumerate every
-- group in the cohort — which is exactly what the generic /submit error message
-- exists to prevent. Do not add one.
--
-- The worker has no policy on any of the four either. Assessment never needs to
-- know who was logged in or how they got there.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------

create trigger verification_attempts_touch before update on verification_attempts
  for each row execute function touch_updated_at();

-- 0002 granted "all tables in schema public", which only covered the tables
-- that existed then. New tables need their own grants.
grant select, insert, update on team_access_codes to ohj_admin;
grant select, insert, update on participant_sessions to ohj_admin;
grant select, insert, update on team_activity to ohj_admin;
grant select, insert, update on verification_attempts to ohj_admin;

-- Read only, matching the one participant policy above. A grant that promises
-- more than the policy allows reads as an intention nobody implemented.
grant select on team_activity to ohj_participant;

-- Same rule as 0002: nobody deletes through the application.
revoke delete on team_access_codes, participant_sessions, team_activity,
  verification_attempts from ohj_participant, ohj_admin, ohj_worker;
