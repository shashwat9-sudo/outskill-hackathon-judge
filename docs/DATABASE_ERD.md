# Database ERD

PostgreSQL (Supabase). All tables carry `created_at timestamptz not null default now()`; mutable tables also carry `updated_at`. Primary keys are `uuid` with `gen_random_uuid()` unless noted.

---

## 1. Overview

```
                    ┌──────────────────┐
                    │  admin_account   │──1:N──▶ admin_sessions
                    └──────────────────┘

  ┌───────────────┐        ┌────────────────┐
  │ rubric_versions│──1:N──▶│rubric_categories│
  └───────┬───────┘        └────────────────┘
          │ (frozen per cohort)
          ▼
  ┌──────────────┐──1:N──▶ cohort_ideas
  │   cohorts    │──1:N──▶ teams ──1:N──▶ team_members
  └──────┬───────┘           │
         │                   ├──1:1──▶ team_invites
         │                   ├──1:N──▶ team_access_codes    (1 live, versioned)
         │                   ├──1:N──▶ participant_sessions
         │                   │
         │                   └──1:1──▶ submissions ──┬──1:N──▶ submission_artifacts
         │                                           ├──1:1──▶ submission_credentials  (encrypted)
         │                                           ├──1:1──▶ submission_declarations
         │                                           ├──1:N──▶ submission_events
         │                                           ├──1:N──▶ team_activity  (learner-safe)
         │                                           └──1:1──▶ assessment_jobs
         │                                                          │
         │                    ┌─────────────────────────────────────┤
         │                    ▼                                     │
         │            preflight_checks (1:N)                        │
         │            artifact_analyses (1:1)                       │
         │            test_plans (1:1) ──1:N──▶ test_plan_steps     │
         │            browser_test_runs (1:N) ─1:N─▶ browser_test_steps
         │            assessment_evidence (1:N)                     │
         │            category_scores (1:N, 8 rows)                 │
         │            assessment_summaries (1:1)                    │
         │            consistency_reviews (1:N)                     │
         │            manual_review_flags (1:N)                     │
         │            disqualifications (1:N)                       │
         │            feedback_reports (1:1)                        │
         │
         ├──1:N──▶ ranking_snapshots ──1:N──▶ ranking_entries
         └──1:1──▶ final_selections (exactly 4 rows when complete)

  resource_documents · audit_logs · system_settings · verification_attempts  (global)
```

---

## 2. Identity and access

### `admin_account`
Exactly one row, enforced by a partial unique index on a constant — a second admin account is a schema error, not a policy.

`id · username (unique, citext) · password_hash (argon2id) · password_updated_at · failed_attempts · locked_until · last_login_at`

### `admin_sessions`
`id · admin_id → admin_account (cascade) · session_token_hash (unique) · issued_at · expires_at · rotated_from · ip_hash · user_agent_hash · revoked_at`

Only hashes stored. Rotation on login links the new session to the old via `rotated_from`.

---

## 3. Cohorts, ideas, rubric

### `cohorts`
`id · name · code (unique) · description · timezone (default 'Asia/Kolkata') · day12_start_at · day13_deadline_at · shortlist_target (default 10) · submission_instructions · rubric_version_id → rubric_versions · assessment_config (jsonb) · status · finalised_at · closed_at · closure_type · accepting_until`

`status ∈ {draft, open, paused, closed, judging, finalised, archived}` — CHECK-constrained; transitions validated in application code against an explicit table.

`assessment_config` holds per-cohort worker settings (concurrency, per-submission budget, retry counts, consistency-pass triggers) so a cohort's judging parameters are frozen with it.

`closed_at` records when submissions actually stopped being accepted and `closure_type ∈ {manual, deadline}` records how — an admin pressed close, or the clock did it.

`accepting_until` is the reopening lever. It is set when an admin reopens **after** the official deadline, and writes are accepted until that instant even though `day13_deadline_at` has passed. A CHECK requires it to be later than `day13_deadline_at`, because a value before the deadline could only ever mean a mistake. Without this column, "reopened" would be a status that still rejects every save.

Stored status is never the whole answer: acceptance is computed from the server clock on every write (`computeSubmissionWindow`), so a cohort still marked `open` past its effective deadline stops accepting writes at that instant whether or not a reconciliation job ever ran.

### `cohort_ideas`
`id · cohort_id → cohorts (cascade) · title · slug · description · target_user · expected_use_case · minimum_core_flow (jsonb) · expected_entities (text[]) · ai_opportunity · allowed_scope · unsafe_interpretations · display_order · is_active · definition_status · definition_approved_at · definition_approved_by`

Unique `(cohort_id, slug)`. Ideas are **per cohort**, so editing next cohort's ideas cannot retroactively change how a past cohort was judged.

`definition_status ∈ {draft, approved}`, defaulting to `draft`. Title and description come from the approved source catalogue and are always usable; the expanded fields — minimum core flow, expected entities, AI opportunity, allowed scope, unsafe interpretations, target user, expected use case — are Outskill's interpretation and influence real judging only once approved (ADR-025). Editing any of them returns the row to `draft`, so an approval always refers to the wording someone actually read. A column comment on the table says the same thing, for whoever meets this in psql rather than here.

### `rubric_versions` / `rubric_categories`
`rubric_versions: id · version (unique) · name · is_active · notes`
`rubric_categories: id · rubric_version_id (cascade) · key · title · description · max_points · display_order`

Unique `(rubric_version_id, key)`. A deferred constraint trigger asserts `sum(max_points) = 100` per version — the rubric cannot be saved in an invalid state.

---

## 4. Teams and access

### `teams`
`id · cohort_id → cohorts (cascade) · group_number · lead_name · lead_email · lead_phone · status · imported_at`

Unique `(cohort_id, group_number)` — the historical duplicate-group problem becomes impossible.

### `team_members`
`id · team_id → teams (cascade) · full_name · contribution · display_order · is_active`

### `team_invites`
`id · team_id → teams (cascade) · token_hash (unique) · token_prefix · issued_at · expires_at · revoked_at · last_accessed_at · access_count`

Only the hash is stored. `token_prefix` (first 8 chars) exists solely so admins can identify a token in the UI without it being usable. Production teams use the common `/submit` entry below; this table now serves the demo fixtures and any invite distributed before that existed.

### `team_access_codes`
`id · team_id → teams (cascade) · cohort_id → cohorts (cascade) · group_number · code_hash (argon2id) · version (default 1) · created_at · revoked_at · last_verified_at · verify_count`

The credential a production team actually uses, with the group number. **There is deliberately no column that could hold plaintext** — a code is shown once, at generation, and after that no query, no admin screen and no export can produce it. Losing one means issuing a new one.

`version` is the revocation lever: incrementing it invalidates every session minted under the old code without having to find those sessions. Unique `(team_id, version)`, plus a partial unique index on `team_id where revoked_at is null` so a team can never have two live codes. Indexed on `(group_number, cohort_id)` — the lookup on the verification hot path.

### `participant_sessions`
`id · team_id → teams (cascade) · cohort_id → cohorts (cascade) · session_token_hash (unique) · editor_name · editor_role · access_code_version · created_at · last_active_at · expires_at · revoked_at · ip_hash`

Only the hash; the cookie value never lands in the database. `editor_name` is an **activity label, not verified identity** — anyone holding the shared code can type any name, and nothing security-relevant may depend on it.

`access_code_version` is compared against the team's live code on every resolve, which is what makes regeneration a one-row revocation of every open session. Partial indexes on `team_id` and `expires_at` where `revoked_at is null` cover the two questions asked of this table: who is editing now, and what has expired.

### `verification_attempts`
`id · cohort_id → cohorts (cascade, nullable) · group_number · ip_hash · attempts · window_started_at · locked_until · updated_at`

Rate-limit state for `/submit`. Unique `(ip_hash, group_number)` — keyed on **both** so one hostile client cannot lock out a legitimate team, and one team fumbling its code cannot lock out an office behind a shared address. Eight attempts per fifteen minutes, then a fifteen-minute lockout an admin can clear. Partial index on `locked_until` where set, so finding current lockouts does not scan the table.

---

## 5. Submissions

### `submissions`
```
id · cohort_id → cohorts · team_id → teams (cascade)
status ∈ {draft, submitted, locked, reopened, withdrawn}
idea_id → cohort_ideas
-- product
product_name · primary_user · exact_problem · one_sentence_promise · brief_description
why_ai_necessary · differentiation · must_have_workflow
should_have_features (text[], length ≤ 2) · excluded_features
-- live product
product_url · login_required (bool) · core_test_steps (jsonb) · safe_sample_inputs
reset_instructions · known_limitations
-- learning evidence
bugs_fixed (jsonb, 3 entries) · deliberately_excluded · major_tradeoff
day12_to_day13_changes · most_important_learning · next_seven_day_plan
builder_stack · apis_used · external_templates
-- lifecycle
draft_updated_at · submitted_at · receipt_id (unique) · locked_at
reopened_at · reopened_reason · is_late (generated)
-- shared editing
version (default 1) · last_edited_by · submitted_by_name
```

**Unique `(cohort_id, team_id)`** — one submission per team per cohort, enforced by the database.

`is_late` is computed by comparing `submitted_at` against the cohort deadline; lateness is a *fact*, and whether it disqualifies is a separate admin decision.

`version` carries optimistic concurrency. Every write states the version it read; a write that is behind is refused rather than allowed to overwrite a teammate silently, and the client reloads. `last_edited_by` and `submitted_by_name` hold editor **labels**, not identities — they exist so a team can see who changed what and so an admin can answer "who pressed submit", not so anything can be attributed.

### `submission_artifacts`
`id · submission_id (cascade) · kind ∈ {deck_pdf, demo_video, transcript, screenshot} · storage_bucket · storage_path · original_filename · mime_type · byte_size · checksum_sha256 · external_url · upload_completed_at · is_accessible · last_checked_at`

Uploads and external links share a table but not a column: files use `storage_path`, links use `external_url`, and a CHECK requires exactly one.

### `submission_credentials`
`id · submission_id (cascade, unique) · username_ciphertext (bytea) · password_ciphertext (bytea) · iv (bytea) · auth_tag (bytea) · key_version · login_instructions_ciphertext (bytea) · deleted_at · last_revealed_at`

No plaintext column exists. AES-256-GCM; `key_version` supports key rotation. `deleted_at` supports post-finalisation destruction while retaining the audit fact that credentials existed.

### `submission_declarations`
Seven booleans, all required true to submit, plus `accepted_at` and `accepted_ip_hash`.

`built_during_hackathon · owned_by_team · external_material_disclosed · judge_may_modify_demo_data · no_real_customer_data · urls_available_through_judging · permission_to_submit`

### `submission_events`
Append-only participant-visible history: `id · submission_id (cascade) · event_type · actor_type ∈ {participant, shared-admin, system} · detail (jsonb)`.

### `team_activity`
`id · submission_id (cascade) · team_id (cascade) · kind · editor_name · section · created_at`

What a team is shown about itself, and the reason it is a separate table from `audit_logs`: this one is rendered **back to learners**, so it carries only a closed set of participant-safe events. `kind` is CHECK-constrained to `draft_opened · section_saved · deck_replaced · demo_link_saved · review_opened · final_submitted` — an event kind that does not belong in the learner portal cannot be written here even by mistake. The internal audit log keeps everything else: admin actions, credential reveals, disqualification steps.

Indexed `(submission_id, created_at desc)` — the portal reads the most recent handful and nothing else.

---

## 6. Assessment pipeline

### `assessment_jobs`
```
id · submission_id → submissions (cascade, unique) · cohort_id
stage ∈ {queued, preflight, artifact_analysis, test_plan_generation, browser_testing,
         evidence_review, scoring, consistency_review, completed,
         manual_review, failed, disqualified}
priority (int) · attempt_count · max_attempts
claimed_by · claimed_at · lease_expires_at · heartbeat_at
started_at · completed_at · last_error · next_attempt_at
```

Indexes: `(stage, priority, next_attempt_at)` for claiming; partial index on live leases for the expiry sweep.

Claim query:
```sql
UPDATE assessment_jobs SET claimed_by = $1, claimed_at = now(),
       lease_expires_at = now() + $2::interval
WHERE id IN (
  SELECT id FROM assessment_jobs
  WHERE stage NOT IN ('completed','failed','disqualified','manual_review')
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
    AND (next_attempt_at IS NULL OR next_attempt_at <= now())
  ORDER BY priority DESC, created_at
  FOR UPDATE SKIP LOCKED
  LIMIT $3
) RETURNING *;
```

### `preflight_checks`
`id · job_id (cascade) · check_key · status ∈ {pass, fail, warn, skipped} · attempt_number · failure_class ∈ {timeout, dns, auth, server, blocked, invalid, none} · detail (jsonb) · checked_at`

One row **per attempt**, not per check — every retry is preserved, which is what makes "temporary outage, not a broken product" arguable after the fact.

### `artifact_analyses`
`id · job_id (cascade, unique) · deck_page_count · deck_text_extracted · deck_analysis (jsonb) · video_analysis_limited (bool) · video_limitation_reason · transcript_available · written_analysis (jsonb) · injection_flags (jsonb) · model_version · prompt_version`

`video_analysis_limited` is a first-class column, not a note — the system must be able to say "we could not see the video" rather than invent content.

### `test_plans` / `test_plan_steps`
`test_plans: id · job_id (cascade, unique) · generated_from (jsonb) · step_count · estimated_duration_ms · model_version · prompt_version · validation_status · rejected_steps (jsonb)`

`test_plan_steps: id · test_plan_id (cascade) · step_index · action (CHECK against the permitted DSL union) · target (jsonb) · value · expectation (jsonb) · is_cleanup · rationale`

The `action` CHECK constraint is the last line of the DSL containment: a step outside the union cannot be stored, even if application validation were bypassed.

### `browser_test_runs` / `browser_test_steps`
`browser_test_runs: id · job_id (cascade) · viewport ∈ {desktop, mobile} · started_at · finished_at · duration_ms · status · browser_version · trace_path · console_error_count · network_failure_count · a11y_violation_count · a11y_summary (jsonb) · cleanup_status · timed_out (bool)`

`browser_test_steps: id · run_id (cascade) · step_index · action · status ∈ {passed, failed, skipped, error} · duration_ms · screenshot_path · assertion_detail (jsonb) · error_message`

### `assessment_evidence`
`id · job_id (cascade) · category_key · evidence_type ∈ {browser_step, screenshot, console, network, a11y, deck, written, video, preflight} · stance ∈ {supporting, contradictory, missing} · summary · source_ref (jsonb) · confidence`

The join table that makes "every score has evidence" checkable with a query rather than by trust.

### `category_scores`
`id · job_id (cascade) · category_key · raw_score · max_points · weighted_score · confidence (0–1) · rationale · supporting_evidence (jsonb) · contradictory_evidence (jsonb) · missing_evidence (jsonb) · is_overridden · override_reason · overridden_by · overridden_at · original_raw_score · model_version · prompt_version · rubric_version_id`

Unique `(job_id, category_key)`. An override never destroys the machine's answer — `original_raw_score` is preserved, so the delta between machine and human is always inspectable.

### `assessment_summaries`
`id · job_id (cascade, unique) · total_score · mean_confidence · min_confidence · low_confidence (bool) · risks (jsonb) · strengths (jsonb) · weaknesses (jsonb) · internal_notes · bugs_found (jsonb) · model_version · prompt_version · completed_at`

### `consistency_reviews`
`id · job_id (cascade) · trigger_reason ∈ {top20, low_confidence, manual_review, near_cutoff, close_tie, disputed} · pass_number · score_delta · adjusted (bool) · detail (jsonb) · reviewed_at`

### `manual_review_flags`
`id · submission_id (cascade) · reason_code · detail · raised_by ∈ {system, shared-admin} · status ∈ {open, resolved, dismissed} · resolved_by · resolved_at · resolution_note`

### `disqualifications`
`id · submission_id (cascade) · reason_code (CHECK against the permitted list) · reason_detail · evidence (jsonb) · status ∈ {proposed, confirmed, reversed} · proposed_by · confirmed_by · reversed_by · reversed_reason`

`reason_code` is CHECK-constrained to the eleven permitted grounds. "Low score" cannot be stored as a disqualification reason — the schema forbids it.

---

## 7. Ranking and selection

### `ranking_snapshots` / `ranking_entries`
`ranking_snapshots: id · cohort_id (cascade) · generated_at · rubric_version_id · eligible_count · shortlist_target · is_current · notes`

`ranking_entries: id · snapshot_id (cascade) · submission_id · rank · total_score · tiebreak_vector (jsonb) · in_shortlist (bool) · mean_confidence`

Unique `(snapshot_id, submission_id)` and `(snapshot_id, rank)`. Snapshots are immutable; re-ranking creates a new one and flips `is_current`, so the ranking a decision was made against remains reconstructable.

### `final_selections`
`id · cohort_id (cascade) · submission_id · position ∈ {1,2,3,4} · selected_by (always 'shared-admin') · selection_reason · selected_at`

Unique `(cohort_id, position)` and `(cohort_id, submission_id)`. A CHECK bounds `position` to 1–4, and finalisation requires exactly four rows. **No system process writes this table** — it is admin-action-only by construction.

### `feedback_reports`
`id · submission_id (cascade, unique) · product_summary · strengths (jsonb, 3) · improvements (jsonb, 3) · bugs (jsonb) · next_seven_day_plan (jsonb) · is_exposed_to_participant (bool, default false) · generated_at · model_version · prompt_version`

`is_exposed_to_participant` defaults false and no Version 1 route reads it — the flag exists so exposure is a deliberate future decision.

---

## 8. Global

### `resource_documents`
`id · cohort_id (nullable → global) · kind ∈ {pitch_template, instructions, playbook, other} · title · storage_bucket · storage_path · mime_type · byte_size · is_participant_visible · display_order`

The only table with a participant-visible flag on stored files, and it holds templates and instructions — never assessment material.

### `audit_logs`
`id · actor_type ∈ {shared-admin, participant, system, worker} · actor_ref · action · entity_type · entity_id · cohort_id · before (jsonb) · after (jsonb) · ip_hash · user_agent_hash · created_at`

Append-only: no UPDATE or DELETE grant to the application role. Indexed on `(entity_type, entity_id)` and `(cohort_id, created_at)`.

### `system_settings`
`key (pk) · value (jsonb) · description · updated_by · updated_at`

Runtime-tunable operational settings (worker concurrency, retry policy, per-submission budget, consistency triggers, retention windows). Secrets never live here — they come from the environment.

---

## 9. Row-level security

RLS is enabled and forced on every table. Three roles:

| Role | Grant |
| --- | --- |
| `ohj_participant` | Read/write **only** their own submission tree, resolved from a verified session. No SELECT policy exists on any `assessment_*`, `category_scores`, `ranking_*`, `final_selections`, or `feedback_reports` table — the policy is absent, so the answer is always zero rows. |
| `ohj_admin` | Full access, gated by a verified shared-admin session. |
| `ohj_worker` | Read submissions and write assessment tables. No access to `admin_account`, `admin_sessions`, or `audit_logs` beyond append. |

### The four entry tables

| Table | `ohj_admin` | `ohj_participant` | `ohj_worker` |
| --- | --- | --- | --- |
| `team_access_codes` | full | **no policy** | none |
| `participant_sessions` | full | **no policy** | none |
| `verification_attempts` | full | **no policy** | none |
| `team_activity` | full | SELECT, own team only (`team_id = current_team_id()`) | none |

The three absences are the point, and the migration says so where someone would otherwise add one. Verification and session handling run server-side with elevated privilege; a participant role able to SELECT `team_access_codes` could enumerate every group in the cohort, which is exactly what the single generic error message on `/submit` exists to prevent. The worker has no policy on any of the four either — assessment never needs to know who was signed in or how they got there.

Grants match the policies rather than exceeding them: `ohj_participant` holds `select` on `team_activity` and nothing on the other three, because a grant that promises more than a policy allows reads as an intention nobody implemented. `delete` is revoked from every application role on all four, as elsewhere: nothing is deleted through the application.

Application-layer authorisation is the primary control; RLS is defence in depth. Both must agree, and the negative E2E tests assert the participant boundary from the outside.

## 10. Indexing

Beyond primary and foreign keys:

- `submissions (cohort_id, status)` — admin submission lists
- `submissions (receipt_id)` — receipt lookup
- `assessment_jobs (stage, priority, next_attempt_at)` — queue claim
- `assessment_jobs (lease_expires_at)` partial where leased — expiry sweep
- `category_scores (job_id)` — score assembly
- `ranking_entries (snapshot_id, rank)` — ranking page
- `audit_logs (entity_type, entity_id)` and `(cohort_id, created_at)` — history tabs
- `team_invites (token_hash)` — the invite path
- `team_access_codes (group_number, cohort_id)` — the participant hot path, and `(team_id) where revoked_at is null` unique, so one live code per team is a constraint rather than a convention
- `participant_sessions (team_id)` and `(expires_at)`, both partial where not revoked — who is editing now, and what has expired
- `team_activity (submission_id, created_at desc)` — the portal's activity panel
- `verification_attempts (ip_hash, group_number)` unique and `(locked_until)` partial where set — rate-limit reads on every verification attempt

At 500 submissions per cohort every table is small; indexes are for predictable latency under concurrent worker claims, not for data volume. The exception is the verification path, which is hit hardest exactly when several hundred teams arrive in the same hour.
