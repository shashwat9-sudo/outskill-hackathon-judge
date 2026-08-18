# Outskill Hackathon Judge — Master Project Handoff

**Audit date:** 12 August 2026
**Audited by:** inspection of the actual repository, live test runs, and read-only
verification against the linked Supabase project `eoxfmegmwbchctfrfglr` (ap-south-1, Mumbai).

Everything numeric in this report was measured during the audit. Nothing was
carried over from earlier notes. Where something could not be proven it is marked
**UNVERIFIED** rather than assumed.

---

## 1. Executive summary

### What is this product?

A private web application that collects hackathon submissions from learners and
gives the Outskill team one place to manage and review them. Long term it will
also test each team's live product automatically and produce evidence-backed
scores, but that half is not built yet.

### What problem does it replace?

Today the hackathon runs on a Google Form plus a manual, external first-pass
judging effort. A form cannot check that a product URL actually loads, cannot
stop accepting entries at a precise instant, cannot tell you who on a team edited
what, and cannot stop two teammates overwriting each other. Judging by hand does
not scale to 300–500 submissions in the hours between the deadline and the
shortlist.

### Who uses it?

- **Learners** — teams of participants, on Days 12–13 of the accelerator. They
  reach one common URL and identify with a group number and a shared team code.
- **The Outskill programme team** — one shared admin account. They create the
  cohort, import teams, issue codes, watch submissions arrive, and control when
  the window opens and closes.

### What can it genuinely do today?

The **entire submission platform**, against the real production database:

- one common learner URL, group number + shared access code sign-in
- multiple teammates editing one submission safely
- six-step form with autosave and draft persistence
- deadline enforcement, pause, resume, manual close, reopen with an extension
- final submit producing a locked entry and a permanent receipt
- admin cohort, idea, team and access-code management
- full audit trail

### What can it NOT do yet?

- **Automated judging.** No product is tested, nothing is scored, no feedback is
  produced. 35 assessment methods are deliberately unimplemented and gated.
- **Ranking, Top 10, finalists.** 6 methods, gated with judging.
- **AI analysis.** No provider configured; the deterministic stub is in use.
- **The Playwright worker.** Written but refuses to run outside demo mode.
- **Deployment.** Runs on a laptop only. Not on Vercel, not on a public URL.
- **Real file upload.** No deck has been uploaded to Supabase Storage yet.

### Stage

| Area | Status |
| --- | --- |
| Submission platform | **Production-capable**, pending a real end-to-end test with a file upload |
| Automated judging | **Gated** — 0 of 35 methods implemented |
| Ranking / shortlist / finalists | **Gated** — 0 of 6 methods implemented |
| AI integration | **Not started** |
| Deployment | **Local only** |

A fair characterisation: the half of the product that collects and protects
submissions is done and tested; the half that evaluates them is not started.

---

## 2. Current status — verified

Labels: ✅ implemented + tested · 🟡 implemented, real-world verification still
needed · 🟠 feature-gated (Phase B) · ❌ not implemented · ⚠️ known issue

| Capability | Status | How it was verified in this audit |
| --- | --- | --- |
| Supabase database connected | ✅ | Live query: PostgreSQL 17.6, 4 migrations, 38 tables |
| Production PostgresDataStore | ✅ | 74 methods implemented; 112 PGlite integration tests pass |
| MemoryDataStore only in demo mode | ✅ | `getStoreAsync()` has no fallback path; 15 fail-closed tests |
| Production fail-closed | ✅ | `DEMO_MODE=0` with no config → `ConfigError`, 503 health, 0 demo content |
| Private Storage adapter | 🟡 | 6 buckets verified private and reachable; **no object ever written** |
| Participant access (code → session) | ✅ | 32 PGlite tests; 1 real verification recorded in production |
| Draft persistence | ✅ | PGlite tests; 1 real draft exists in production |
| Concurrency (stale-write refusal) | ✅ | PGlite tests incl. simultaneous saves |
| Final submit | ✅ | PGlite tests incl. two concurrent submits → one receipt |
| Receipt | ✅ | Immutable, survives reopen; tested |
| Admin authentication | ✅ | Argon2id; real login succeeded 4 times in production |
| Cohorts | ✅ | 2 cohorts exist in production |
| Ideas + approval gate | ✅ | 8 seeded, 8 approved in production |
| Teams | ✅ | 1 team imported in production |
| Access codes | ✅ | 1 code issued, 1 successful verification |
| Lifecycle (pause/resume/close/reopen) | ✅ | PGlite tests; 4 real status changes recorded |
| Automated judging | 🟠 | 0 of 35 methods; throws `FeatureUnavailableError` |
| Ranking / Top 10 / finalists | 🟠 | 0 of 6 methods; gated |
| Playwright worker | 🟠 | Code exists, refuses `DEMO_MODE=0` |
| AI integration | ❌ | `AI_PROVIDER=demo`; no key configured |
| Deployment | ❌ | Local only, port 3210 |
| Stale UI/doc text | ⚠️ | See §28 |
| Storage never exercised | ⚠️ | Highest-risk untested path — see §20 |

**Gate re-run during this audit:** lint PASS · typecheck PASS · build PASS ·
**578 unit tests pass** (23 files) · **104 Playwright tests pass**.

---

## 3. Complete feature inventory

### A. Learner experience

| | |
| --- | --- |
| **What** | One public page where a team signs in and completes their submission |
| **Who** | Learners |
| **Why** | Replaces the Google Form. A form cannot enforce a deadline, prevent overwrites, or confirm receipt |
| **How** | Next.js server-rendered pages at `/submit`, `/submit/portal`, `/submit/guide` |
| **Status** | ✅ |
| **Code** | `apps/web/src/app/submit/` |
| **Tables** | `submissions`, `team_activity`, `participant_sessions` |
| **Security** | Reads only through `ParticipantStore`, which has no method that can reach an assessment table |
| **Tests** | 32 PGlite + 18 Playwright (`e2e/submit-entry.spec.ts`) |
| **Demo** | Open `/submit`, sign in as group 999 |

### B. Admin experience

| | |
| --- | --- |
| **What** | A private dashboard for the programme team |
| **Who** | Outskill staff, one shared account |
| **Why** | Cohort setup, code distribution, and live monitoring during the hackathon |
| **How** | `/admin/*`, protected by session cookie + CSRF |
| **Status** | ✅ (judging sections gated) |
| **Code** | `apps/web/src/app/admin/` |
| **Security** | Every mutation requires a session, checks CSRF, and writes an audit entry |
| **Tests** | Playwright `e2e/admin.spec.ts`, `e2e/operations.spec.ts` |
| **Demo** | `/admin/login` |

### C. Cohort management

Create a cohort with a name, code, timezone, Day 12 start and Day 13 deadline.
Status moves draft → open → paused → closed → judging → finalised → archived.
**Status:** ✅ · **Code:** `apps/web/src/app/admin/cohorts/` ·
**Table:** `cohorts` · **Tests:** 17 PGlite (`postgres.test.ts`).

Cohort-scoped pages now name the cohort in the URL, not the globally active one
(fixed this session — see §19).

### D. Idea catalogue

Eight approved product ideas that teams choose from. Each has a **sourced** part
(title, description) and an **expanded** part used for judging.
**Status:** ✅ · **Table:** `cohort_ideas` · Full explanation in §3a below.

### E. Team management

CSV import of group number, lead name, lead email, lead phone. Duplicate group
numbers are skipped with a reason rather than failing the whole file.
**Status:** ✅ · **Table:** `teams`, `team_members` · **Tests:** PGlite import tests.

### F. Access-code security

12-character shared codes, Argon2id-hashed, versioned, rate-limited.
**Status:** ✅ · **Table:** `team_access_codes`, `verification_attempts` ·
Full detail in §7.

### G. Participant sessions

Opaque token, only its hash stored, bound to the access-code version.
**Status:** ✅ · **Table:** `participant_sessions` · **Tests:** 34 unit + 32 PGlite.

### H. Submission form

Six steps — see §5.
**Status:** ✅ · **Code:** `apps/web/src/app/submit/_components/submission-form.tsx`

### I. Draft / autosave / persistence

Saves on a 1.2-second debounce. A team can close the tab and return.
**Status:** ✅ · **Column:** `submissions.draft_payload` (JSON) plus promoted columns.

### J. Concurrent editing

Optimistic concurrency — see §8.
**Status:** ✅ · **Column:** `submissions.version`

### K. File / deck storage

PDF only, 25 MB limit, private bucket, path scoped to cohort + submission.
**Status:** 🟡 — implemented and unit-tested, **never exercised against real Supabase**.
**Bucket:** `submission-decks`

### L. Product / demo credentials

Optional login details for the judges, encrypted at rest — see §10.
**Status:** ✅ (encryption) · **Table:** `submission_credentials`

### M. Final submission

Validates, locks, mints a receipt — see §9.
**Status:** ✅

### N. Receipt

On-screen plus a downloadable PDF generated in-process.
**Status:** ✅ · **Code:** `packages/shared/src/domain/receipt-pdf.ts` · **Tests:** 17.

### O. Submission deadlines

Decided from the server clock on every write. Never depends on a scheduled job.
**Status:** ✅ · **Code:** `packages/shared/src/domain/submission-window.ts` · **Tests:** 25.

### P. Pause / resume / close / reopen

Manual close needs `CLOSE SUBMISSIONS` typed exactly. Reopening after the
deadline requires an acceptance time.
**Status:** ✅ · **Code:** `apps/web/src/app/admin/cohorts/closure-controls.tsx`

### Q. Audit trail

Every admin mutation is recorded. The table rejects UPDATE and DELETE by trigger.
**Status:** ✅ · **Table:** `audit_logs` · **Verified:** 22 entries in production.

### R. Admin authentication

Argon2id password, one shared account enforced by a database constraint,
lockout after repeated failures, CSRF on every mutation.
**Status:** ✅

### S. Security / RLS

38 of 38 tables have row-level security; 78 policies; 3 application roles.
**Status:** ✅ verified live — see §12.

### T. Automated judging

**Status:** 🟠 0 of 35 methods — see §16.

### U. Browser / Playwright worker

**Status:** 🟠 written, refuses production — see §17.

### V. AI analysis

**Status:** ❌ not configured. `AI_PROVIDER=demo`.

### W. Ranking / shortlist / finalists

**Status:** 🟠 0 of 6 methods — see §18.

### X. Resources

Participant-visible documents served through short-lived signed URLs.
**Status:** 🟡 implemented; **0 resources exist in production**.

### Y. Demo mode

`DEMO_MODE=1` runs the whole product on deterministic fixtures with no database.
**Status:** ✅ — 6 scenario teams, working access codes, no external services.

### Z. Production mode

`DEMO_MODE=0` uses the real database and refuses to start without full config.
**Status:** ✅ — see §15.

---

### 3a. The idea catalogue, explained

The canonical catalogue in `packages/shared/src/fixtures/ideas.ts` is exactly:

1. Recipe Sharing App
2. Fitness Goal Tracker
3. Book Recommendation App
4. Movie Watchlist
5. Budget Tracker
6. Collaborative Notetaker
7. Website Content Scraper
8. Travel Itinerary Planner

**Confirmed against source. Eight, matching the expected list.**

Four terms that are easy to confuse:

| Term | Meaning |
| --- | --- |
| **Catalogue title / description** | Comes from Outskill's approved idea list. Authoritative. Always usable. |
| **Expanded definition** | Our interpretation of what the idea *means* for judging: the minimum core flow, expected entities, AI opportunity, allowed scope, unsafe interpretations |
| **Draft expanded definition** | Written but not yet reviewed by a person. Must not influence real judging |
| **Approved expanded definition** | A human has read it and pressed Approve. Only then may test plans use it |

**Why editing returns it to draft:** an approval is a record that a person read
*those particular words*. If the words change afterwards, the approval no longer
refers to anything anyone reviewed — but it still *looks* reviewed, which is
worse than no approval at all. Enforced in the store, not in the UI, so no caller
can forget (ADR-025).

---

## 4. End-to-end learner journey

```
common URL  →  group number  →  access code  →  verification  →  editor name
     →  six-step form  →  autosave  →  return later  →  shared editing
     →  deck upload  →  final review  →  FINAL SUBMIT  →  locked  →  receipt
```

**1. Common URL** — `/submit`. No team identifier in it. A per-team URL would be
forwarded and screenshotted, and the first team to do so would hand its
submission to everyone reading (ADR-026).
*Database:* nothing written. The page reads the active cohort to show the deadline.

**2 & 3. Group number + access code** — typed once, posted once.
*Database:* a row in `verification_attempts` keyed on hashed IP + group number.

**4. Verification** — the code is checked against its Argon2id hash. Every
failure returns the identical message.
*Database:* on success, `team_access_codes.last_verified_at` and `verify_count`
update, and the attempt counter is cleared.

**5. Editor name** — the team says who is editing. This is a **label, not a
login** (ADR-029). Between steps 4 and 5 the verified team travels in an
HttpOnly cookie holding a signed, ten-minute assertion — never a bare team id,
which anyone could guess (ADR-028).
*Database:* a row in `participant_sessions` storing only the hash of the token.

**6–8. Six-step form, autosave, returning later** — every save carries the
version the browser last read.
*Database:* `submissions.draft_payload` plus promoted columns; `version`
increments; `last_edited_by` records the label.

**9. Shared editing** — any teammate with the code can join. The portal shows a
recent-activity list.
*Database:* `team_activity` rows from a closed set of six learner-safe kinds.

**10. Deck upload** — PDF only, 25 MB, checked by MIME type, extension, size
**and magic bytes**, because a browser-supplied content type is a claim, not
evidence.
*Database:* a row in `submission_artifacts`; the file goes to the private
`submission-decks` bucket.

**11–12. Final review and FINAL SUBMIT** — see §9.
*Database:* status → `locked`, `submitted_at`, `submitted_by_name`, an immutable
`receipt_id`, a `submission_events` row, a `team_activity` row.

**13. Receipt** — shown on screen and downloadable as a PDF containing no access
code, no credentials and no internal identifiers. A safety assertion refuses to
generate one that does.

### What a learner can see

Their own submission, their team's activity, the deadline, the public rubric
**categories and weights only**, and the two-day guide.

### What a learner cannot see — verified

Scores, rank, evidence, Top 10 / shortlist, finalist status, manual-review notes,
internal comments, other teams, any admin screen.

Enforced three ways: `ParticipantStore` has **no method** that can reach an
assessment table (ADR-010); participants have **no RLS policy** on those tables;
and Playwright asserts the rendered HTML contains none of those words.

---

## 5. The six submission steps

Read from the current UI (`submission-form.tsx`). The six *displayed* steps
differ slightly from the six *schema* steps — declarations are folded into
"Review and submit" editorially, while validation still checks all six schema
groups. That is intentional, not drift.

| # | Step | Learner enters | Validation | Why it matters for judging |
| --- | --- | --- | --- | --- |
| 1 | **Team** | Group number (pre-filled), lead details, members and contributions | Names non-empty; phone 7–15 digits, separators free | Establishes who built it; contributions feed the learning-quality category |
| 2 | **Product idea** | Chosen idea, product name, primary user, exact problem, one-sentence promise, description, why AI is necessary, differentiation, must-have workflow, up to 2 should-haves, exclusions | Idea must be active; text fields have minimum lengths | Drives *Problem clarity* (15) and *AI usefulness* (15). The must-have workflow becomes the test plan |
| 3 | **Live product** | Product URL, whether login is required, demo username/password/instructions, core test steps, safe sample inputs, reset instructions, known limitations | URL must be public http/https; login details required if login is required | The single most important step. Drives *Core workflow* (25) and *Stability* (15). Without a reachable URL nothing can be tested |
| 4 | **Demo and deck** | Deck PDF upload, demo video link, under-three-minutes confirmation | PDF only, ≤25 MB, magic-bytes checked; video must be a shareable link | Drives *Deck and demo clarity* (5) |
| 5 | **Learning evidence** | Bugs fixed, deliberate exclusions, major trade-off, Day 12→13 changes, most important learning, seven-day plan, builder stack, APIs used, external templates | Minimum lengths; disclosure expected | Drives *Learning and execution* (10) and *Practical potential* (5). Undisclosed external material is a disqualification matter |
| 6 | **Review and submit** | Seven declarations, then the typed confirmation | All declarations required; server re-validates every earlier step | Last chance to fix gaps. Declarations are the integrity record |

---

## 6. Admin journey

```
login → create cohort → configure schedule → review/approve ideas
      → import teams → issue access codes → open submissions
      → monitor → pause/resume if needed → close
      → [GATED] start judging → manual review → Top 10 → final four
```

Everything up to and including **close** works today. Everything from **start
judging** onwards is feature-gated: the "Start judging" control is hidden, and
the Judging, Shortlist and Finalists pages show a production-safe explanation
instead of failing.

---

## 7. Team import and access codes

### Group numbers

Integers **1–999**, enforced by a database constraint. The format is an
assumption on our side, recorded as ADR-022 — worth confirming against Outskill's
actual roster convention before a real cohort.

### CSV import

| Column | Required | Notes |
| --- | --- | --- |
| Group Number | yes | 1–999, unique within the cohort |
| Lead Name | yes | |
| Lead Email | yes | must contain `@` and `.` |
| Lead Phone | no | 7–15 digits; any separators |

Headings are matched flexibly. **Each row is its own transaction**: a duplicate
or malformed row is reported with a reason and the rest of the file still
imports. Re-uploading a 500-row roster to fix one line is worse than a report.

### Code generation

| Property | Value |
| --- | --- |
| Length | 12 characters |
| Alphabet | `ABCDEFGHJKMNPQRSTVWXYZ23456789` — no O, 0, I, 1, L or U |
| Display | `ABCD-EFGH-JKMN` |
| Stored as | Argon2id hash only |
| Live codes per team | Exactly one, enforced by a partial unique index |

The alphabet omits the characters people misread when a code is read aloud or
copied off a printed sheet.

### Why plaintext cannot be recovered

There is **no column in the database capable of holding it**. Only the Argon2id
hash is stored, and a hash cannot be reversed. The plaintext exists for one round
trip — generated, written into the CSV you download, then gone.

That is a deliberate trade. Losing the sheet means regenerating for the affected
teams, a minor inconvenience. A system that could reprint any team's credential
on demand is a much larger problem, and one that only becomes visible after it
has been abused.

### The three buttons

| Action | What it does | When to use |
| --- | --- | --- |
| **Issue new codes and download** | Regenerates for **every** team and downloads the CSV | Once, at setup |
| **Issue missing codes** | Only teams with no live code | A team imported later |
| **Replace existing codes too** (checkbox) | Regenerates for everyone and signs everyone out | A leaked sheet |

⚠️ **Dangerous operator action:** pressing "Issue new codes and download" a second
time silently invalidates every code you already distributed. The panel warns
about this above the button, but it remains the single easiest way to disrupt a
live cohort.

### Regeneration, sessions and lockouts

Each code carries a **version**. Sessions record the version they were minted
under. Regenerating increments it, which invalidates every existing session in
one write — no need to find them. Revoking has the same effect.

**Lockout:** 8 wrong attempts within 15 minutes locks that team out for 15
minutes. Keyed on hashed IP **and** group number together, so one hostile client
cannot lock out a legitimate team and one fumbling team cannot lock out an office
behind a shared connection. An admin can clear it instantly.

**Enumeration resistance:** an unknown group, a wrong code, a team with no code,
a revoked code and a withdrawn team all return a **byte-identical** response.
Asserted by test.

---

## 8. Shared team editing

**Simple version.** Everyone on a team uses the same code. When you sign in you
type your name — that is a label so your teammates can see who changed what, not
a password. Nothing security-relevant depends on it: anyone with the code can
type any name.

**Optimistic concurrency, in plain English.** Every time the page saves, it says
"I am editing version 7". The database only accepts the save if it *is* still on
version 7. If a teammate saved first, the version is now 8, your save is refused,
and you are told to reload.

**Why silent overwrites are dangerous.** Without this, the last save wins.
Twenty minutes of a teammate's work vanishes, nobody is told, and it is usually
discovered after the deadline.

**How Person B cannot destroy Person A's work.** The version check is in the
`WHERE` clause of the update, not only in an application check beforehand. Two
teammates saving in the same instant both pass the read, but only one matches the
row. The database is the arbiter, not a race between two reads.

**Tests proving it** (`packages/shared/src/data/postgres/submissions.test.ts`):

- *refuses the stale write and keeps the winner intact* — A and B load version N,
  A saves, B is refused, and A's data is still there
- *lets the loser succeed once it reloads*
- *survives simultaneous saves at the same version, admitting exactly one*

---

## 9. Final submit safety

**Validation.** Server-side, ignoring whatever the browser believed: the window
must be open, the submission must not already be locked, the chosen idea must
still be active, a deck must be uploaded, a demo video link must be present, and
a product URL must be set.

**Lock.** Status becomes `locked`, `submitted_at` and `submitted_by_name` are
stamped, and `locked_at` is set. The form becomes read-only.

**Immutable receipt.** `receipt_id` is written with `coalesce(receipt_id, $new)`
— if one already exists it is kept. A team reopened and resubmitted keeps the
identifier they were given. Format `OSK-<COHORT>-<GROUP>-<RANDOM>`.

**Events.** A `submission_events` row and a `team_activity` row.

### The concurrency problem, and the fix

Two teammates pressing Submit at the same instant must not produce two receipts.

The first implementation used `SELECT … FOR UPDATE`. **That was not sufficient**,
and the test caught it: `FOR UPDATE` only serialises transactions that are on
*different* database connections. Anything that lets two calls share a session —
a single-connection engine, a pooler quirk, a future refactor — lets both
through. Correctness depended on the connection model rather than on the data.

The fix is a **compare-and-set**: the update itself carries
`where id = $1 and status <> 'locked'`. Exactly one caller can ever match, on any
engine, regardless of how connections are arranged.

**The test:** *produces exactly one receipt under two concurrent final submits* —
fires both simultaneously and asserts exactly one succeeds, exactly one
submission row exists, its status is `locked`, its `receipt_id` matches the
winner, and exactly **one** `final_submitted` event exists rather than two.

**What a learner sees:** one team member gets the receipt; the other is told the
submission has already been finalised and sees the same receipt on reload.

---

## 10. Credential encryption

Teams whose product needs a login give the judges a **demo account** — never a
real one. Those details are encrypted before they reach the database.

| Aspect | Detail |
| --- | --- |
| What is encrypted | Demo username, demo password, login instructions |
| Algorithm | AES-256-GCM |
| Key | `CREDENTIAL_ENCRYPTION_KEY`, exactly 32 bytes, base64, server-side only |
| Envelope | Each field carries its **own random IV** and its own authentication tag |

**Why a shared IV would have been unsafe.** The table has single `iv` and
`auth_tag` columns, which invites encrypting all three fields under one IV.
Reusing an IV across different plaintexts under the same key is a **real break**
of AES-GCM — not untidiness. So each field gets its own self-contained envelope
and those two columns are deliberately left null, documented in the code.

**Why identical plaintexts differ.** Because each has its own random IV,
encrypting the same word twice produces different ciphertext. There is a test
asserting exactly this — otherwise an observer could tell that a team's username
and password are the same string.

**Authentication failure.** GCM authenticates. A tampered ciphertext throws
rather than returning plausible rubbish. Tested by flipping one character.

**Malformed envelope.** Rejected with a clear error. Tested.

**Logging policy.** No code path logs a credential. Reveal is a privileged admin
action; the record stamps `last_revealed_at` so an unexplained reveal is visible
afterwards. Deleting overwrites the ciphertext rather than only setting a flag.

---

## 11. Supabase / database

**Verified live during this audit:**

| Property | Value |
| --- | --- |
| PostgreSQL | **17.6** |
| Migrations applied | **4** (`0001`–`0004`), local and remote agree |
| Public tables | **38** |
| Tables without RLS | **0** |
| Policies | **78** |
| Application roles | **3** (`ohj_participant`, `ohj_admin`, `ohj_worker`) |
| Connection | Transaction pooler, port 6543, ap-south-1 |

### Database areas by purpose

| Area | Purpose |
| --- | --- |
| **Identity and access** | The one admin account, admin sessions, team access codes, participant sessions, verification attempts |
| **Cohort configuration** | Cohorts, the idea catalogue, rubric versions and categories |
| **Teams** | Teams, members, legacy invite tokens |
| **Submissions** | The submission itself, artifacts, encrypted credentials, declarations, events, learner-safe activity |
| **Assessment (empty)** | Jobs, preflight checks, artifact analyses, test plans and steps, browser runs and steps, evidence |
| **Scoring (empty)** | Category scores, summaries, consistency reviews |
| **Integrity (empty)** | Manual-review flags, disqualifications |
| **Results (empty)** | Ranking snapshots, ranking entries, final selections, feedback reports |
| **Operations** | Resource documents, audit log, system settings |

Full list in Appendix A.

### Constraints that carry real weight

- `teams`: `group_number between 1 and 999`, unique per cohort — the historical
  duplicate-group problem becomes impossible
- `submissions`: unique `(cohort_id, team_id)` — one submission per team
- `team_access_codes`: partial unique index — at most one live code per team
- `audit_logs`: trigger rejecting UPDATE and DELETE — append-only
- `rubric_categories`: trigger asserting the total is exactly 100
- `submission_is_late(sub)`: a **function**, not a column — lateness is computed,
  never stored (ADR-016)

### PGlite testing

**What it is.** Postgres 18 compiled to WebAssembly, running inside the test
process.

**Why it was introduced.** This machine has neither Docker nor a local Postgres.
The Supabase CLI needs Docker for a local database, so the only real Postgres
available was **production** — and writing test data there was out of scope. The
alternative was shipping the entire data layer unverified.

PGlite runs the **actual migration files** and reproduces production exactly: 38
tables, 38 with RLS, 78 policies, 3 roles, 13 enums.

### Bugs PGlite caught that would otherwise have reached production

| Bug | Why it would have escaped |
| --- | --- |
| `$2` used as an enum in one clause and compared to text in another | Compiles and typechecks. Fails only at runtime, on the first cohort status change |
| `on conflict (team_id)` when the real constraint is `(cohort_id, team_id)` | Fails only when a submission is first created — i.e. the first learner to open the portal |
| `bytea` decoded as comma-separated byte numbers | PGlite returns `Uint8Array`; `.toString('utf8')` on one yields `"1,2,3…"` **silently**. Every stored credential would have been unrecoverable, discovered only when a judge tried to log in |

All three are invisible to TypeScript and would have surfaced during a live
hackathon.

---

## 12. RLS and the security model

**What RLS is, simply.** Row-level security is a rule the *database* enforces
about which rows a given role may see or change. It applies even if the
application asks the wrong question, so a bug in the app cannot expose data the
database refuses to hand over.

**Verified live:** 38 of 38 tables have RLS enabled; 78 policies; 3 roles.

### What is actually protected, specifically

**Team A from Team B.** Every participant method takes the *session token* and
derives the team from it server-side. No method accepts a submission id or team
id from the caller. A tampered request has nothing to tamper with. Tested: team B
attempting to delete team A's artifact by id changes nothing.

**Learners from assessment data.** Two independent mechanisms. First,
`ParticipantStore` has **no method** capable of reaching an assessment table —
the capability is absent, not guarded, so a future participant surface cannot
leak scores by forgetting a check (ADR-010). Second, participants have **no RLS
policy** on those tables at all.

**Learners from the access-code table.** Participants have **no policy** on
`team_access_codes`, `participant_sessions` or `verification_attempts`. A
participant able to read the first could enumerate every group in the cohort —
exactly what the generic verification error exists to prevent.

**Private storage.** All six buckets are private. There is **no method in the
storage interface that returns a permanent public URL** — enforced by the type,
not by review. Reads go through signed URLs capped at one hour.

**Internal ranking and evidence.** The worker role has no policy on
`ranking_snapshots`, `ranking_entries` or `final_selections`. It cannot rank, and
it certainly cannot pick winners (ADR-018).

**Revoked access.** Regenerating or revoking a code increments the version, which
invalidates every session minted under the old one in a single write.

**Deletion.** `DELETE` is revoked from all three application roles. Nobody
deletes through the application.

---

## 13. Storage architecture

**Verified live: six buckets, all private, none public, no unexpected buckets,
zero objects stored.**

| Bucket | Purpose | Writes | Reads | Limit | Exercised? |
| --- | --- | --- | --- | --- | --- |
| `submission-decks` | Team pitch decks | Participant (only bucket they may write) | Admin, worker | 25 MB | ❌ never |
| `submission-screenshots` | Screenshots from product testing | Worker | Admin | 10 MB | ❌ never |
| `browser-evidence` | Per-step browser evidence | Worker | Admin | 50 MB | ❌ never |
| `traces` | Playwright traces — the most sensitive artifact, since a trace can contain a product in an authenticated state | Worker | Admin | 200 MB | ❌ never |
| `internal-reports` | Generated internal reports | Server | Admin | 25 MB | ❌ never |
| `admin-resources` | Templates, instructions, playbook | Admin | Participants, for flagged rows only | 50 MB | ❌ never |

**Signed access:** yes, for every read. Expiry clamped to between 30 seconds and
1 hour — a signed URL is a bearer credential, and a long expiry turns a one-off
view into a durable leak.

⚠️ **What still needs real-world verification.** Listing buckets proves
reachability. It does **not** prove that uploading a file, generating a signed
URL and downloading it actually work end to end. **No object has ever been
written to this project.** This is the single highest-risk untested path, because
it is the one a learner hits when they upload their deck.

---

## 14. Environment variables

**Names only. No values are shown anywhere in this report.**

| Variable | Secret? | Web | Worker | Why it exists |
| --- | --- | --- | --- | --- |
| `DEMO_MODE` | no | ✅ | ✅ | Chooses fixtures vs the real database |
| `NODE_ENV` | no | ✅ | ✅ | Standard runtime mode |
| `APP_BASE_URL` | no | ✅ | — | Becomes the submission URL on every access-code sheet |
| `DATABASE_URL` | 🔴 **yes** | ✅ | ✅ (Phase B) | Contains the database password |
| `DATABASE_POOL_MAX` | no | ✅ | — | Pool ceiling per serverless instance |
| `SUPABASE_URL` | no | ✅ | — | Storage API endpoint |
| `SUPABASE_SECRET_KEY` | 🔴 **yes** | ✅ | ❌ **never** | Signs URLs for private buckets. Bypasses RLS entirely |
| `ADMIN_SESSION_SECRET` | 🔴 **yes** | ✅ | — | Signs admin sessions, keys participant session hashes, signs verification handles, salts IP hashing |
| `CREDENTIAL_ENCRYPTION_KEY` | 🔴 **yes** | ✅ | — | AES-256-GCM key for demo credentials |
| `CREDENTIAL_KEY_VERSION` | no | ✅ | — | Supports key rotation |
| `ADMIN_SEED_USERNAME` | no | ✅ | — | Bootstraps the shared admin |
| `ADMIN_SEED_PASSWORD` | 🔴 **yes** | ✅ | — | Bootstraps the shared admin |
| `AI_PROVIDER` | no | ✅ | ✅ | Currently `demo` |
| `DEFAULT_TIMEZONE` | no | ✅ | — | `Asia/Kolkata` |
| `DEFAULT_SHORTLIST_TARGET` | no | ✅ | — | 10 |

All fifteen are present and non-empty in `.env.local`, which is git-ignored
(`git check-ignore` confirms) and contains values found in **zero** tracked files.

### Transaction pooler, port 6543

The web tier will be serverless. A **session**-pooler connection (port 5432)
pins a Postgres backend for its whole life; a few hundred concurrent functions in
the final hour before a deadline exhaust the server that way. The **transaction**
pooler (6543) returns a backend after each transaction.

The driver was audited against every transaction-pooler constraint and is clean:
no named prepared statements, no session `SET`, no temporary tables, no
LISTEN/NOTIFY, no session advisory locks, no held cursors. `validateConnectionString`
refuses port 5432 with an explanation.

### The `#` bug

The database password contained `#` and `@`. In a URI, `#` starts a *fragment* —
everything after it is discarded. The connection string parsed to a nonsense host
and `pg` reported `EHOSTUNREACH 0.0.0.123`, which points at the **network**.
Anyone debugging that looks in entirely the wrong place.

Fixed by percent-encoding the password. `validateConnectionString` now detects
this class of problem and states the actual remedy.

Writing the test corrected a wrong assumption of mine: an unencoded **`@` is
harmless**, because URI parsing splits on the *last* one. Only `#` is fatal.
There is now a test asserting `@` is tolerated, so nobody is sent to fix
something that is not broken.

### Why the worker gets no Supabase key

The worker does not call the Storage API. Giving it a key that bypasses RLS would
be privilege it has no use for. Least privilege: it needs `DATABASE_URL` and
nothing else, and only in Phase B.

---

## 15. Production vs demo mode

| | `DEMO_MODE=1` | `DEMO_MODE=0` |
| --- | --- | --- |
| Data store | `MemoryDataStore` | `PostgresDataStore` |
| Database | none | Supabase |
| Storage | in-memory | Supabase, private buckets |
| Teams | 6 fixture teams | whatever was imported |
| Access codes | deterministic, displayed on screen | real, never displayed |
| Home page | demo explorer with scenario cards | minimal landing |
| Assessment | fully implemented on fixtures | gated |
| External services | none | database + storage |

### `getStore()` today

`getStoreAsync()` builds the store once per process. `DEMO_MODE=1` →
`MemoryDataStore`. `DEMO_MODE=0` → `PostgresDataStore`.

**There is no fallback in either direction.** Serving fixtures because the
database is unreachable would let the platform look healthy while accepting
several hundred real submissions into memory that vanish on the next restart —
far worse than refusing to start.

### Fail-closed, verified on the real build

Same binary, `DEMO_MODE=0`, configuration removed:

- `/api/health` → **503 degraded**
- `/submit` → **500**
- demo content served: **0**
- log names all three missing values

Fifteen unit tests cover this, including that `DEMO_MODE=0` is never implied to
be `1`.

---

## 16. Automated judging — current state

**Nothing here runs. Zero of 35 methods are implemented.**

### The 35 methods, grouped

| Group | Methods |
| --- | --- |
| **Queue and lifecycle (10)** | `enqueueCohort`, `enqueueSubmission`, `getJob`, `getJobBySubmission`, `listJobs`, `claimJobs`, `heartbeat`, `advanceStage`, `releaseJob`, `reclaimExpiredLeases` |
| **Pre-flight and artifacts (4)** | `recordPreflight`, `listPreflight`, `saveArtifactAnalysis`, `getQueueStats` |
| **Test planning (2)** | `saveTestPlan`, `getTestPlan` |
| **Browser testing (2)** | `saveBrowserRun`, `listBrowserRuns` |
| **Evidence (2)** | `saveEvidence`, `listEvidence` |
| **Scoring (7)** | `saveScores`, `listScores`, `overrideScore`, `saveSummary`, `getSummary`, `saveConsistencyReview`, `saveFeedbackReport` |
| **Feedback (1)** | `getFeedbackReport` |
| **Integrity (7)** | `raiseManualReview`, `resolveManualReview`, `listManualReviewFlags`, `proposeDisqualification`, `confirmDisqualification`, `reverseDisqualification`, `listDisqualifications` |

### The intended pipeline

```
final submission → assessment job → preflight (is the URL reachable and safe?)
   → artifact analysis (deck, demo, written material)
   → safe test-plan generation (from the APPROVED expanded idea definition)
   → browser testing (Playwright, in an isolated worker)
   → evidence  → rubric scores  → feedback  → consistency review
   → manual-review flags → ranking
```

### How it is gated

Every one of the 35 methods throws `FeatureUnavailableError`, naming the feature
and the method. The store declares `capabilities: { assessment: false, ranking: false }`.

**Why not return empty arrays or zeroes?** Because an empty queue and a score of
zero both *look like real answers*. An operator would read "0 assessments done"
as "queued nothing" rather than "not set up", and a submission showing rank 0
reads as "assessed badly". A throw cannot be mistaken for a result.

**Where the gate shows:**

| Surface | Behaviour |
| --- | --- |
| `/admin` overview | Judging figures show `—` with the hint "Judging not configured", plus an explanatory banner |
| `/admin/assessment-queue` | Production-safe panel instead of the pipeline |
| `/admin/ranking`, `/admin/final-selection` | Same |
| "Start judging" | **Hidden**, not disabled — an operator should not wonder whether they lack a permission |
| `startJudgingAction` and 11 other mutations | Refuse *before* any state change, so a cohort is never moved to `judging` with nothing assessing it |
| Learner surfaces | Unaffected |
| Worker with `DEMO_MODE=0` | Refuses to start |

Demo mode still implements all 115 methods, so the full pipeline can be
demonstrated on fixtures.

---

## 17. Playwright worker

**Status: written, not deployed, refuses to run in production.**

**What it will do.** Poll for assessment jobs, open each team's live product in a
real browser, follow the test plan, capture screenshots and traces, check
accessibility, and record evidence.

**Why not inside Vercel request functions.** A serverless function is short-lived
and shares a host with the web tier. Driving a browser against hostile,
participant-supplied URLs there would put that browser in the same place as the
web application's memory, session secrets and request context. It needs a
container — Cloud Run or equivalent.

**Implemented today:** the polling loop, lease-based job claiming, graceful
drain on `SIGTERM`, `/healthz` and `/readyz` (liveness vs readiness — a worker
inside a browser run is *busy*, not stalled, and must not be restarted mid-run),
a Dockerfile on the Playwright base image running as non-root, and a wall-clock
budget per submission. 40 unit tests, including real browser runs against a local
fixture app.

**Pending:** the assessment repository (Phase B), deployment, and the network
egress policy.

### SSRF — why URL validation alone is insufficient

The application already validates every URL: it resolves the hostname, checks the
resolved address, refuses private ranges, loopback and cloud metadata endpoints,
and **re-checks before each navigation** so a redirect cannot smuggle the browser
elsewhere.

That protects against what the **worker navigates to**. It does *not* constrain
what a **loaded page does**: a `fetch` from inside the page, a WebSocket, or a
DNS rebind that resolves differently on the second lookup.

So the network must refuse it too — default-deny egress with an allowlist, not a
deny-list. A deny-list is a list of the attacks someone thought of. Must block:
cloud metadata (`169.254.169.254`), RFC1918 ranges, loopback and link-local, the
database host and port, the Supabase API host, and outbound SMTP.

⚠️ **This is the most consequential piece of unfinished security work in the
project.** Full detail in `docs/WORKER_PRODUCTION_GATE.md` (G1–G10).

---

## 18. Ranking, Top 10, final four

**Status: 0 of 6 methods implemented. Gated with assessment.**

`generateSnapshot`, `getCurrentSnapshot`, `listSnapshots`, `listFinalSelections`,
`setFinalSelection`, `clearFinalSelection`.

Ranking consumes assessment scores, so it cannot produce a meaningful result
before Phase B — a snapshot over unscored submissions would rank everyone equal
and look authoritative.

**Intended behaviour, and the parts already enforced:**

- All eligible submissions ranked privately
- Top 10 **private** — there is **no public ranking route** anywhere in the app
- Learners never see rank; the participant view is asserted to contain no rank
- **AI never declares winners** — ADR-018, and the worker role has no database
  policy on `final_selections`, so it structurally cannot
- The **Outskill team chooses the final four**, by hand

Deterministic tie-breaking is designed but unimplemented: a tiebreak vector
column exists on `ranking_entries`, and shared ranking helpers exist in
`packages/shared/src/domain/ranking.ts` with 49 domain tests. The exactly-four
finalist constraint is defined in `validateFinalSelection` and tested at the
domain level, but has no database implementation yet.

---

## 19. Bugs already caught

| # | Problem | Why it mattered | Found by | Fix | Regression test |
| --- | --- | --- | --- | --- | --- |
| 1 | `store instanceof MemoryDataStore` failed after hot reload | Demo invite links silently vanished from the home page — headings with zero rows | Manual inspection | Capability detection via `asDemoStore()` instead of class identity | `demo.test.ts` — "survives module reloading" |
| 2 | Server-action closure passed to a Client Component | Crashed two admin pages in the production build | Playwright | `DownloadButton` takes `action` + `arg` | E2E |
| 3 | Phone regex rejected `(044) 2345-6789` | Valid Indian numbers refused at import | Test writing | Rule changed to content (7–15 digits), not separators | `submission.test.ts` |
| 4 | `$2` used as an enum and compared to text | `inconsistent types deduced for parameter $2` — fails at runtime on the first cohort status change | **PGlite** | Explicit `::cohort_status` and `::text` casts | `postgres.test.ts` |
| 5 | `on conflict (team_id)`; real constraint is `(cohort_id, team_id)` | Would fail when the first learner opened the portal | **PGlite** | Correct conflict target | `submissions.test.ts` |
| 6 | `bytea` decoded as comma-separated byte numbers | **Every stored credential unrecoverable**, discovered only when a judge tried to log in | **PGlite** | Explicit `Buffer.from(value)` conversion | `submissions.test.ts` |
| 7 | Single shared AES-GCM IV for three fields | A real cryptographic break, not untidiness | Design review while implementing | Per-field self-contained envelope; the two columns left null | "gives each field its own IV" |
| 8 | Two concurrent final submits produced **two receipts** | Two receipt states for one submission | **PGlite** | Compare-and-set (`status <> 'locked'`) rather than relying on `FOR UPDATE` | "exactly one receipt under two concurrent final submits" |
| 9 | `#` in the database password truncated the URI | `EHOSTUNREACH 0.0.0.123` — points at the network, not the password | Live connection attempt | Percent-encoding + `validateConnectionString` with the real remedy | 5 tests in `storage.test.ts` |
| 10 | Session vs transaction pooler | Session pooler pins a backend per connection; serverless would exhaust the server in the deadline hour | Design review | Transaction pooler, pool max 2, validator refuses 5432 | Same |
| 11 | `/admin` crashed with `FeatureUnavailableError` | **The first real production admin login.** The page had a guard for "no cohort" but none for "no judging", so it walked into a gated repository as soon as a cohort existed | **Real production use** | Gated data fetched only when available; audit found **4 pages and 15 actions** affected, of which only 2 had been gated | `capability-gate.test.ts` — 9 tests |
| 12 | Cohort header showed the wrong cohort | On a paused cohort's page the header named a *different*, open cohort. Every control acts on the cohort in the URL, so the header invited edits to the wrong one | Real production use | Middleware exposes the path; the shell resolves the cohort from the URL | `cohort-context.test.ts` — 10 tests |
| 13 | Demo cohort not open before 09:00 IST | Nine hours each night where the demo is entirely read-only and teaches the wrong thing | The clock rolling past midnight during a test run | Day 12 clamped to the most recent 09:00 IST that has passed | `demo.test.ts`, tightened to hold at every hour |
| 14 | Wrong assumption: unencoded `@` breaks a URI | Would have sent an operator to fix something that is not broken | Writing the test for #9 | Corrected; `@` is tolerated because parsing splits on the last one | "tolerates an unencoded `@`" |

Two observations worth keeping. **PGlite caught four bugs invisible to
TypeScript**, three of which would have surfaced only during a live hackathon.
And **the two most recent bugs were found by real production use, not by tests** —
which is precisely why the controlled test matters more than another round of
unit tests.

---

## 20. Testing status

**All figures measured during this audit.**

| Category | Count | What it gives confidence in |
| --- | --- | --- |
| **Unit tests** (23 files) | **578 total** | |
| — domain logic | 49 + 25 + 13 | Deadline, window, concurrency rules |
| — security | 54 + 34 + 20 | Hashing, sessions, access codes |
| — schemas | 24 | Form validation |
| — rubric | 14 | Categories total exactly 100 |
| — PDF generation | 17 + 19 | Receipts and the guide are valid PDFs |
| — test DSL | 18 | The closed action set for browser testing |
| — memory driver | 64 | Demo mode |
| — fixtures | 16 | Demo dates never expire |
| **PGlite integration** | **121** | The Postgres driver against a real engine with the real schema |
| — `postgres.test.ts` | 34 | Cohorts, ideas, teams, access codes, audit |
| — `participant.test.ts` | 32 | Verification, sessions, isolation, drafts |
| — `submissions.test.ts` | 29 | Lifecycle, concurrency, credentials |
| — `bootstrap.test.ts` | 17 | Idempotency, no synthetic data |
| — `capability-gate.test.ts` | 9 | The `/admin` crash cannot recur |
| **Storage unit** | 25 | Paths, buckets, traversal, signed-URL construction (mocked) |
| **Fail-closed** | 15 | Production refuses to start misconfigured |
| **Worker** | 40 | Browser runs, SSRF guard, health endpoints |
| **Playwright E2E** | **104** | The real browser journey, learner and admin |
| **Lint** | PASS | |
| **Typecheck** | PASS | |
| **Build** | PASS | |

### Highest-risk areas lacking real-world verification

1. **Supabase Storage has never stored an object.** Upload, signed URL and
   download are mocked only. This is what a learner hits when uploading a deck.
2. **No submission has been completed end to end in production.** The one real
   submission is an empty draft at version 1.
3. **No real deadline has passed** on a production cohort.
4. **Concurrency has never been exercised by two real humans** — only by
   simultaneous programmatic calls.
5. **Nothing has ever been deployed.** Serverless cold starts, pooler behaviour
   under load, and Vercel's environment are all unverified.
6. **The receipt PDF has never been downloaded** from a real submission.

---

## 21. Current real Supabase data state

Read-only verification. **Nothing was created, modified or deleted during this
audit.**

### Cohorts

| | Cohort 1 | Cohort 2 |
| --- | --- | --- |
| **Name** | PRODUCTION TEST — DELETE LATER | tet |
| **Code** | `AIAP C13` | `C12` |
| **Status** | open | open |
| **Timezone** | Asia/Kolkata | Asia/Kolkata |
| **Day 12 start** | 2026-08-12 18:03 UTC | 2026-08-11 16:21 UTC |
| **Day 13 deadline** | 2026-08-13 18:04 UTC | 2026-08-13 18:21 UTC |
| **Ideas** | 8 | 1 |
| **Approved definitions** | **8** | 0 |
| **Teams** | 1 | 0 |
| **Submissions** | 1 | 0 |

### Global counts

| Table | Rows |
| --- | --- |
| `admin_account` | 1 |
| `rubric_versions` | 1 |
| `rubric_categories` | 8, totalling **100** |
| `system_settings` | 3 |
| `teams` | 1 (group 999, active) |
| `team_access_codes` | 1 (v1, live, 1 verification) |
| `participant_sessions` | 1 (active) |
| `submissions` | 1 (**draft**, version 1, no receipt, no product name, no URL) |
| `submission_artifacts` | 0 |
| `submission_credentials` | 0 |
| `assessment_jobs`, `category_scores`, `ranking_snapshots`, `final_selections` | 0 |
| `resource_documents` | 0 |
| `audit_logs` | 22 |
| **Storage objects, all six buckets** | **0** |

### Settings

`judging.enabled = false` · `participants.results_visible = false` ·
`retention.credentials_destroyed_at_finalisation = true`

### Audit actions recorded

8 idea approvals · 4 admin logins · 4 cohort status changes · 2 cohorts created ·
2 access-code exports · 1 idea created · 1 team import.

### Recommendation on the temporary cohorts

**Nothing was deleted.** Both should eventually be removed, but not by deletion:

- **"tet"** is an accidental cohort with one hand-made idea and no teams. It is
  currently `open`, which means `findActiveCohort()` may prefer it. Recommended:
  set its status to **archived** so it stops competing for "active".
- **"PRODUCTION TEST — DELETE LATER"** is the useful one — 8 approved ideas, a
  team and a draft. Recommended: keep it until the controlled end-to-end test is
  finished, then archive it. Do not delete it before then; it is the only place
  the real flow has been exercised.

⚠️ Note both cohorts are `open` simultaneously. Before a real cohort, only one
should be.

---

## 22. Operator runbook

### A. Before Day 12

- [ ] Confirm the app is reachable and `/api/health` returns `ok`
- [ ] Confirm you can sign in at `/admin/login`
- [ ] Have the team roster ready as a CSV: Group Number, Lead Name, Lead Email, Lead Phone

### B. Creating a cohort

**Admin → Cohorts → Create a cohort.** Name, code, Day 12 start, Day 13 deadline.
Leave it in **draft** until you are ready.
⚠️ The deadline is enforced to the second from the server clock. Check the timezone.

### C. Reviewing ideas

**Cohorts → [your cohort] → Ideas.** A banner tells you how many expanded
definitions are unapproved. Read each one and press **Approve this definition**.
⚠️ Editing an expanded field afterwards returns it to draft — deliberately.

### D. Importing groups

**Cohorts → [your cohort] → Teams and access.** Upload or paste the CSV.
Read the skipped-rows report. Fix and re-import only the failed rows.

### E. Generating access codes

Press **Issue new codes and download** **once**. Save the CSV somewhere
appropriate for a credential list.
⚠️ Pressing it again invalidates every code you already sent.

### F. Distributing

Send each team its group number and code through your usual channel. Paste
`<your URL>/submit` into Circle **by hand** — there is no Circle integration and
there should never be one.

### G. Opening submissions

**Cohorts → Lifecycle → Open submissions.** Check `/submit` shows the right
deadline and time remaining.

### H. Monitoring

The overview shows teams invited, drafts, final submissions, and who is editing
right now. "Editing right now" staying at zero after opening means distribution
failed, not the platform.

### I. Clearing a lockout

**Teams and access → Clear a lockout.** Enter the group number. They can retry
immediately.

### J. Regenerating a lost or compromised code

**Teams and access → Issue missing codes** after revoking that team's code.
⚠️ This signs out anyone editing under the old code.

### K–N. Pause, resume, close, deadline

- **Pause** — teams can view but not edit. The deadline keeps running.
- **Resume** — back to normal. Does not extend anything.
- **Manual close** — requires typing `CLOSE SUBMISSIONS`. ⚠️ Every team loses the
  ability to edit at that instant.
- **Automatic** — happens at the deadline with no action from you.

### O. Reopening safely

Requires a reason. **After the deadline it also requires an acceptance time** —
without one the cohort would show as open while rejecting every save, which is
the worst possible state for a team told they may resubmit.

### P. Finding a submission from a receipt ID

**Admin overview → Find a submission by receipt ID.**

### Q. Final-submission state

Locked and read-only. Reopen a single submission from its detail page with a
reason the team sees.

### R. Future judging workflow

Not available. The controls are hidden and the pages explain why.

---

## 23. Learner support guide

| Learner says | Correct answer |
| --- | --- |
| "My code doesn't work." | Ask them to read it back. Check the group number first — that is the usual cause. `O/0`, `I/1`, `L` are not in the alphabet, so a misread makes the code one character short. Check the version column; anything above v1 means a newer sheet exists |
| "We lost the code." | It cannot be looked up — not even by you. Revoke and issue a new one |
| "Another teammate changed the form." | Expected. Everyone shares one submission. The activity panel shows who changed what |
| "My draft disappeared." | It should not. Check they are on the right group. Drafts save every couple of seconds |
| "I got a message saying someone else saved." | Working as designed — it stopped them overwriting a teammate. Reload and reapply their change |
| "My PDF won't upload." | Must be a real PDF (not a renamed file), under 25 MB. Export from Slides/Canva as PDF |
| "Our app requires login." | They must create a **demo account** for judges and enter it in step 3. Never a real account |
| "We clicked final submit too early." | You can reopen it from the submission detail page with a reason they will see |
| "The deadline passed." | Submissions closed on the server clock. Reopening is an exception decision and needs an acceptance time |
| "Can we see our score?" | No. Assessment results are internal to Outskill and are never shared |
| "Can we change our idea?" | Yes, until final submit, as long as the idea is still active |
| "Can two of us edit at once?" | Yes. Both need the same code. The system stops you overwriting each other |

---

## 24. Stakeholder demo script (10–15 minutes)

Run in **demo mode** (`DEMO_MODE=1`) — it has six pre-built teams and working
codes, and needs no database.

**1. Problem today (1 min).** *No screen.* "Submissions come in through a Google
Form. It cannot check a product URL loads, cannot stop at an exact deadline,
cannot tell us who edited what, and cannot stop two teammates overwriting each
other. Then a person opens 400 entries by hand."

**2. What we built (1 min).** Open `/`. "One link for every team. They sign in
with a group number and a shared code."

**3. Admin creates a cohort (1.5 min).** `/admin/cohorts` → Create. "Name, code,
Day 12 start, Day 13 deadline. The deadline is enforced by our server clock, not
the learner's laptop."

**4. Ideas (1.5 min).** Cohort → Ideas. "Eight approved ideas. Titles come from
Outskill's list. The detail underneath is *our* interpretation, and it stays in
draft until a person reads and approves it — because judging teams against
something nobody agreed to is how you get an unfair result." Show the badge flip.

**5. Teams and access codes (2 min).** Teams and access. "Import the roster.
Issue codes once and download the sheet. We store only a hash — nobody, including
us, can look a code up later. That is deliberate: a system that can reprint any
credential on demand is a much bigger problem than a lost spreadsheet."

**6. Learner experience (2 min).** `/submit`. Sign in as group 27. "Six steps.
Everything saves as you type."

**7. Shared editing (1.5 min).** Second browser, same code, different name. Save
in one, then try saving stale in the other. "It refuses instead of silently
destroying twenty minutes of a teammate's work."

**8. Submission (1 min).** Walk the six steps. Point at step 3: "This is what
gets tested — the live URL, the test steps, and a demo login if needed."

**9. Receipt (1 min).** Final submit. "Locked, with a receipt they can quote and
a PDF they can keep. Two people pressing submit at once still produces exactly
one receipt — we have a test for that."

**10. Deadline and admin controls (1.5 min).** Cohorts → Submission window.
"Pause if something breaks. Close early with a typed confirmation, because this
is the moment several hundred teams lose the ability to edit. Reopening after the
deadline forces you to set a new acceptance time."

**11. Security (1 min).** "Codes are hashed. Files are in private buckets with
short-lived links. Learners cannot reach scores — not because we check, but
because that capability does not exist on their side of the system."

**12. Phase B (1 min).** Open `/admin/assessment-queue` in production mode. "This
is honest about what it cannot do yet. Next: open each product in a real browser,
follow the team's own test steps, gather evidence, score against the rubric,
produce a private Top 10. The AI never picks winners — your team chooses the
final four."

---

## 25. How to explain this to someone else

**One common submission link**
*Simple:* "Every team uses the same web address. No personal links to lose."
*Why:* A per-team link gets forwarded and screenshotted; the first team to do
that hands its submission to everyone reading.
*How:* `/submit` identifies nobody; the team identifies itself.
*Proof:* `e2e/submit-entry.spec.ts` — "is one URL with no team identifier in it".

**Group number + access code**
*Simple:* "Like a group number and a shared door code."
*Why:* No accounts to create, no passwords to reset, works when one member is offline.
*How:* Two-step — verify the team, then say who is editing.
*Proof:* 32 PGlite tests; one real verification in production.

**Secure hashing**
*Simple:* "We store a scrambled version of the code that cannot be unscrambled."
*Why:* If the database leaked, the codes would still be unusable.
*How:* Argon2id, deliberately slow, so guessing is impractical.
*Proof:* "never stores plaintext anywhere" — searches the column for the code.

**Shared editing**
*Simple:* "Any teammate with the code can work on the submission."
*Why:* Real teams split the work.
*How:* One submission per team; each session carries a name label.
*Proof:* "resolves to exactly one team".

**Stale-write protection**
*Simple:* "If a teammate saved while you were typing, we refuse your save instead
of throwing theirs away."
*Why:* Silent overwrites lose work and are discovered after the deadline.
*How:* Every save carries the version it read; the database checks it.
*Proof:* "refuses the stale write and keeps the winner intact".

**Final submit**
*Simple:* "One button that locks the entry."
*Why:* A clear line between draft and submitted.
*How:* Server re-validates everything, then a compare-and-set lock.
*Proof:* "exactly one receipt under two concurrent final submits".

**Receipt**
*Simple:* "Proof of submission with an ID they can quote."
*Why:* Answers "did it go through?" without contacting anyone.
*How:* Generated in-process; contains no code, credential or internal id.
*Proof:* 17 tests including "says nothing about judging".

**Deadline enforcement**
*Simple:* "Submissions stop at the deadline, by our clock."
*Why:* A learner's clock cannot buy or cost them minutes.
*How:* Evaluated on every write from the server clock.
*Proof:* "refuses a write once the deadline has passed, with the status still open".

**Pause / resume / close**
*Simple:* "Stop the clock, restart it, or end it early."
*Why:* Things go wrong on the day.
*How:* Pause is not closure — learners are told the difference.
*Proof:* `e2e/operations.spec.ts` — close, then reopen with an acceptance window.

**Private file storage**
*Simple:* "Decks go into a locked cupboard; we hand out a key that expires."
*Why:* A public bucket is a public list of everything the judges saw.
*How:* Six private buckets; no method can produce a permanent public URL.
*Proof:* 25 unit tests. ⚠️ Never exercised against real Supabase.

**Admin dashboard**
*Simple:* "One screen showing what is happening."
*Why:* On the day you need to know who has not started.
*How:* Reads real counts; shows `—` for anything not configured.
*Proof:* `capability-gate.test.ts`.

**Idea approvals**
*Simple:* "A person signs off what each idea means before it judges anyone."
*Why:* Judging against an unreviewed interpretation is unfair.
*How:* Draft → approved; editing returns it to draft.
*Proof:* "un-approves a definition when an expanded field is edited".

**RLS**
*Simple:* "The database itself refuses to hand over data to the wrong person."
*Why:* A bug in the app should not be able to expose another team's work.
*How:* 78 policies; participants have no policy at all on assessment tables.
*Proof:* Verified live — 38 of 38 tables.

**Production fail-closed**
*Simple:* "If something is missing, it refuses to start rather than pretending."
*Why:* Accepting real submissions into memory would lose all of them.
*How:* Config validated at boot; no fallback.
*Proof:* 15 tests, plus a live check on the real build.

**Assessment feature gate**
*Simple:* "Judging is not built yet, and the app says so instead of showing zeros."
*Why:* "0 assessments done" reads as "queued nothing", not "not set up".
*How:* Methods throw; the store declares its capabilities.
*Proof:* 9 tests, written after a real crash.

**Planned browser judging**
*Simple:* "We will open each product in a real browser and follow the team's own
test steps."
*Why:* You cannot judge a product from a form.
*How:* An isolated worker with a locked-down network.
*Proof:* 40 worker tests against a fixture app. Not deployed.

**Planned ranking**
*Simple:* "A private ordered list, and a private Top 10."
*Why:* The team needs a shortlist, not a public leaderboard.
*How:* From evidence-backed scores.
*Proof:* Domain rules tested; no database implementation yet.

---

## 26. Architecture, beginner-friendly

### Today

```
   Learner browser                    Outskill admin browser
         │                                     │
         └──────────────┬──────────────────────┘
                        ▼
              Next.js web app  (one program, two front doors)
                        │
                        ├──────────────► Postgres DataStore
                        │                        │
                        │                        ▼
                        │                Supabase PostgreSQL
                        │                (Mumbai, 38 tables, RLS on)
                        │
                        └──────────────► Supabase Storage
                                         (6 private buckets)
```

### Deck upload

```
Learner picks a PDF  →  Web server checks type, size and magic bytes
                     →  Private bucket (submission-decks)
                     →  Later reads use a short-lived signed link
```

### Future judging (none of this runs yet)

```
Final submission  →  Assessment queue (a to-do list in the database)
                  →  Cloud worker (its own container, restricted network)
                  →  Safe browser tests + AI analysis
                  →  Evidence + scores
                  →  Private admin review  →  Top 10  →  human picks four
```

**Each box.**

- **Learner browser / admin browser** — ordinary web browsers. No install.
- **Next.js web app** — the program serving both surfaces. It decides what each
  visitor may see.
- **Postgres DataStore** — the only way the app talks to the database. Swapping
  it for the in-memory version is what demo mode does.
- **Supabase PostgreSQL** — the real database, in Mumbai, near the learners.
- **Supabase Storage** — file storage. All private.
- **Assessment queue** — a list of work to be done, in the database.
- **Cloud worker** — a separate machine that opens learner products in a browser.
  Separate because it handles the least trustworthy input in the system.

---

## 27. Important architecture decisions

31 ADRs in `docs/DECISIONS.md`. The ones that shape the product:

| ADR | Decision | Why |
| --- | --- | --- |
| **001** | The brief is authoritative over the playbook PDF | They conflict on hackathon length, demo length and access method |
| **003** | Repository interfaces; drivers behind them | Lets demo and production share every line of application code |
| **008** | SSRF guard re-checked before each navigation | A redirect must not smuggle the browser elsewhere |
| **010** | Participant isolation is **structural** | `ParticipantStore` has no method that can reach an assessment table — a future surface cannot leak scores by forgetting a check |
| **011** | Assessment results are internal | Private scoring guidance never reaches a table an export could read |
| **016** | Lateness is a computed fact; the exception is a separate decision | Reversible, and never silently rewritten |
| **018** | **No code path selects a winner** | The worker has no database policy on `final_selections` |
| **019** | Retention deletion disabled outside production | A production policy cannot destroy local work |
| **022** | Assumption: group numbers 1–999 | ⚠️ Worth confirming against Outskill's roster |
| **024** | No email delivery in v1 | Distribution goes through Outskill's own channel |
| **025** | Expanded idea definitions are approved before they judge | An approval must refer to words a person read |
| **026** | One common URL, and **no Circle integration** | A per-team URL gets forwarded; Circle is pasted by hand |
| **027** | Shared team access codes, not per-team links | No accounts, works when a member is offline |
| **028** | A signed handle, not a team id, between entry steps | A bare id could be guessed |
| **029** | Editor name is a label, not identity | Anyone with the code can type anything |
| **030** | Optimistic concurrency, not last-write-wins | Silent overwrites lose work |
| **031** | The window is decided by the server clock, not a scheduler | A job that never runs must not change what is accepted |

⚠️ **Stale:** `ADR-032` (transaction pooler) is referenced in **3 places in the
code** but does **not exist** in `docs/DECISIONS.md`. The decision is real and
documented in `ARCHITECTURE.md` and `SUPABASE_SETUP.md`; only the ADR entry is
missing.

---

## 28. Known UX and documentation issues

**Not fixed during this audit, as instructed.**

### Critical before production

| Issue | Detail |
| --- | --- |
| **Two cohorts are `open` at once** | `findActiveCohort()` prefers an open cohort, so `/submit` and the admin overview may name "tet" rather than the real cohort. Archive the unused one |
| **`APP_BASE_URL` still points at `localhost:3000`** | The server runs on 3210, and this value is printed on **every access-code sheet** as the submission URL. Teams would be sent to the wrong address |

### Should fix before production

| Issue | Detail |
| --- | --- |
| **"Invite link" wording** | Six admin/learner files still say "invite link" or "invite CSV". The product now uses group number + access code. The invite path is legacy/demo only, so the wording misleads |
| **ADR-032 missing** | Referenced in code, absent from `DECISIONS.md` |
| **Docs still name `SUPABASE_SERVICE_ROLE_KEY`** | `DEPLOYMENT_RUNBOOK.md`, `ARCHITECTURE.md`, `PRODUCTION_CHECKLIST.md` mention the legacy key. It is a documented fallback, but a new setup should not be pointed at it |
| **`BUILD_STATUS.md` is stale** | Predates the Postgres driver, the capability gate and the two production bugs |
| **The playbook PDF still describes a three-day hackathon** | Learners read it. Recorded in `reference-analysis.md` §7 and unresolved |

### Nice to have

| Issue | Detail |
| --- | --- |
| Gated judging screens | Correct and honest, but visually sparse |
| Access-code button names | "Issue new codes and download" vs "Issue missing codes" is a consequential distinction carried by wording alone |
| Brand green is a placeholder | `#00C853`, pending the real Outskill hex (ADR-014) |

---

## 29. Security review

| Threat | Protection present | Remaining risk | Phase B / deployment work |
| --- | --- | --- | --- |
| **Leaked team code** | Versioned codes; revoke and regenerate invalidate every session in one write | Anyone with the code can edit until revoked — inherent to a shared code | Operator vigilance |
| **Brute-force** | Argon2id (slow) + 8 attempts / 15 min + 15-min lockout | A distributed attacker with many IPs gets more attempts | Consider a per-group global limit |
| **Team enumeration** | Byte-identical response for every failure mode; no participant RLS policy on `team_access_codes` | Timing differences not measured | Measure response timing |
| **Stale sessions after regeneration** | Sessions bound to code version; one write invalidates all | None known | — |
| **Cross-team access** | Every method derives the team from the session; no id accepted from the caller; tested | None known | — |
| **Malicious file upload** | MIME + extension + size + **magic bytes**; private bucket; path scoped and traversal-stripped | Content is not scanned for malware; a valid PDF can still be hostile to a reader | Consider scanning if decks are opened outside the browser |
| **Credential leakage** | AES-256-GCM, per-field IV; no plaintext column; reveal is audited | An admin with the key can read them — by design | Rotate the key between cohorts |
| **Secret leakage to browser** | Server-only; no `NEXT_PUBLIC_`; build artifacts scanned and clean | Re-check after any dependency change | Add the scan to CI |
| **SQL injection** | Every value is a bound parameter; no string-concatenated SQL anywhere | None known | — |
| **Race conditions** | Version predicate in the `WHERE` clause; compare-and-set on final submit; tested | None known | — |
| **Audit-log tampering** | Database trigger rejects UPDATE and DELETE; verified | A database superuser could still alter it | Restrict production DB access |
| **Admin credential compromise** | Argon2id, lockout, CSRF, every action audited | One shared account — the audit log shows *what*, not *who* | Consider per-person accounts if the team grows |
| **Prompt injection** | Page content treated as data, never instruction; tested against a hostile fixture | Untested against a real model | Re-run against the production AI config |
| **SSRF** | Resolved-address validation, re-checked before each navigation; private ranges, loopback and metadata refused | **Does not constrain what a loaded page does** — in-page fetch, WebSocket, DNS rebind | 🔴 **Network-level default-deny egress. The most important outstanding item** |
| **Worker reaching internal networks** | Runs as non-root in its own container; gets no Supabase key | Not deployed, so untested | Verify G1–G10 in `WORKER_PRODUCTION_GATE.md` |

---

## 30. Launch checklist

### A. Submission platform blockers

- [ ] **Upload a real PDF to Supabase Storage and download it back** — never done
- [ ] **Complete one submission end to end in production** — the only one is an empty draft
- [ ] **Fix `APP_BASE_URL`** — currently `localhost:3000`, printed on every code sheet
- [ ] **Archive one of the two open cohorts**
- [ ] **Test a real deadline passing** on a production cohort
- [ ] **Have two real people edit simultaneously** and confirm the conflict message
- [ ] **Download a receipt PDF** from a real submission
- [x] Database connected and verified
- [x] RLS verified live — 38 of 38 tables
- [x] Access codes issued and verified in production
- [x] Admin login works in production
- [x] Fail-closed verified on the real build

### B. Automated judging blockers

- [ ] Implement 35 assessment methods, PGlite-first
- [ ] Prove `claimJobs` is safe under concurrent workers (`FOR UPDATE SKIP LOCKED`)
- [ ] Implement 6 ranking methods including the exactly-four constraint
- [ ] Configure an AI provider and estimate cost for 300–500 submissions
- [ ] Flip `capabilities.assessment` and `capabilities.ranking`
- [ ] Pilot on 3–5 real submissions with evidence read by hand

### C. Deployment blockers

- [ ] Push to GitHub
- [ ] Deploy the web app (Vercel) with `DEMO_MODE=0`
- [ ] Set every environment variable in the platform's secret store
- [ ] Confirm `/api/health` returns 200 on the deployed URL
- [ ] Build and deploy the worker container **separately**
- [ ] 🔴 **Network egress policy, tested from inside the container**
- [ ] Wire `/healthz` and `/readyz` to the platform

### D. Operational preparation

- [ ] Confirm the group-number format matches the real roster (ADR-022)
- [ ] Fix "invite link" wording
- [ ] Revise the playbook PDF (still says three days)
- [ ] Obtain the real Outskill brand green
- [ ] Rehearse the runbook with whoever will operate the day
- [ ] Agree who holds the admin password and where the code sheet lives

---

## 31. Recommended order of work

1. **Fix `APP_BASE_URL` and archive the spare cohort** — small, and both are
   currently wrong in ways that would affect real teams
2. **Complete the controlled production test** on PRODUCTION TEST — DELETE
   LATER: sign in, fill all six steps, **upload a real deck**, final submit,
   download the receipt PDF. This exercises the one untested path
3. **Two-person concurrency test** with a real second human
4. **Deadline test** — set a deadline a few minutes out and confirm closure
5. **Reopen test** — reopen with an acceptance window and confirm editing resumes
6. **Fix the remaining UX text** (invite-link wording, stale docs, ADR-032)
7. **Phase B: the 35 assessment methods**, PGlite-first, same standard
8. **Ranking**, including deterministic tie-breaks and the four-finalist constraint
9. **AI provider** — configure, cost-estimate, verify no PII is sent
10. **Safe Playwright pilot** on 3–5 real submissions
11. **GitHub**
12. **Vercel preview deployment**
13. **Cloud worker deployment**
14. 🔴 **Network egress security, verified from inside the container**
15. **10–20 submission pilot** with a real cohort subset
16. **Real cohort**

Steps 1–6 are days. Steps 7–10 are the larger remaining build.

---

## 32. Glossary

| Term | Meaning |
| --- | --- |
| **Postgres** | The database engine storing everything |
| **Supabase** | A hosted service providing Postgres, file storage and APIs |
| **RLS** | Row-level security — the database's own rules about who may see which rows |
| **Migration** | A numbered SQL file that changes the database structure. Forward-only |
| **Bucket** | A folder in file storage. Ours are all private |
| **Signed URL** | A temporary link to a private file that expires |
| **Hash** | A one-way scramble. You can check a guess, but cannot reverse it |
| **Argon2id** | A deliberately slow hash, so guessing is impractical |
| **AES-GCM** | Encryption that also detects tampering |
| **IV** | A random value making each encryption unique. Reusing one breaks the encryption |
| **Session** | Proof you signed in, held in a cookie |
| **Optimistic concurrency** | Letting everyone edit, then refusing a save based on an outdated version |
| **Transaction** | Several database changes that all happen or none do |
| **Compare-and-set** | "Change this only if it is still what I expect" |
| **PGlite** | Postgres compiled to run inside our tests, so we can test without installing a database |
| **Playwright** | A tool that drives a real browser automatically |
| **Worker** | A separate program doing slow background work |
| **Serverless** | Code that runs on demand with no server to manage |
| **Vercel** | Where the web app will be hosted |
| **Cloud Run** | Where the worker will run, in a container |
| **SSRF** | Tricking our server into visiting somewhere it should not |
| **Feature gate** | A switch that hides an unfinished feature honestly |
| **Rubric** | The 100-point scoring scheme |
| **Assessment job** | One submission's place in the judging queue |
| **Ranking snapshot** | A frozen ordered list at a point in time |

---

## 33. File map

| Path | Controls | When you would care |
| --- | --- | --- |
| `apps/web/src/app/submit/` | Everything a learner sees | Changing the learner journey |
| `apps/web/src/app/admin/` | The whole admin surface | Changing operator screens |
| `apps/web/src/server/` | Server actions — every mutation | Changing what an action does |
| `apps/web/src/lib/store.ts` | Demo vs production driver selection | Understanding fail-closed |
| `apps/web/src/middleware.ts` | Exposes the path so the shell names the right cohort | The cohort-header fix |
| `packages/shared/src/data/store.ts` | The 115-method contract both drivers implement | Adding a data operation |
| `packages/shared/src/data/postgres/` | The production driver | Any real database behaviour |
| `packages/shared/src/data/postgres/repositories/` | Participant, submissions, teams, cohorts, admin, support | Specific data logic |
| `packages/shared/src/data/postgres/unavailable.ts` | The Phase B feature gate | Turning judging on |
| `packages/shared/src/data/memory/` | Demo driver and fixtures | Demo behaviour |
| `packages/shared/src/domain/` | Deadline, window, concurrency, ranking, PDFs | Business rules |
| `packages/shared/src/security/` | Access codes, sessions, hashing, encryption | Anything security-related |
| `packages/shared/src/rubric/` | The 100-point rubric | Changing scoring categories |
| `packages/shared/src/fixtures/ideas.ts` | **The canonical idea catalogue** | Changing approved ideas |
| `packages/shared/src/config/env.ts` | Every environment variable and its validation | Adding configuration |
| `apps/worker/` | The Playwright worker and its Dockerfile | Phase B judging |
| `supabase/migrations/` | The four database migrations | Changing the schema |
| `scripts/` | Verification and bootstrap tools | Operating production |
| `docs/` | 20 documents | Understanding decisions |
| `e2e/` | 104 Playwright tests | Browser-level behaviour |
| `.env.local` | Real secrets. **Git-ignored** | Configuration. Never commit |

---

## 34. Final truth table

| Capability | Built? | Tested? | Real Supabase verified? | Safe for real learners? | Notes |
| --- | --- | --- | --- | --- | --- |
| Admin login | ✅ | ✅ | ✅ 4 real logins | ✅ | Argon2id, CSRF, audited |
| Cohort management | ✅ | ✅ | ✅ 2 cohorts | ✅ | Two are open at once — archive one |
| Idea approval | ✅ | ✅ | ✅ 8 approved | ✅ | |
| Team import | ✅ | ✅ | ✅ 1 team | ✅ | Confirm group format (ADR-022) |
| Access code issuance | ✅ | ✅ | ✅ 1 issued, 1 verified | ✅ | |
| Learner verification | ✅ | ✅ | ✅ 1 real verification | ✅ | Enumeration-resistant |
| Participant sessions | ✅ | ✅ | ✅ 1 active | ✅ | |
| Draft saving | ✅ | ✅ | 🟡 1 empty draft | ✅ | Never filled in for real |
| Shared editing | ✅ | ✅ | ❌ | 🟡 | Never two real humans |
| PDF upload | ✅ | 🟡 mocked | ❌ **never** | ❌ | **Highest-risk untested path** |
| Admin PDF access | ✅ | 🟡 mocked | ❌ | ❌ | Depends on the above |
| Pause / resume | ✅ | ✅ | 🟡 status changed | ✅ | |
| Deadline | ✅ | ✅ | ❌ never elapsed | 🟡 | Logic proven; not observed live |
| Final submit | ✅ | ✅ | ❌ | 🟡 | Concurrency proven in tests |
| Receipt | ✅ | ✅ | ❌ | 🟡 | Never generated from a real submission |
| Assessment queue | ❌ | n/a | n/a | n/a | Phase B — gated |
| AI analysis | ❌ | n/a | n/a | n/a | Not configured |
| Browser testing | 🟡 worker only | ✅ 40 tests | ❌ | ❌ | Needs egress policy |
| Scoring | ❌ | n/a | n/a | n/a | Phase B |
| Ranking | ❌ | 🟡 domain only | n/a | n/a | Phase B |
| Top 10 | ❌ | n/a | n/a | n/a | Phase B |
| Finalists | ❌ | 🟡 domain only | n/a | n/a | Phase B — always a human choice |
| Deployment | ❌ | n/a | n/a | n/a | Local only |

---

## Appendix A — the 38 tables

**Identity and access (6):** `admin_account`, `admin_sessions`,
`team_access_codes`, `participant_sessions`, `verification_attempts`,
`team_invites`

**Cohort configuration (4):** `cohorts`, `cohort_ideas`, `rubric_versions`,
`rubric_categories`

**Teams (2):** `teams`, `team_members`

**Submissions (6):** `submissions`, `submission_artifacts`,
`submission_credentials`, `submission_declarations`, `submission_events`,
`team_activity`

**Assessment pipeline (9):** `assessment_jobs`, `preflight_checks`,
`artifact_analyses`, `test_plans`, `test_plan_steps`, `browser_test_runs`,
`browser_test_steps`, `assessment_evidence`, `consistency_reviews`

**Scoring (2):** `category_scores`, `assessment_summaries`

**Integrity (2):** `manual_review_flags`, `disqualifications`

**Results (4):** `ranking_snapshots`, `ranking_entries`, `final_selections`,
`feedback_reports`

**Operations (3):** `resource_documents`, `audit_logs`, `system_settings`

---

# COPY THIS SECTION TO CHATGPT

**Project:** Outskill Hackathon Judge — an internal platform replacing a Google
Form + manual first-pass judging for the Outskill AI Accelerator hackathon
(Days 12–13 of a 14-day programme, 300–500 submissions expected).

**Stack:** npm workspaces monorepo. Next.js 15 / React 19 web app
(`apps/web`), Playwright worker (`apps/worker`), shared library
(`packages/shared`), AI adapter (`packages/ai`). TypeScript strict throughout.

**Architecture.** Application code depends on a 115-method `DataStore`
interface, never on a driver. `DEMO_MODE=1` → `MemoryDataStore` (deterministic
fixtures, no external services). `DEMO_MODE=0` → `PostgresDataStore` against
Supabase. There is **no fallback in either direction**; missing production config
throws at boot.

**Production database:** Supabase project `eoxfmegmwbchctfrfglr`, ap-south-1
(Mumbai), PostgreSQL 17.6. 4 migrations applied. 38 public tables, **RLS enabled
on all 38**, 78 policies, 3 application roles. Connected via the **transaction
pooler on port 6543** (serverless-appropriate); the driver is audited clean of
named prepared statements, session state, temp tables, LISTEN/NOTIFY, advisory
locks and held cursors. Six Supabase Storage buckets, all private, all currently
empty.

**Current production data:** 1 admin account, 1 rubric version with 8 categories
totalling 100 points, 3 system settings, 2 cohorts ("PRODUCTION TEST — DELETE
LATER" with 8 approved ideas / 1 team / 1 empty draft submission, and an
accidental cohort "tet"), 1 access code, 1 active participant session, 22 audit
entries, **0 storage objects**.

**Implemented and tested (Phase A — the submission platform):** 74 of 115
DataStore methods. One common learner URL (`/submit`); group number + 12-char
Argon2id-hashed shared access code; two-step entry with a signed 10-minute
HttpOnly handle between steps; opaque participant sessions bound to the
access-code version; six-step submission form with debounced autosave; optimistic
concurrency (version predicate in the `WHERE` clause); final submit as a
compare-and-set producing an immutable receipt; receipt PDF generated in-process;
deadline enforced from the server clock on every write (never a scheduler); pause
/ resume / manual close (typed confirmation) / reopen-with-extension; admin
cohorts, ideas with a draft→approved gate, team CSV import, access-code
issuance/revocation/lockout-clearing; append-only audit log enforced by trigger.

**Not implemented (Phase B):** 35 assessment methods and 6 ranking methods. They
throw `FeatureUnavailableError` rather than returning empty results, because an
empty queue and a zero score both look like real answers. The store declares
`capabilities: { assessment: false, ranking: false }`; four admin pages and 12
mutating actions check it and show a production-safe message; "Start judging" is
hidden. AI is not configured (`AI_PROVIDER=demo`). The worker exists but refuses
`DEMO_MODE=0`. Nothing is deployed.

**Test totals (measured):** 578 unit tests across 23 files, of which **121 are
PGlite integration tests** (Postgres 18 in WebAssembly, running the real
migration files — introduced because the machine has no Docker and no local
Postgres, so the data layer would otherwise be untestable). Plus 25 storage unit
tests, 15 fail-closed tests, 40 worker tests, and **104 Playwright E2E tests**.
Lint, typecheck and build all pass.

**Security design:** participant isolation is *structural* — `ParticipantStore`
has no method capable of reaching an assessment table, and participants have no
RLS policy on those tables or on `team_access_codes`. Access codes are hashed and
unrecoverable by design. Verification returns a byte-identical response for every
failure mode (enumeration resistance) and is rate-limited on hashed IP + group
number. Demo credentials use AES-256-GCM with a **per-field IV** (a shared IV
would be a real break). No secret is exposed to the browser; build artifacts were
scanned and are clean. `DELETE` is revoked from all application roles.

**Significant bugs already found and fixed:** (1) `$2` used as both enum and text
— caught by PGlite, would have failed on the first cohort status change; (2)
wrong `ON CONFLICT` target on submissions — would have failed for the first
learner; (3) `bytea` decoded as comma-separated byte numbers — every credential
would have been unrecoverable; (4) two concurrent final submits produced two
receipts, fixed with compare-and-set after `FOR UPDATE` proved insufficient; (5)
`#` in the database password truncated the connection URI and reported a
misleading network error; (6) `/admin` crashed on the first real production login
because only 2 of 19 gated call sites had been guarded; (7) the admin header
named the globally-active cohort instead of the one in the URL, inviting edits to
the wrong cohort; (8) demo cohort was never open before 09:00 IST.

**Known issues:** `APP_BASE_URL` still says `localhost:3000` while the server runs
on 3210 — and that value is printed on every access-code sheet. Two cohorts are
`open` simultaneously. Six files still say "invite link" though the product uses
group + code. `ADR-032` is referenced in code but missing from `DECISIONS.md`.
`BUILD_STATUS.md` is stale. The playbook PDF still describes a three-day
hackathon.

**Highest-risk untested paths:** Supabase Storage has never stored an object
(deck upload/download is mocked only); no submission has been completed end to
end in production; no real deadline has elapsed; nothing has been deployed.

**Exact recommended next step:** fix `APP_BASE_URL`, archive the spare "tet"
cohort, then complete one controlled end-to-end submission on the PRODUCTION TEST
cohort **including a real PDF upload and receipt download** — that single run
exercises the only major untested path in the submission platform. Phase B (the
35 assessment methods, PGlite-first) comes after.
