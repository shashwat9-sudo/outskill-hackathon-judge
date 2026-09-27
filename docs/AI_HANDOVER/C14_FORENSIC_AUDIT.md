# AIAP C14 — forensic reconciliation of the judging run

Read-only reconciliation of every AIAP C14 submission against the production records, taken 2026-09-27 (09:30–10:00 UTC), after the judging run and before any human review. Nothing in judging was changed to produce it: no job re-queued, no flag touched, no score or rank altered, no product re-opened. Companion to the new **Export all submissions audit CSV** on the Shortlist page, which produces the same answer per submission on demand.

## Counts (production, cohort `b8141f8e-…` "AIAP C14", external id AIAP-C14)

| Measure | Count |
| --- | --- |
| Sheet rows on "Submissions - AIAP C14" | 69 |
| Superseded rows (a group that resubmitted) | 1 |
| Imported submissions | **68** |
| Assessment jobs | 68 (one per submission) |
| Completed | 56 |
| Failed | 9 |
| Manual review (stage) | 3 |
| Disqualified | 0 |
| Queued / in progress | 0 |
| Submissions with no job | 0 |
| Completed with an incomplete score set | 0 |
| Completed but absent from the current ranking | 0 |
| Ranking snapshot (current, generated 08:42 UTC) | 56 entries, eligible 56, shortlist 10 |
| Feedback reports | 56 ready · 0 pending on completed jobs · 0 failed (12 jobs show `pending` because they never completed) |
| Ranked products carrying an open manual-review flag | 40 (39 low-confidence, 1 prompt-injection notice on rank 21) |

**68 vs 69.** The sheet holds 69 data rows; one group resubmitted, so the intake marks the older row superseded and imports 68. The Judge UI's "68" and the sheet's "69" are both right.

**Why the results export had 56 rows.** "Export results & feedback CSV" is defined over the current ranking snapshot (`listRankedResults`), which contains only submissions with a complete score set and no confirmed disqualification. The 12 products below never produced a score set, so they were never ranking entries and never in that file. That export is unchanged; the audit export is the file that lists everyone.

**Display note.** The Judging page's "overall progress" counters (`getQueueStats`) left-join `browser_test_runs`, so a completed job with two runs is counted twice: it reports 124 jobs / 112 completed for this cohort. The true numbers are 68 / 56. Not changed in this pass.

## The twelve products without a rank

Every reason below is taken from persisted records (job error, preflight check, manual-review flag, stage records) and is exactly what the audit export writes for the row. No product was re-tested.

| Group | Product | Outcome | Stage | Category | What happened | Source / quality |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Marqet-U | Failed | Browser testing (derived) | Internal worker error | Preflight passed, deck analysed, 36-step plan built; the worker was refused database access to the credentials table when it went to log in, so the browser never opened the product. Two runs, both the same error. | Explicit system error / High |
| 6 | Plan2Win | Failed | Browser testing (derived) | Internal worker error | Same as group 1 (37-step plan). | Explicit system error / High |
| 11 | SolVida Campaign Studio | Failed | Browser testing (derived) | Internal worker error | Same as group 1 (44-step plan). | Explicit system error / High |
| 14 | LessonLoop | Failed | Browser testing (derived) | Internal worker error | Same as group 1 (44-step plan; demo link returned 404, recorded as a warning, not a block). | Explicit system error / High |
| 24 | PawCare | Failed | Browser testing (derived) | Internal worker error | Same as group 1 (48-step plan). | Explicit system error / High |
| 49 | SpendWise | Failed | Browser testing (derived) | Internal worker error | Same as group 1 (47-step plan). | Explicit system error / High |
| 70 | Pocket Wise | Failed | Browser testing (derived) | Internal worker error | Same as group 1 (46-step plan). | Explicit system error / High |
| 73 | Pet Care Companion | Failed | Browser testing (derived) | Internal worker error | Same as group 1 (38-step plan). | Explicit system error / High |
| 21 | ActionMeet | Failed | Artifact analysis (derived) | Credential leak guard (fail-closed) | Preflight passed; the written submission still contained a labelled password after redaction, so the worker refused to send it to the model. The guard worked as designed; the product was never tested. | Explicit system error / High |
| 13 | Makeover | Needs human review | Preflight | Product unreachable | The product URL answered 401 (access denied) on both checks although the submission declared open access; routed to a human, not judged. | Explicit system error + preflight record / High |
| 34 | PRISM | Needs human review | Preflight | Product unreachable | No response within 15 s on three checks across two worker runs (the deck link also returned 432); routed to a human, not judged. | Explicit system error + preflight record / High |
| 46 | AIAP — AI-Powered Task Manager | Needs human review | Preflight | Unsupported product type | The product link is a Google Drive folder, not a running web application; routed to a human, not judged. | Manual review flag / High |

No product falls into "reason not recorded".

## Root cause of the eight identical failures (platform, not product)

- Every one of the 11 credential-protected products (`login_required = true`) failed to reach browser testing. The eight above all recorded `permission denied for table submission_credentials`; the other three stopped earlier for their own reasons (groups 21, 34, 46).
- The worker's credential reveal (`revealCredentials` in `packages/shared/src/data/postgres/repositories/submissions.ts`) selects the ciphertext and then **updates** `submission_credentials.last_revealed_at`. Migration 0006 grants the worker role `ohj_worker` **SELECT only** on that table (RLS policy `worker_read_credentials`, SELECT). Production confirms: `ohj_worker` holds SELECT and nothing else, and `last_revealed_at` is null on all 11 C14 credential rows — no reveal has ever succeeded in production.
- Consequence: any product that needs a login cannot be judged automatically until the reveal path and the grant agree (either drop the stamp from the worker path, or grant the worker UPDATE of that one column). This audit does not change either; it is a finding for the platform team, and it means the eight "failed" products are not evidence of anything about those products.
- The worker also retries only twice, not three times, before marking a job failed (`attempt >= maxAttempts` is evaluated with the attempt about to run, so "attempts 2 of 3" is the last one). Not changed here.

## Worker logs

The live worker runs in the Railway project the GitHub integration deploys to ("lucky-dedication"), which is not visible to the Railway account authorised on the preparation machine, so its logs were not readable from here. Every conclusion above rests on database records alone; none needed a log line.

## How to reproduce

1. Admin → Shortlist → **All submissions audit** → "Export all submissions audit CSV" (one row per imported submission, 71 columns).
2. Or, read-only from a machine with `.env.local`: `npx tsx scripts/cohort-readiness.ts --external-cohort-id AIAP-C14` for the counts.
