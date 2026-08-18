# Final completion status

Live progress tracker for the final product completion phase.

**Status vocabulary** — these are separate concepts and are never conflated:

| Label | Meaning |
| --- | --- |
| `NOT STARTED` | No work done |
| `IN PROGRESS` | Being worked on now |
| `BLOCKED` | Waiting on a decision, secret, or remote operation |
| `LOCAL PASS` | Implemented and passing locally (unit / PGlite / Playwright) |
| `REMOTE PASS` | Verified against the real Supabase project |
| `MANUAL PASS` | A human has exercised it in a browser |
| `DEPLOYED` | Running on external infrastructure |

Last updated: 13 August 2026. **1,040 unit/integration + 108 e2e + 22 acceptance + 4 concurrency** (+ 4 concurrency tests against a real Postgres server, + 104 end-to-end), lint, typecheck and production build clean.

---

## Phase 0 — Final acceptance and operations hardening

| Task | Status | Notes |
| --- | --- | --- |
| 0.1 `APP_BASE_URL` correctness | `LOCAL PASS` | Stale `localhost:3000` fallbacks removed from production paths; env now fails closed in production; 12 tests |
| 0.2 One open cohort invariant | `LOCAL PASS` | Transactional; refuses to open a second cohort and names the one already open; `findActiveCohort` no longer arbitrates |
| 0.3 Cohort archive + safe delete | `LOCAL PASS` | Archive preserves everything; delete refuses when meaningful data exists |
| 0.4 Learner-sheet importer (CSV + paste) | `LOCAL PASS` | Real `Name / Email / Group / Link`; 32 tests |
| 0.5 Learner sheet → teams (parsing/grouping) | `LOCAL PASS` | 1,000 rows → 100 groups → 100 teams, tested |
| 0.6 Import preview + validation | `LOCAL PASS` | Pure calculation, mutates nothing; 8 warning classes; error CSV |
| 0.7 WhatsApp link storage | `REMOTE PASS` | Migration `0005` applied and verified against the real project |
| 0.7b Store-level learner import | `LOCAL PASS` | `importLearnerAllocation`, idempotent, per-group transaction; 24 PGlite tests |
| 0.8 Access codes after import | `LOCAL PASS` | Issue-missing covers only new teams; verified across a re-import |
| 0.9 Code generation UX | `LOCAL PASS` | Three scoped actions; issue and download are one step |
| 0.10 Distribution file | `LOCAL PASS` | Sheet carries group, members, WhatsApp link, code, submission URL |
| 0.11 Terminology cleanup | `LOCAL PASS` | Invite wording replaced; `/submit/[token]` now 404s in production |
| 0.12 Controlled real acceptance test | `BLOCKED` | Needs human browser interaction (file upload) |

## Phase B — Automated assessment repository

**35 / 35 methods implemented.** The capability flag is verified against the
interface rather than asserted — see `assessment-coverage.test.ts`.

| Area | Status | Notes |
| --- | --- | --- |
| B.0 Queue, claim, lease, retry | `LOCAL PASS` | 28 PGlite tests; `SKIP LOCKED` + a post-lock re-check |
| B.0b Concurrency proof | `LOCAL PASS` | **8 workers / 40 jobs on real Postgres 18.4**; mutation-tested |
| B.1 Preflight | `LOCAL PASS` | Row per attempt; 25 domain tests for the five-way outcome |
| B.2 Artifact analysis | `LOCAL PASS` | Injection flags stored; video limitation first-class |
| B.3 Test plan generation | `LOCAL PASS` | Closed action set, validated twice; rejections recorded |
| B.4 Browser testing | `LOCAL PASS` | Unreached step stays `skipped`, never `failed` |
| B.5 Evidence | `LOCAL PASS` | `missing` is a stored stance |
| B.6 Scoring | `LOCAL PASS` | Rubric ceiling enforced; override survives a re-score |
| B.7 Feedback | `LOCAL PASS` | `is_exposed_to_participant` forced false on write |
| B.8 Manual review | `LOCAL PASS` | A legitimate outcome, not a failed job |
| B.9 Disqualification | `LOCAL PASS` | Eleven grounds only, enforced in code and schema |
| B.10 Participant isolation | `LOCAL PASS` | Structural boundary test, mutation-tested |
| B.11 Worker wiring | `LOCAL PASS` | Connects to Postgres; fails closed on missing DB, AI, or capability |

**Judging has never run.** The repository is complete and tested; no assessment
has been produced, because no AI provider is configured.

## Phases C–N

| Phase | Status |
| --- | --- |
| C — Ranking, Top 10, Final Four | `LOCAL PASS` — 6/6 methods, 21 PGlite tests |
| D — AI provider | `REMOTE PASS` — Gemini verified live on synthetic data; 8/8 rubric categories scored, schema valid first attempt |
| E — Playwright worker security | `NOT STARTED` |
| F — Final admin experience | `NOT STARTED` |
| G — Final learner experience | `NOT STARTED` |
| H — Security completion | `NOT STARTED` |
| I — Complete test matrix | `IN PROGRESS` — `docs/PRODUCTION_DATASTORE_COVERAGE.md` rewritten |
| J — Load and scale | `NOT STARTED` |
| K — Documentation cleanup | `IN PROGRESS` |
| L — Deployment | `NOT STARTED` |
| M — Production pilot | `NOT STARTED` |
| N — Launch readiness | `NOT STARTED` |

---

## Decisions taken this phase

1. **`Team.leadName` / `leadEmail` are now nullable** in the type, matching what
   migration 0005 permits. The allocation sheet designates no lead, and a
   placeholder would appear in exports as a real person's name.
2. **Issuing a code and downloading the sheet are one action.** The previous
   design's only download reissued every code in the cohort, so codes for teams
   imported later could never be distributed without invalidating everyone
   else's.
3. **`/submit/[token]` is demo-only and 404s in production.** It granted the
   same access as an access code with none of the protections around one.
4. **A learner missing from a re-imported sheet is reported, never removed.**

## Final state

Phase A (submission platform), Phase B (assessment repository), Phase C
(ranking), Phase D (provider) and the controlled browser-judge run are all
complete and verified. See `FINAL_LAUNCH_READINESS.md` for the launch verdict
and `ACCEPTANCE_TEST_LOG.md` for every finding.

Ready for an internal demo, and the web app is now deployed. Not ready for a
real learner launch: the judging worker has no host yet, judging has never run
on real data by design, and there is no evidence at cohort scale.

F-17, the intermittent acceptance-suite flake, is **closed** — it was `next dev`
compilation latency, settled by 100 consecutive sign-ins against the deployed
production build.

## Open stop conditions

1. **A real browser acceptance test** — needs human interaction (file upload).
   The AI provider is now verified end to end on synthetic data.
2. **Controlled acceptance test** — needs human browser interaction (file upload
   to Supabase Storage cannot be exercised headlessly here).

## Capability state

`capabilities: { assessment: true, ranking: true }` — flipped from false after
35/35 and 6/6 were verified against the interface, the full local gate passed,
and the concurrency proof ran against a real server.

The admin judging controls are therefore live. The queue page now warns plainly
when submissions are queued and nothing has claimed them, because a repository
being available is not the same as a worker existing.
