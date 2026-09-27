# AIAP C14 — recovery of the platform-failed assessments and the final ranking

Executed 2026-09-27 from 09:40 UTC. Companion to `C14_FORENSIC_AUDIT.md` (what was found) and `C14_PRE_RECOVERY_SNAPSHOT.json` (the state before anything below ran). Every step below used an existing store method or admin-action equivalent; no score, rank or flag was written by hand.

## 1. Platform bug — credential reveal (migration 0015)

**Root cause.** `revealCredentials` (`packages/shared/src/data/postgres/repositories/submissions.ts`) selects the ciphertext and then writes `submission_credentials.last_revealed_at`. Migration 0006 grants `ohj_worker` SELECT only on that table and 0002's RLS policy for the worker is SELECT only. Every production reveal by the worker therefore failed with `permission denied for table submission_credentials` at the start of browser testing, and each credential-protected product was marked failed after two runs. No C14 credential row had ever been stamped.

**Fix (least privilege).** `supabase/migrations/0015_worker_credential_reveal_stamp.sql`:

- `grant update (last_revealed_at) on submission_credentials to ohj_worker` — one column; a write naming a ciphertext column, `deleted_at`, `updated_at`, or an insert/delete is still refused by the grant layer.
- policy `worker_stamp_credential_reveal … for update to ohj_worker using (deleted_at is null) with check (deleted_at is null)` — RLS is forced on the table, so the row set is limited to live records.
- No change to encryption, decryption, the reveal code, the admin path or the participant path.

**Verified.** PGlite regression tests (`worker-privileges.test.ts`, "the credential reveal stamp (0015)") run the real reveal path as `ohj_worker`, confirm the stamp is written, and try every forbidden write (three ciphertext columns, `deleted_at`, `updated_at`, insert, delete, stamping a deleted row) and the admin path. Applied to production 09:51 UTC after confirming the project identity (`eoxf…glr`) and preconditions; afterwards the worker holds SELECT plus UPDATE(last_revealed_at) and the two policies. C13's nine credential rows untouched.

## 2. Platform bug — the credential guard refused scrubbed text

**Root cause.** `redactText` replaces a labelled password with `password: [REMOVED]` (label kept). `assertNoCredentialShapedContent` strips `[… REMOVED]` markers and re-tests the text, so whatever followed the scrubbed value on the same line — or debris when an earlier pattern had already replaced part of the value — matched "a labelled password" and the payload was refused although it held no credential.

**Group 21 (ActionMeet) determination.** Traced with the stored fields and the real deck (fetched the way the worker fetches it), printing no values:

- The stored learner text fields contain no credential-shaped text; the guard did not fire on them.
- The deck's last slide ("Thank You") lists the demo login: `User ID: …` and `password: …`. The labelled value equals the stored judge password (the team put their own demo credentials on the slide). Redaction removed the value completely.
- The guard fired on the residue `password:  REMOVED]$` — marker debris, not a credential. With the corrected guard, no credential shape remains anywhere in the redacted deck or written text.

Classification: **learner-authored credential material, fully redacted; the refusal was a platform false positive in the guard.** The corrected guard still refuses any unredacted credential (tests in `packages/ai/src/redaction.test.ts`), so the rerun did not bypass it: the model received the same scrubbed text every other submission that mentions a password receives.

**Fix.** `assertNoCredentialShapedContent` drops a scrubbed label-and-marker pair whole before stripping remaining markers. Regression tests cover the group 21 residue, trailing text after a scrubbed password, a real value that must still be refused, and the other shapes. The existing `credential-boundary.test.ts` (no credential field can reach an AI payload) is unchanged and passing.

## 3. Deployment

Commit `2108eeb` (migration file, guard fix, tests, pre-recovery snapshot) pushed 09:52 UTC. Vercel promoted it; the Railway worker (project "lucky-dedication") rebuilt and restarted at 09:53 UTC on that commit with nothing leased. No second worker.

## 4. Controlled rerun

Queued 09:54 UTC through `assessment.enqueueSubmission` — the same call as the admin "Retry failed assessment" button — for groups 1, 6, 11, 14, 24, 49, 70, 73 (migration 0015) and 21 (guard fix). Nothing else was re-queued. The rejudge path keeps `attempt_count` (audit trail), keeps every earlier preflight check and browser run (stamped by attempt), raises the allowance to `attempt_count + 3`, and resets the stage to `queued`; nothing was deleted and no learner payload changed. One `audit_logs` row per submission records the before/after state and the reason.

Outcomes are appended in section 6 once the worker finishes.

## 5. Ranking, consistency pass, exports

- New ranking snapshot generated with `ranking.generateSnapshot` (previous snapshots preserved); eligibility unchanged: complete score set, submitted/locked, no confirmed disqualification.
- Consistency pass queued exactly as `runConsistencyPassAction` selects it (`selectForConsistencyReview`: top of the ranking, low confidence, open manual review, near the cutoff, close ties, disputed), run by the worker's `consistency_review` stage, which adjusts only through `overrideScore` with actor `system:consistency`; then the snapshot regenerated.
- Final files written to `exports/` (git-ignored): `AIAP-C14-FINAL-RESULTS-AUDIT.csv` (team sheet, 68 rows), `AIAP-C14-FINAL-RANKED-RESULTS.csv` (ranked entries only), `AIAP-C14-ALL-SUBMISSIONS-AUDIT.csv` (68 rows).
- Final selection (Top 3) not touched.

## 6. Rerun outcomes (worker run 09:54–10:34 UTC, one job at a time)

| Group | Product | Before | After | Total | Open flag | Feedback |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Marqet-U | Failed (credentials permission) | Completed, 8/8 scored | 60.00 | low_confidence_scores | ready |
| 6 | Plan2Win | Failed (credentials permission) | Completed, 8/8 scored | 41.00 | low_confidence_scores | ready |
| 11 | SolVida Campaign Studio | Failed (credentials permission) | Completed, 8/8 scored | 53.00 | low_confidence_scores | ready |
| 14 | LessonLoop | Failed (credentials permission) | Completed, 8/8 scored | 63.00 | none | ready |
| 21 | ActionMeet | Failed (guard false positive) | Completed, 8/8 scored | 61.00 | low_confidence_scores | ready |
| 24 | PawCare | Failed (credentials permission) | Completed, 8/8 scored | 51.00 | low_confidence_scores | ready |
| 49 | SpendWise | Failed (credentials permission) | Completed, 8/8 scored | 61.00 | low_confidence_scores | ready |
| 70 | Pocket Wise | Failed (credentials permission) | Completed, 8/8 scored | 50.00 | low_confidence_scores | ready |
| 73 | Pet Care Companion | Failed (credentials permission) | Completed, 8/8 scored | 55.00 | low_confidence_scores | ready |

All nine passed preflight, artifact analysis, test-plan generation, browser testing (credentials revealed and stamped), evidence review and scoring on their third attempt; every one produced its feedback report in the same run. Totals above are first-pass totals before the consistency pass. The low-confidence flags are the same provisional-score signal 39 of the original 56 carry; they do not exclude a product from ranking.

Groups 13 (Makeover), 34 (PRISM) and 46 (AI-Powered Task Manager) were not rerun: their causes (401 on a declared-open URL, no response within 15 s, a Drive folder instead of an app) are product-side and unchanged, so they remain **Needs Human Review / unranked** with their original reasons. Note for the operator: the consistency selector queues every submission with an open flag, ranked or not, which briefly moved these three jobs to `consistency_review`; they were diverted straight back to `manual_review` through the store's own stage transition before the worker reached them (no scores, no review rows written; audited as `assessment.stage_restored`).

## 7. Final state (10:48 UTC)

| Bucket | Count |
| --- | --- |
| Imported submissions | 68 |
| Ranked (current snapshot `425ed333…`, generated 10:47 UTC after the consistency pass) | 65 |
| Needs human review (groups 13, 34, 46) | 3 |
| Failed | 0 |
| Disqualified | 0 |
| Incomplete / not assessed | 0 |

Recovered from platform failures: 9 of 9 rerun (8 credential-permission, 1 guard false positive), all now ranked. Consistency pass: 54 ranked products selected by the real triggers, 64 review rows, 18 with adjustments, all through `overrideScore` as `system:consistency` with the original score preserved on the row. Four ranking snapshots exist (08:42 original, 10:35 after reruns, 10:47 final, plus the queued-pass intermediate); only the last is current. Top 3 not selected. Files: `exports/AIAP-C14-FINAL-RESULTS-AUDIT.csv` (68 rows), `exports/AIAP-C14-FINAL-RANKED-RESULTS.csv` (65 rows), `exports/AIAP-C14-ALL-SUBMISSIONS-AUDIT.csv` (68 rows).
