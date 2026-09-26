# AIAP C14 — judging day runbook

For the Outskill operator running C14 after the 10:00 AM submission deadline. Every step names the screen or command it uses; nothing here is a step the code cannot do. Read `docs/AI_HANDOVER/C14_CHANGES.md` first for what changed and what still needs a manual action before this runbook applies.

Cohort identity used throughout: external id `AIAP-C14` → the Judge cohort named "AIAP C14 Final". Never pick a cohort by name in a script; every command below takes the external id.

## Before 10:00 AM (can be done today)

| # | Step | How | Expect |
| --- | --- | --- | --- |
| 0.1 | Deploy the code changes (web + worker) and apply migration 0014 | see `C14_CHANGES.md` §Deployment | Vercel build green; worker restarted; `cohorts.final_selection_target` exists |
| 0.2 | Bind the cohort and configure the C14 ideas (dry run, then apply) | `npx tsx scripts/configure-cohort-ideas.ts --external-cohort-id AIAP-C14 --cohort-id <uuid of "AIAP C14 Final"> --bind-external-id --final-selection-target 3 --shortlist-target 10 --prompt-version current` then the same with `--apply` | external id bound; 7 created, 1 updated (Collaborative Notetaker), 7 deactivated, all 8 approved; backups in `docs/AI_HANDOVER/C14_*_BEFORE_CHANGE.json` |
| 0.3 | Confirm readiness | `npx tsx scripts/cohort-readiness.ts --external-cohort-id AIAP-C14 --sheet-dry-run` | "no blockers"; category blocks = 0 |
| 0.4 | Confirm the worker's evaluation mode | readiness output, "Judging infrastructure"; or Admin → Judging banner | worker reports `evaluation_mode = production` and a real provider (on 2026-09-26 it reported `openai`, `production`). If it says `synthetic_only`, STOP: set `AI_EVALUATION_MODE=production` on the worker host and restart it |
| 0.5 | Set `judging.enabled` | Admin → Settings → System settings (it is `false` today) | `true` |

## After 10:00 AM

1. **Final sheet dry run.** Admin → Google Sheet intake → "Test connection", then "Check the sheet". Note rows found, ready to import, blocked, resubmitted, superseded. Or run step 0.3 again.
2. **Resolve blocked rows.** Each blocked row names the field and reason (missing product link, unrecognised Access value, unrecognised Category …). Fix in the sheet with the team, then "Check the sheet" again. Rows already imported are reported, not re-imported; a row changed after import is flagged "changed since import" and is a human decision.
3. **Close intake as required.** C14 is fed by the sheet, not by the Judge's own portal, so the cohort does **not** need to be `open`. The cohort must be `closed` before judging can start: Admin → Cohorts → "AIAP C14 Final". From `draft` the only lifecycle path is `draft → open → closed`: press "Open submissions", then immediately "Close submissions" (typed confirmation). Opening exposes the Judge's own `/submit` page for that cohort for the seconds it is open; no team has access codes for C14, so nothing can be submitted through it.
4. **Import submissions.** Admin → Google Sheet intake → "Import final submissions". The import refuses if the sheet changed since the last check (run "Check the sheet" again). Each imported group gets one queued assessment job.
5. **Confirm the job count.** Admin → Judging: the "Submitted" column equals the number of rows imported; Admin → Submissions lists them. The intake report's "Jobs this would create" is the number to match.
6. **Enable judging if required.** Settings → `judging.enabled = true` (step 0.5). "Start judging" refuses otherwise.
7. **Confirm the worker.** Admin → Judging banner reads the worker's own report: provider, model, mode, last seen. A worker silent for 15 minutes is shown as stale — restart it on Railway.
8. **Confirm production evaluation mode.** Same banner: mode must be `production` (C14 is a real cohort; `synthetic_only` refuses every model call and every job ends in manual review).
9. **Start / allow processing.** Admin → Judging → "Start judging" (or Cohorts → "Start judging"). Safe to press again: nothing is queued twice. The cohort moves to `judging`.
10. **Monitor failed and manual-review jobs.** Admin → Judging → "Needs attention". "Retry failed assessment" re-queues one submission; a temporary outage is not a failed product. Manual-review flags are resolved on the submission's "Manual review" tab.
11. **Confirm assessment completion.** Judging → "Overall progress": resolved = total. Anything left is in "Needs attention".
12. **Retry missing feedback.** Judging → "Participant feedback coverage" → "Request missing feedback" (cohort-scoped, idempotent, touches no score). The worker produces reports when its queue is idle; refresh.
13. **Confirm feedback coverage.** Same card: "Feedback ready" = "Completed assessments"; pending/generating/failed all 0. The Shortlist page shows the same numbers next to the export.
14. **Generate the current ranking snapshot.** Admin → Shortlist → "Generate shortlist" (add a note). Every completed, fully scored, not-disqualified submission is ranked; the top 10 is the shortlist.
15. **Run the consistency pass.** Shortlist → "Run second pass" (top 20, low confidence, open reviews, near the cutoff, close ties, disputed). Wait for the re-queued jobs to complete, then "Generate shortlist" again.
16. **Review the Top 10.** Shortlist page: open "Review evidence" on each. Resolve open flags; propose/confirm/reverse disqualifications on the submission page; regenerate the shortlist after any change.
17. **Export all results + feedback.** Shortlist → "Results & feedback export" → rows "All ranked results" → "Export results & feedback CSV". One row per ranked product (all of them), scores per category, winner position, review state, feedback flattened; rows without feedback say `pending`/`failed` rather than disappearing. File: `aiap-c14-results-feedback-<timestamp>.csv`. Internal use only — the file contains the private feedback text.
18. **Select the Top 3 manually.** Admin → Finalists ("Final selection"): three positions, 1st/2nd/3rd, each with a submission from the current ranking and a written reason. "Confirm final selection". Exactly three; two or four are refused. Clearing and re-recording is allowed and logged.
19. **Export the shortlist if required.** Shortlist → "Export shortlist" (the existing top-N CSV, unchanged). Re-export results + feedback after selecting winners if the winner positions are wanted in the file.
20. **Final safety checks.** Readiness script once more (`--external-cohort-id AIAP-C14`): rubric `rubric-v2`, prompt `assessment-prompts-v2`, winners 3 of 3 recorded, feedback coverage complete. Nothing is announced by the system; `participants.results_visible` stays `false`; feedback reports are not exposed to participants. Optionally Cohorts → "Finalise cohort" (destroys stored judge credentials per the retention setting).

## Do not

- Do not "Open submissions" and leave the cohort open past step 3.
- Do not import before the deadline; the fingerprint check refuses a sync when the sheet moved since the check, but it cannot know the deadline.
- Do not change rubric, judging settings or ideas after the first job is claimed: teams would be judged under different conditions.
- Do not run any `scripts/*` that writes without reading its header; every writing script in this repository reads `.env.local` and acts on whatever database it names.
