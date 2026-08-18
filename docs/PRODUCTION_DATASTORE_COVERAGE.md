# Production DataStore coverage

What the production (Postgres) driver actually implements, and how each part was
verified. Written for someone deciding whether to trust it, not for someone who
already knows the code.

**Status vocabulary.** `IMPLEMENTED` means the code exists. `LOCAL PASS` means it
is exercised by tests against a real Postgres engine. `REMOTE PASS` means it ran
against the real Supabase project. These are separate claims and are never
merged: code existing is not evidence that it works.

Last updated: 12 August 2026 — **851 tests passing**, lint, typecheck and
production build clean, plus a 4-test concurrency proof against a real server.

---

## 1. Summary

| Repository | Methods | Implemented | Verified |
| --- | --- | --- | --- |
| Participant | 21 | 21 | `LOCAL PASS` (PGlite) |
| Admin auth | 8 | 8 | `LOCAL PASS` + `REMOTE PASS` |
| Cohorts and ideas | 17 | 17 | `LOCAL PASS` + `REMOTE PASS` |
| Teams and access codes | 12 | 12 | `LOCAL PASS` + `REMOTE PASS` |
| Submissions | 16 | 16 | `LOCAL PASS` |
| Assessment | **35** | **35** | `LOCAL PASS` |
| Ranking | **6** | **6** | `LOCAL PASS` |
| Support (audit, settings, resources) | 8 | 8 | `LOCAL PASS` + `REMOTE PASS` |

Assessment and ranking were the two repositories that previously threw
`FeatureUnavailableError` on every call. Both are now implemented, and the store
declares `capabilities: { assessment: true, ranking: true }`.

That declaration is **checked, not asserted**. `assessment-coverage.test.ts`
reads the method list out of the `AssessmentStore` interface itself, confirms
every one is present on the composed production store, and calls each to confirm
none is still backed by the throwing stub. A method added to the interface
tomorrow is covered by that test the moment it is declared.

---

## 2. The assessment repository, method by method

Split across three files because they fail differently: a queue bug loses
throughput, a judgment bug loses fairness.

### Queue — `repositories/assessment-queue.ts` (11 methods)

| Method | Behaviour worth knowing |
| --- | --- |
| `enqueueCohort` | Idempotent via `on conflict (submission_id) do nothing`. Drafts excluded. |
| `enqueueSubmission` | Returns the existing job rather than a second one. |
| `getJob` / `getJobBySubmission` / `listJobs` | Plain reads; `listJobs` filters by stage. |
| `claimJobs` | `FOR UPDATE SKIP LOCKED` **plus** a re-check of `claimed_by` in the outer UPDATE. |
| `heartbeat` | Scoped to the holding worker; a worker whose lease expired cannot extend it back. |
| `advanceStage` | Releases the claim on any terminal stage. |
| `releaseJob` | Fails the job outright when attempts are exhausted, rather than scheduling a retry that could never be claimed. |
| `reclaimExpiredLeases` | Makes the queue read honestly after a worker dies. |
| `getQueueStats` | One statement, so the parts cannot disagree. No ETA until something has completed. |

**Why the claim statement has two protections.** `SKIP LOCKED` keeps workers from
queueing behind each other, but on its own it is a throughput device. The outer
`UPDATE` re-checks `claimed_by is null or lease_expires_at < now()` *after*
taking the row lock, so under `READ COMMITTED` a second transaction that somehow
reached the same row updates nothing. The invariant does not rest on the
subquery's locking behaviour alone.

### Pipeline — `repositories/assessment-pipeline.ts` (7 methods)

| Method | Behaviour worth knowing |
| --- | --- |
| `recordPreflight` / `listPreflight` | One row **per attempt**, appended. The sequence is what makes "their host was slow at 23:50" arguable afterwards. |
| `saveArtifactAnalysis` | Replaces on re-run. `videoAnalysisLimited` is a column, so the system can say it could not watch a video instead of scoring as though it had. |
| `saveTestPlan` / `getTestPlan` | Steps validated against the permitted action set before insert, and again by a column constraint. Rejected steps are recorded, not dropped. |
| `saveBrowserRun` / `listBrowserRuns` | Runs accumulate (desktop and mobile are separate observations). A step never reached is `skipped`, never `failed`. |

### Judgment — `repositories/assessment-judgment.ts` (17 methods)

| Method | Behaviour worth knowing |
| --- | --- |
| `saveEvidence` / `listEvidence` | `stance = 'missing'` is a stored value. Replaces per job so counts cannot double. |
| `saveScores` / `listScores` | `max_points` comes from the rubric, not the caller. An existing override survives a re-score. |
| `overrideScore` | `original_raw_score` filled via `coalesce`, so a second override still points at the model's figure. Reason required by a database constraint. |
| `saveSummary` / `getSummary` | Total recomputed from the stored scores. Nothing scored → total 0 **and** confidence 0, which marks it for review rather than presenting a zero-scoring product. |
| `saveConsistencyReview` | Appended; the comparison between passes is the point. |
| `saveFeedbackReport` / `getFeedbackReport` | `is_exposed_to_participant` forced `false` on write. |
| `raiseManualReview` / `resolveManualReview` / `listManualReviewFlags` | One open flag per reason per submission. Manual review is a legitimate outcome, not a failed job. |
| `proposeDisqualification` | Reason code checked here **and** by a database constraint restricted to the eleven permitted grounds. |
| `confirmDisqualification` / `reverseDisqualification` | Only a human path. A reversal keeps the row and its original reason. |
| `listDisqualifications` | Cohort-scoped. |

---

## 3. The ranking repository (6 methods)

| Method | Behaviour worth knowing |
| --- | --- |
| `generateSnapshot` | Eligibility decided explicitly per submission. A submission missing **any** category score is excluded rather than ranked on a partial total. |
| `getCurrentSnapshot` | Returns the stored ordering, not a fresh computation. Carries `lowConfidence` and `hasOpenManualReview` so a thin ranking does not look solid. |
| `listSnapshots` | History, newest first. |
| `listFinalSelections` | With group number and product name for display. |
| `setFinalSelection` | Finalists must come from the current snapshot. Replaced wholesale in one transaction. Admin-only (ADR-018). |
| `clearFinalSelection` | Removes the selection without touching the ranking. |

**The system never declares winners.** It produces an ordering and a private
Top 10. Choosing the final four is an admin action; no worker, stage or model
response has a call path to `setFinalSelection`.

---

## 4. How it was verified

### PGlite — real Postgres, in process

Runs the actual migration files, so a column this driver gets wrong fails in
tests rather than in production. Used because the machine has neither Docker nor
a system Postgres, and the only real one otherwise available is production.

| Suite | Tests |
| --- | --- |
| `assessment-queue.test.ts` | 28 |
| `assessment-judgment.test.ts` | 40 |
| `ranking.test.ts` | 21 |
| `learner-import.test.ts` | 24 |
| `assessment-coverage.test.ts` | 6 |
| `postgres.test.ts`, `submissions.test.ts`, `participant.test.ts`, `bootstrap.test.ts`, `capability-gate.test.ts`, `storage.test.ts` | 100+ |

### The concurrency proof — a real multi-connection server

PGlite is single-connection. A single connection **cannot** demonstrate that two
simultaneous transactions take disjoint rows, because there is no second
transaction to run. Asserting it there would produce a green test that proved
nothing.

So `assessment-concurrency.test.ts` runs against a real Postgres and skips
loudly without one:

```
npm run test:concurrency
```

That boots a throwaway PostgreSQL 18.4, runs the proof, and tears it down. It
also accepts `TEST_DATABASE_URL` for any server you do not mind truncating.

**Result: 8 concurrent workers, 40 jobs — 4 tests passed.** Verified:

- no job claimed by two workers
- every job claimed exactly once between them
- attempt counters not double-incremented
- exactly one worker takes over after a lease expires — not none, not several

**The proof was mutation-tested.** Replacing the claim with a naive
read-then-write (no `SKIP LOCKED`, no re-check) makes **3 of the 4 fail**. A
concurrency test that cannot fail is not a proof.

### Participant isolation

`participant-boundary.test.ts` checks the wall structurally rather than by
permissions:

1. the participant repository never names a judging table;
2. participant routes and actions never import an assessment repository, never
   reach `store.assessment` / `store.ranking`, and never name a judging table;
3. `ParticipantStore` declares no judging type in its contract.

It deliberately does **not** scan method names for words. `finaliseSubmission`
is a team finalising their own work; flagging it would teach the next person to
weaken the test. Mutation-tested: adding a judging query to the participant
repository, and a `store.assessment` call to a participant action, each fail it.

---

## 5. What is NOT verified

Stated plainly, because the value of the table above depends on it.

| Not verified | Why |
| --- | --- |
| Assessment against the **real Supabase project** | No assessment data has been written remotely. Only the schema is confirmed to exist there. |
| The **worker end to end** | It connects and fails closed correctly, but has never processed a real job — there is no AI provider configured. |
| **Browser testing** against a real product | Requires the worker running with a model. |
| **AI-shaped output quality** | No provider is configured; nothing has produced a real score. |
| **Load at 500 submissions** | The queue is tested at 40 jobs with 8 workers. |

The repository is complete and tested. **Judging has never run.** Those are
different statements and the difference matters.
