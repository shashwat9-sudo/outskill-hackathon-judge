-- ==========================================================================
-- Outskill Hackathon Judge — core schema
--
-- Mirrors docs/DATABASE_ERD.md. Constraints carry the rules that must never be
-- violated even if application code is wrong:
--   * one submission per team per cohort
--   * the rubric sums to exactly 100
--   * test-plan steps outside the permitted DSL cannot be stored
--   * disqualification reasons outside the eleven permitted grounds cannot be
--     stored — "low score" is not representable
-- ==========================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- --------------------------------------------------------------------------
-- Enumerations
-- --------------------------------------------------------------------------

create type cohort_status as enum (
  'draft', 'open', 'paused', 'closed', 'judging', 'finalised', 'archived'
);

create type submission_status as enum (
  'draft', 'submitted', 'locked', 'reopened', 'withdrawn'
);

create type assessment_stage as enum (
  'queued', 'preflight', 'artifact_analysis', 'test_plan_generation',
  'browser_testing', 'evidence_review', 'scoring', 'consistency_review',
  'completed', 'manual_review', 'failed', 'disqualified'
);

create type actor_type as enum ('shared-admin', 'participant', 'system', 'worker');

create type preflight_status as enum ('pass', 'fail', 'warn', 'skipped');

create type failure_class as enum ('timeout', 'dns', 'auth', 'server', 'blocked', 'invalid', 'none');

create type artifact_kind as enum ('deck_pdf', 'demo_video', 'transcript', 'screenshot');

create type evidence_stance as enum ('supporting', 'contradictory', 'missing');

create type evidence_source as enum (
  'browser_step', 'screenshot', 'console', 'network', 'a11y',
  'deck', 'written', 'video', 'preflight'
);

create type disqualification_status as enum ('proposed', 'confirmed', 'reversed');

create type review_status as enum ('open', 'resolved', 'dismissed');

create type run_status as enum ('passed', 'partial', 'failed', 'error');

create type step_status as enum ('passed', 'failed', 'skipped', 'error');

-- --------------------------------------------------------------------------
-- Admin
-- --------------------------------------------------------------------------

create table admin_account (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true,
  username citext not null unique,
  password_hash text not null,
  password_updated_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one shared admin account. A second row is a schema error, not a
  -- policy question.
  constraint admin_account_singleton check (singleton)
);
create unique index admin_account_only_one on admin_account (singleton);

create table admin_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references admin_account (id) on delete cascade,
  session_token_hash text not null unique,
  csrf_token text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  rotated_from uuid references admin_sessions (id) on delete set null,
  ip_hash text,
  user_agent_hash text,
  revoked_at timestamptz
);
create index admin_sessions_active on admin_sessions (expires_at) where revoked_at is null;

-- --------------------------------------------------------------------------
-- Rubric
-- --------------------------------------------------------------------------

create table rubric_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  name text not null,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table rubric_categories (
  id uuid primary key default gen_random_uuid(),
  rubric_version_id uuid not null references rubric_versions (id) on delete cascade,
  key text not null,
  title text not null,
  description text not null default '',
  max_points numeric(5, 2) not null check (max_points > 0),
  display_order integer not null,
  created_at timestamptz not null default now(),
  unique (rubric_version_id, key)
);

-- The rubric must total exactly 100. Deferred so a version can be inserted
-- category by category inside one transaction.
create or replace function assert_rubric_totals_100() returns trigger
language plpgsql as $$
declare
  version_id uuid;
  total numeric;
begin
  version_id := coalesce(new.rubric_version_id, old.rubric_version_id);
  select sum(max_points) into total from rubric_categories where rubric_version_id = version_id;
  if total is not null and total <> 100 then
    raise exception 'Rubric % must total exactly 100 points, got %', version_id, total;
  end if;
  return null;
end;
$$;

create constraint trigger rubric_totals_100
  after insert or update or delete on rubric_categories
  deferrable initially deferred
  for each row execute function assert_rubric_totals_100();

-- --------------------------------------------------------------------------
-- Cohorts and ideas
-- --------------------------------------------------------------------------

create table cohorts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  description text not null default '',
  timezone text not null default 'Asia/Kolkata',
  day12_start_at timestamptz not null,
  day13_deadline_at timestamptz not null,
  shortlist_target integer not null default 10 check (shortlist_target between 1 and 100),
  submission_instructions text not null default '',
  rubric_version_id uuid references rubric_versions (id),
  assessment_config jsonb not null default '{}'::jsonb,
  status cohort_status not null default 'draft',
  finalised_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cohort_dates_ordered check (day13_deadline_at > day12_start_at)
);

create table cohort_ideas (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references cohorts (id) on delete cascade,
  title text not null,
  slug text not null,
  description text not null default '',
  target_user text not null default '',
  expected_use_case text not null default '',
  minimum_core_flow jsonb not null default '[]'::jsonb,
  expected_entities text[] not null default '{}',
  ai_opportunity text not null default '',
  allowed_scope text not null default '',
  unsafe_interpretations text not null default '',
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cohort_id, slug)
);

-- --------------------------------------------------------------------------
-- Teams
-- --------------------------------------------------------------------------

create table teams (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references cohorts (id) on delete cascade,
  group_number integer not null check (group_number between 1 and 999),
  lead_name text not null,
  lead_email citext not null,
  lead_phone text not null default '',
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The historical duplicate-group problem becomes impossible.
  unique (cohort_id, group_number)
);

create table team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  full_name text not null,
  contribution text not null default '',
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index team_members_team on team_members (team_id);

create table team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id) on delete cascade,
  -- Only the hash is stored; a database read yields no usable token.
  token_hash text not null unique,
  token_prefix text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer not null default 0
);
create index team_invites_lookup on team_invites (token_hash) where revoked_at is null;

-- --------------------------------------------------------------------------
-- Submissions
-- --------------------------------------------------------------------------

create table submissions (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references cohorts (id) on delete cascade,
  team_id uuid not null references teams (id) on delete cascade,
  status submission_status not null default 'draft',
  idea_id uuid references cohort_ideas (id) on delete restrict,

  product_name text,
  primary_user text,
  exact_problem text,
  one_sentence_promise text,
  brief_description text,
  why_ai_necessary text,
  differentiation text,
  must_have_workflow text,
  should_have_features text[] not null default '{}',
  excluded_features text,

  product_url text,
  login_required boolean not null default false,
  core_test_steps jsonb not null default '[]'::jsonb,
  safe_sample_inputs text,
  reset_instructions text,
  known_limitations text,

  bugs_fixed jsonb not null default '[]'::jsonb,
  deliberately_excluded text,
  major_tradeoff text,
  day12_to_day13_changes text,
  most_important_learning text,
  next_seven_day_plan text,
  builder_stack text,
  apis_used text,
  external_templates text,

  draft_payload jsonb not null default '{}'::jsonb,
  draft_updated_at timestamptz,
  submitted_at timestamptz,
  receipt_id text unique,
  locked_at timestamptz,
  reopened_at timestamptz,
  reopened_reason text,
  has_late_exception boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One submission per team per cohort, enforced by the database.
  unique (cohort_id, team_id),
  -- At most two should-have features, matching the MoSCoW rule taught to teams.
  constraint should_have_max_two check (array_length(should_have_features, 1) is null
                                        or array_length(should_have_features, 1) <= 2)
);

create index submissions_cohort_status on submissions (cohort_id, status);

-- Lateness is a computed FACT. Whether it disqualifies is a separate,
-- reversible admin decision (ADR-016).
create or replace function submission_is_late(sub submissions) returns boolean
language sql stable as $$
  select sub.submitted_at is not null
     and sub.submitted_at > (select day13_deadline_at from cohorts where id = sub.cohort_id);
$$;

create table submission_artifacts (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  kind artifact_kind not null,
  storage_bucket text,
  storage_path text,
  original_filename text,
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size >= 0),
  checksum_sha256 text,
  external_url text,
  upload_completed_at timestamptz,
  is_accessible boolean,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  -- A file has a path; a link has a URL. Exactly one, never both — this is what
  -- stops a Loom link ending up in the deck field.
  constraint artifact_has_exactly_one_source check (
    (storage_path is not null and external_url is null)
    or (storage_path is null and external_url is not null)
  )
);
create index submission_artifacts_submission on submission_artifacts (submission_id);

create table submission_credentials (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references submissions (id) on delete cascade,
  -- No plaintext column exists anywhere in this table.
  username_ciphertext bytea,
  password_ciphertext bytea,
  login_instructions_ciphertext bytea,
  iv bytea,
  auth_tag bytea,
  key_version integer not null default 1,
  deleted_at timestamptz,
  last_revealed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table submission_declarations (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references submissions (id) on delete cascade,
  built_during_hackathon boolean not null default false,
  owned_by_team boolean not null default false,
  external_material_disclosed boolean not null default false,
  judge_may_modify_demo_data boolean not null default false,
  no_real_customer_data boolean not null default false,
  urls_available_through_judging boolean not null default false,
  permission_to_submit boolean not null default false,
  accepted_at timestamptz,
  accepted_ip_hash text
);

create table submission_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  event_type text not null,
  actor_type actor_type not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index submission_events_submission on submission_events (submission_id, created_at);

-- --------------------------------------------------------------------------
-- Assessment pipeline
-- --------------------------------------------------------------------------

create table assessment_jobs (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references submissions (id) on delete cascade,
  cohort_id uuid not null references cohorts (id) on delete cascade,
  stage assessment_stage not null default 'queued',
  priority integer not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Claim path: SELECT ... FOR UPDATE SKIP LOCKED orders by these.
create index assessment_jobs_claim on assessment_jobs (stage, priority desc, next_attempt_at, created_at);
-- Lease-expiry sweep: reclaims a crashed worker's jobs.
create index assessment_jobs_leases on assessment_jobs (lease_expires_at) where claimed_by is not null;

create table preflight_checks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references assessment_jobs (id) on delete cascade,
  check_key text not null,
  status preflight_status not null,
  -- One row PER ATTEMPT, not per check. This is what makes "temporary outage,
  -- not a broken product" arguable after the fact.
  attempt_number integer not null default 1,
  failure_class failure_class not null default 'none',
  detail jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now()
);
create index preflight_checks_job on preflight_checks (job_id, checked_at);

create table artifact_analyses (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references assessment_jobs (id) on delete cascade,
  deck_page_count integer,
  deck_text_extracted boolean not null default false,
  deck_analysis jsonb not null default '{}'::jsonb,
  -- First-class, not a note: the system must be able to say "we could not see
  -- the video" rather than invent content (ADR-015).
  video_analysis_limited boolean not null default false,
  video_limitation_reason text,
  transcript_available boolean not null default false,
  written_analysis jsonb not null default '{}'::jsonb,
  injection_flags jsonb not null default '[]'::jsonb,
  model_version text not null,
  prompt_version text not null,
  created_at timestamptz not null default now()
);

create table test_plans (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references assessment_jobs (id) on delete cascade,
  generated_from jsonb not null default '{}'::jsonb,
  step_count integer not null default 0,
  estimated_duration_ms integer not null default 0,
  model_version text not null,
  prompt_version text not null,
  validation_status text not null default 'valid'
    check (validation_status in ('valid', 'partial', 'rejected')),
  rejected_steps jsonb not null default '[]'::jsonb,
  summary text,
  created_at timestamptz not null default now()
);

create table test_plan_steps (
  id uuid primary key default gen_random_uuid(),
  test_plan_id uuid not null references test_plans (id) on delete cascade,
  step_index integer not null,
  -- The last line of DSL containment: an action outside the permitted union
  -- cannot be stored, even if application validation were bypassed (ADR-007).
  action text not null check (action in (
    'navigate', 'click', 'fill', 'select', 'press', 'wait',
    'assertText', 'assertUrl', 'assertElement', 'screenshot', 'reload',
    'checkPersistence', 'checkConsole', 'checkNetwork', 'a11yScan', 'cleanup'
  )),
  step jsonb not null,
  is_cleanup boolean not null default false,
  rationale text,
  unique (test_plan_id, step_index)
);

create table browser_test_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references assessment_jobs (id) on delete cascade,
  viewport text not null check (viewport in ('desktop', 'mobile')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  status run_status not null default 'error',
  browser_version text,
  trace_path text,
  console_error_count integer not null default 0,
  network_failure_count integer not null default 0,
  a11y_violation_count integer not null default 0,
  a11y_summary jsonb not null default '{}'::jsonb,
  cleanup_status text not null default 'not_attempted'
    check (cleanup_status in ('complete', 'partial', 'not_attempted', 'failed')),
  timed_out boolean not null default false
);
create index browser_test_runs_job on browser_test_runs (job_id);

create table browser_test_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references browser_test_runs (id) on delete cascade,
  step_index integer not null,
  action text not null,
  status step_status not null,
  duration_ms integer not null default 0,
  screenshot_path text,
  assertion_detail jsonb not null default '{}'::jsonb,
  error_message text,
  unique (run_id, step_index)
);

create table assessment_evidence (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references assessment_jobs (id) on delete cascade,
  category_key text not null,
  evidence_type evidence_source not null,
  stance evidence_stance not null,
  summary text not null,
  source_ref jsonb not null default '{}'::jsonb,
  confidence numeric(3, 2) not null check (confidence between 0 and 1),
  created_at timestamptz not null default now()
);
create index assessment_evidence_job on assessment_evidence (job_id, category_key);

create table category_scores (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references assessment_jobs (id) on delete cascade,
  category_key text not null,
  raw_score numeric(5, 2) not null check (raw_score >= 0),
  max_points numeric(5, 2) not null check (max_points > 0),
  weighted_score numeric(5, 2) not null check (weighted_score >= 0),
  confidence numeric(3, 2) not null check (confidence between 0 and 1),
  rationale text not null default '',
  supporting_evidence jsonb not null default '[]'::jsonb,
  contradictory_evidence jsonb not null default '[]'::jsonb,
  missing_evidence jsonb not null default '[]'::jsonb,
  is_overridden boolean not null default false,
  override_reason text,
  overridden_by text,
  overridden_at timestamptz,
  -- An override never destroys the machine's answer (ADR-012).
  original_raw_score numeric(5, 2),
  model_version text not null,
  prompt_version text not null,
  rubric_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, category_key),
  constraint score_within_ceiling check (raw_score <= max_points),
  -- An override without a reason is not recordable.
  constraint override_requires_reason check (
    not is_overridden or (override_reason is not null and length(trim(override_reason)) > 0)
  )
);
create index category_scores_job on category_scores (job_id);

create table assessment_summaries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references assessment_jobs (id) on delete cascade,
  total_score numeric(5, 2) not null check (total_score between 0 and 100),
  mean_confidence numeric(3, 2) not null check (mean_confidence between 0 and 1),
  min_confidence numeric(3, 2) not null check (min_confidence between 0 and 1),
  low_confidence boolean not null default false,
  risks jsonb not null default '[]'::jsonb,
  strengths jsonb not null default '[]'::jsonb,
  weaknesses jsonb not null default '[]'::jsonb,
  internal_notes text,
  bugs_found jsonb not null default '[]'::jsonb,
  model_version text not null,
  prompt_version text not null,
  completed_at timestamptz
);

create table consistency_reviews (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references assessment_jobs (id) on delete cascade,
  trigger_reason text[] not null default '{}',
  pass_number integer not null default 2,
  score_delta numeric(5, 2) not null default 0,
  adjusted boolean not null default false,
  detail jsonb not null default '{}'::jsonb,
  reviewed_at timestamptz not null default now()
);

create table manual_review_flags (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  reason_code text not null,
  detail text not null default '',
  raised_by actor_type not null default 'system',
  status review_status not null default 'open',
  resolved_by text,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now()
);
create index manual_review_flags_open on manual_review_flags (submission_id) where status = 'open';

create table disqualifications (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  -- Constrained to the eleven permitted grounds (ADR-017). "Low score",
  -- "weak UI" and "AI suspicion" are not representable in this column.
  reason_code text not null check (reason_code in (
    'late_submission_no_exception',
    'idea_outside_approved_list',
    'missing_product_url',
    'missing_pdf_deck',
    'missing_demo_link',
    'artifact_inaccessible_after_retries',
    'login_required_without_working_credentials',
    'malicious_or_prohibited_content',
    'interference_with_judging',
    'confirmed_false_declaration',
    'confirmed_serious_rule_violation'
  )),
  reason_detail text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  status disqualification_status not null default 'proposed',
  proposed_by actor_type not null default 'system',
  confirmed_by text,
  reversed_by text,
  reversed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reversal_requires_reason check (
    status <> 'reversed' or (reversed_reason is not null and length(trim(reversed_reason)) > 0)
  )
);
create index disqualifications_submission on disqualifications (submission_id);

-- --------------------------------------------------------------------------
-- Ranking and selection
-- --------------------------------------------------------------------------

create table ranking_snapshots (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references cohorts (id) on delete cascade,
  generated_at timestamptz not null default now(),
  rubric_version text not null,
  eligible_count integer not null default 0,
  shortlist_target integer not null default 10,
  is_current boolean not null default false,
  notes text
);
-- Exactly one current snapshot per cohort.
create unique index ranking_snapshots_one_current on ranking_snapshots (cohort_id) where is_current;

create table ranking_entries (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references ranking_snapshots (id) on delete cascade,
  submission_id uuid not null references submissions (id) on delete cascade,
  rank integer not null check (rank > 0),
  total_score numeric(5, 2) not null,
  tiebreak_vector jsonb not null default '{}'::jsonb,
  in_shortlist boolean not null default false,
  mean_confidence numeric(3, 2) not null default 0,
  unique (snapshot_id, submission_id),
  unique (snapshot_id, rank)
);

create table final_selections (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null references cohorts (id) on delete cascade,
  submission_id uuid not null references submissions (id) on delete cascade,
  position integer not null check (position between 1 and 4),
  -- Always 'shared-admin'. No system process writes this table (ADR-018).
  selected_by text not null,
  selection_reason text not null default '',
  selected_at timestamptz not null default now(),
  unique (cohort_id, position),
  unique (cohort_id, submission_id)
);

create table feedback_reports (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references submissions (id) on delete cascade,
  product_summary text not null default '',
  strengths jsonb not null default '[]'::jsonb,
  improvements jsonb not null default '[]'::jsonb,
  bugs jsonb not null default '[]'::jsonb,
  next_seven_day_plan jsonb not null default '[]'::jsonb,
  -- Defaults false and no Version 1 route reads it. Exposure is a deliberate
  -- future decision, not an accident.
  is_exposed_to_participant boolean not null default false,
  generated_at timestamptz not null default now(),
  model_version text not null,
  prompt_version text not null
);

-- --------------------------------------------------------------------------
-- Global
-- --------------------------------------------------------------------------

create table resource_documents (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid references cohorts (id) on delete cascade,
  kind text not null check (kind in ('pitch_template', 'instructions', 'playbook', 'other')),
  title text not null,
  description text not null default '',
  storage_bucket text not null,
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null default 0,
  is_participant_visible boolean not null default false,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type actor_type not null,
  actor_ref text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  cohort_id uuid references cohorts (id) on delete set null,
  before jsonb,
  after jsonb,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now()
);
create index audit_logs_entity on audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_cohort on audit_logs (cohort_id, created_at desc);

-- Append-only. An audit trail that can be rewritten is not an audit trail.
create or replace function reject_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;
create trigger audit_logs_no_update before update or delete on audit_logs
  for each statement execute function reject_audit_mutation();

create table system_settings (
  key text primary key,
  value jsonb not null,
  description text not null default '',
  updated_by text,
  updated_at timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- updated_at maintenance
-- --------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'admin_account', 'cohorts', 'cohort_ideas', 'teams', 'submissions',
    'submission_credentials', 'assessment_jobs', 'category_scores', 'disqualifications'
  ] loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function touch_updated_at()',
      t, t
    );
  end loop;
end;
$$;
