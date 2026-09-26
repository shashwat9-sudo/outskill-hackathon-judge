# AIAP C14 production-readiness — what changed and what is still manual

Prepared 2026-09-26 for the C14 deadline of 2026-09-27 10:00 AM. Companion to `C14_RUNBOOK.md` (the operator's sequence for tomorrow).

## Root causes found (verified against the production database, read-only)

1. **C14 holds the C13 ideas.** `createCohortAction` clones the ideas of the most recently created other cohort into a new one (`apps/web/src/server/admin-actions.ts`, "Seed the approved ideas so a new cohort is immediately usable"), so "AIAP C14 Final" (created 2026-09-23 through the admin screen) received the eight C13-era seeds as drafts: Recipe Sharing App … Travel Itinerary Planner. Production shows exactly those 8 active, unapproved ideas on the C14 cohort.
2. **No cohort is mapped to `AIAP-C14`.** "AIAP C14 Final" has `external_cohort_id = NULL`. The admin creation path never sets the external id; only the partner sync does, and only when it *creates* a cohort. Sheet intake finds no mapped cohort and therefore checks Categories against the original seed list — which is the "Category — Does not match one of the approved ideas" every C14 row shows. Worse, pressing **Import** tomorrow in this state would make the sync **create a second cohort** ("AIAP C14", closed, with the C13 seeds) rather than use "AIAP C14 Final".
3. **C14 metadata is off.** `shortlist_target = 80` (must be 10: the ~80 products are the judged pool, not the shortlist) and `assessment_config.promptVersion = 'assessment-prompts-v1'` while the prompts are v2. Rubric is `rubric-v2` (correct, unchanged).
4. **The winner count was a constant (4)** in code, page copy and a `position between 1 and 4` CHECK.
5. **Migration 0014 is not yet applied** in production (`cohorts.final_selection_target` does not exist), so the new code must not be deployed before the migration.

Facts about the intended target cohort (from the read-only check): id `b8141f8e-edd9-47bb-b048-3d4ae961d1d0`, name "AIAP C14 Final", code "AIAP C14", status `draft`, 0 submissions, 0 jobs, `is_synthetic = false`. C13 ("AIAP C13 Final", external `AIAP-C13`, 83 submissions, archived) is untouched by anything here.

## Code changes

| Area | Change | Files |
| --- | --- | --- |
| Winners per cohort | `cohorts.final_selection_target` (default 4, historical); `validateFinalSelection(…, target)`; both drivers read the cohort's value; Finalists page renders N slots labelled 1st/2nd/3rd; settings field "Winners to select"; overview checklist and copy no longer say "four" | `supabase/migrations/0014_final_selection_target.sql`, `packages/shared/src/domain/ranking.ts`, `data/types.ts`, `data/store.ts`, `repositories/admin.ts`, `repositories/ranking.ts`, `data/memory/store.ts`, `apps/web/src/app/admin/final-selection/page.tsx`, `settings/page.tsx`, `page.tsx`, `onboarding.tsx`, `server/admin-actions.ts` |
| C14 idea catalogue | Declared catalogue (`config/cohort-ideas/aiap-c14.ts`), pure reconcile/apply logic (`domain/idea-catalogue.ts`), operator script `scripts/configure-cohort-ideas.ts` (dry-run default, `--apply`, exact external id, `--cohort-id … --bind-external-id` for the unmapped case, backups, idempotent, deactivate-not-delete, approves) | as named |
| Intake | Sheet check uses the declared catalogue for the configured external id when no cohort is mapped yet; a cohort the sync creates for a declared external id gets that catalogue (drafts) and its settings (shortlist 10, winners 3) | `intake/sheet-sync.ts`, `repositories/partner.ts`, `data/postgres/bootstrap.ts` |
| Feedback coverage | `getFeedbackCoverage(cohortId)` on both drivers; "Participant feedback coverage" card on Judging (completed / ready / pending / generating / failed) and a summary on Shortlist; cohort-wide "Request missing feedback" action (`retryMissingFeedbackAction`, idempotent, audited, feedback columns only) | `repositories/assessment-judgment.ts`, `data/memory/store.ts`, `apps/web/src/app/admin/assessment-queue/page.tsx`, `ranking/page.tsx`, `server/admin-actions.ts` |
| Results + feedback CSV | `listRankedResults(cohortId)` on both drivers; `domain/results-export.ts` (columns, flattening, scopes all/shortlist/top N, formula guard, BOM); admin-only `exportResultsFeedbackAction`; "Results & feedback export" card on Shortlist. Existing shortlist export unchanged | `repositories/ranking.ts`, `data/memory/store.ts`, `domain/results-export.ts`, `apps/web/src/app/admin/ranking/results-export.tsx`, `server/admin-actions.ts` |
| Prompt version | `createCohortAction` stamps `PROMPT_VERSION` from `@ohj/ai`; demo fixture aligned; regression test | `server/admin-actions.ts`, `fixtures/demo.ts`, `packages/ai/src/prompt-version.test.ts` |
| Readiness | `scripts/cohort-readiness.ts` (read-only): cohort, ideas, settings, queue/feedback counts, worker report, blockers; `--sheet-dry-run` runs the real intake dry run | as named |
| Docs | ADR-033 in `docs/DECISIONS.md`; `C14_RUNBOOK.md`; this file | |

Not changed: rubric-v2 (weights, categories, tie-breaks), prompts, browser DSL, worker leases, evidence storage, SSRF/egress, participant auth, Google auth, disqualification rules, AI provider abstraction.

## Feedback behaviour (verified in code)

`generateFeedbackForSubmission` runs at the end of every completed scoring stage for every submission (`apps/worker/src/pipeline.ts`), not only ranked or shortlisted ones, and again on the worker's idle sweep for any completed job whose `feedback_status` is `pending` (`apps/worker/src/index.ts`). It is separately recorded (`feedback_status`, `feedback_error`, `feedback_attempts`, migration 0013), retried up to 3 times, and never changes a score or a rank. The new cohort-wide retry only sets `pending` on completed jobs without a report; the worker does the rest.

## Deployment — in this order

Nothing below was executed from this environment (no Supabase, Vercel or Railway CLI session is available here, and the production-safety rule stops the cohort mutation until the external id is confirmed and bound).

1. **Commit and push** the working tree (`git status` shows the files above; `git` is not usable from the machine this was prepared on).
2. **Apply migration 0014 to production first** — `supabase db push` from the linked project, or paste `supabase/migrations/0014_final_selection_target.sql` into the SQL editor. It is additive: adds `cohorts.final_selection_target` (default 4) and widens the `final_selections.position` check. No data changes. Verify: `select final_selection_target from cohorts limit 1`.
3. **Deploy the web app** (`vercel deploy --prod`, the project's established path; `.vercelignore` excludes tests and env). The new code reads the new column; deploying before step 2 would break cohort creation and the Finalists page.
4. **Redeploy the worker** on Railway (same commit). The worker does not read the new column, but it bundles `@ohj/shared`; keep the versions aligned.
5. **Bind and configure C14** from a machine with `.env.local` (dry run, read the plan, then `--apply`):
   ```
   npx tsx scripts/configure-cohort-ideas.ts --external-cohort-id AIAP-C14 \
     --cohort-id b8141f8e-edd9-47bb-b048-3d4ae961d1d0 --bind-external-id \
     --shortlist-target 10 --final-selection-target 3 --prompt-version current
   npx tsx scripts/configure-cohort-ideas.ts --external-cohort-id AIAP-C14 \
     --cohort-id b8141f8e-edd9-47bb-b048-3d4ae961d1d0 --bind-external-id \
     --shortlist-target 10 --final-selection-target 3 --prompt-version current --apply
   ```
   The dry run against production today produced exactly: bind `AIAP-C14`; create 7, update 1 (Collaborative Notetaker), deactivate 7; shortlist 80 → 10; prompt v1 → v2. Backups: `docs/AI_HANDOVER/C14_IDEAS_BEFORE_CHANGE.json` (written today by the dry run) and `C14_FINAL_SELECTION_BEFORE_CHANGE.json` (written when `--final-selection-target` runs).
6. **Check readiness**: `npx tsx scripts/cohort-readiness.ts --external-cohort-id AIAP-C14 --sheet-dry-run` → "no blockers", category blocks = 0.
7. **Worker evaluation mode**: confirmed today from the worker's own report — `railway-judging-worker-1`, provider `openai`, model `gpt-5.6-terra`, `evaluation_mode = production`, demo `false`, concurrency 1, seen within the minute. Re-check on the Judging banner tomorrow (a worker silent for 15 minutes shows as stale).
8. **`judging.enabled` is `false`** in production today. Set it to `true` on Settings → System settings before "Start judging" (it refuses otherwise).
9. Optional: set `GOOGLE_SHEETS_COHORT_NAME=AIAP C14 Final` on Vercel if the display name should survive Import (the sync refreshes the name from that variable). Note the local `.env.local` on the preparation machine still names the C13 tab and `AIAP-C13`; the production (Vercel) values are the ones the user set to C14.

## Verified today, read-only

- **C14 sheet ("Submissions - AIAP C14")**, checked with the real intake code and the new declared-catalogue fallback: 2 data rows, 2 valid, 0 blocked, **category blocks 0**, other blocks 0, resubmitted 0, superseded 0, already imported 0, jobs a sync would create 2. Nothing was imported.
- **Configuration dry run** on cohort `b8141f8e-…` ("AIAP C14 Final"): would bind `AIAP-C14`; create 7 ideas, update Collaborative Notetaker in place (description, target user, use case, core flow, entities, AI opportunity, scope, unsafe interpretations, order 6 → 3), deactivate 7 C13 ideas; shortlist 80 → 10; prompt metadata v1 → v2. Winner target needs migration 0014 first. Nothing was written.
- **Worker**: live, OpenAI, production mode (above). **Rubric**: `rubric-v2`, unchanged. **C13**: untouched.
- Remaining blockers before judging: cohort not bound (step 5); migration 0014 not applied (step 2); `judging.enabled` false (step 8).

## Tests (run 2026-09-26 on the preparation machine)

- `npm run lint`: clean. `npm run typecheck`: clean (all four workspaces), plus an ad-hoc `tsc` over the two new scripts.
- `npx vitest run`: 100 files passed, 1 skipped (the multi-connection queue proof, which needs `TEST_DATABASE_URL`); 1,873 tests passed, 5 skipped, 0 failed. Includes the 10 real-Chromium worker tests.
- `npm run build` (demo mode): compiled.
- `npx playwright test` (hermetic demo build): 157 passed, 2 failed on the first run — one Shortlist-page copy I had added ("winner position"), one pre-existing expectation still using the rubric-v1 title "Core workflow functionality". Both fixed; the affected specs re-run: 34 passed. Net: all 159 e2e tests pass.
- Not run: `test:acceptance` and `test:staging` (they write to a real database or need a deployed build).

New/updated: `domain/results-export.test.ts`, `domain/idea-catalogue.test.ts`, `config/cohort-ideas/aiap-c14.test.ts`, `data/postgres/idea-catalogue.test.ts`, `data/postgres/results-export.test.ts`, `data/postgres/ranking.test.ts` (three-winner cohort), `domain/domain.test.ts`, `data/memory/store.test.ts`, `intake/sheet-sync.test.ts`, `packages/ai/src/prompt-version.test.ts`, `apps/web/src/server/results-export-auth.test.ts`, e2e `admin.spec.ts` / `screenshots.spec.ts`.
