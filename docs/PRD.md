# PRD — Outskill Hackathon Judge

**Version:** 1.0 (Version 1 scope)
**Status:** approved by build brief; implementation in progress
**Owner:** Outskill internal team (shared admin account)

---

## 1. Problem

Outskill runs a 14-day AI accelerator. The hackathon occupies Days 12–13, and 300–500 teams submit by 11:59 PM IST on Day 13. A private top-10 shortlist must exist by 10:00 AM IST on Day 14 — roughly **ten hours** for everything between deadline and shortlist.

Today that path is three manual processes stitched together:

1. **A Google Form** that produces unstructured, frequently malformed submissions (group numbers in the wrong format, decks that are actually Loom links, credentials pasted into URL fields, Drive folders instead of applications, links that were never accessible).
2. **External mentors** who each open a few products, form an impression, and write freehand feedback. Coverage is uneven, standards drift between reviewers, and nobody actually exercises the product deeply.
3. **Manual collation** of scores, notes and shortlist recommendations across spreadsheets and chat.

The result: outcomes that are hard to defend, feedback that is generic, and a ten-hour window that only works because reviewers cut depth.

## 2. What we are building

An internal platform that takes a hackathon submission from intake to a defensible, evidence-backed private ranking — where "evidence" means a real browser actually drove the submitted product.

It does not pick winners. It produces a private top 10; humans choose four.

## 3. Goals and non-goals

### Goals

| # | Goal | Measure |
| --- | --- | --- |
| G1 | Replace the Google Form with structured, validated intake | Zero malformed submissions reaching assessment; every field typed and validated |
| G2 | Assess every eligible submission to the same depth | 100% of eligible submissions receive preflight + test plan + browser run + scored rubric |
| G3 | Make every score defensible | Every category score carries supporting evidence, contradictory evidence, missing evidence, and confidence |
| G4 | Meet the Day-14 10:00 AM deadline at 500 submissions | Projected completion time visible and under budget at the configured concurrency |
| G5 | Keep judging invisible to learners | No participant-reachable route exposes scores, evidence, ranking, shortlist or feedback |
| G6 | Keep humans in control of outcomes | System proposes; admin overrides, disqualifies, restores, and selects exactly four |
| G7 | Protect participant data | Credentials encrypted at rest and never sent to AI; PII redacted before any model call |

### Non-goals for Version 1

- No participant-facing results, scores, ranking, or feedback surface. Feedback reports are generated and stored privately, exposed to nobody outside admin.
- No public leaderboard, announcement, or notification system.
- No participant accounts, signup, or password reset. Access is a group number plus a shared team access code.
- No integration with Circle or any other community platform. The submission URL is pasted into Circle by hand, and no code in this system knows Circle exists (ADR-026).
- No per-member login. Everyone on a team edits the same entry under the same code.
- No admin signup or multi-user admin roles. One shared account.
- No mobile-native app testing, browser-extension testing, or hardware testing — these route to manual review.
- No paid queue infrastructure. Postgres `FOR UPDATE SKIP LOCKED` is the queue.
- No automatic import of historical records.
- No automatic winner selection or announcement, under any circumstance.

## 4. Users

| User | Access | Needs |
| --- | --- | --- |
| **Participant (team)** | One common URL, a group number and a shared team access code, no account | Understand the rules and deadline, submit once, edit alongside their teammates, correct mistakes before the deadline, know their submission landed |
| **Outskill internal team** | One shared admin account | Configure the cohort, watch the queue, inspect evidence, correct the machine, choose four winners, defend the outcome |
| **Assessment worker** | Service credentials, no UI | Claim jobs, drive browsers safely, record evidence |

Shared admin access is a deliberate simplification with a known cost: audit entries record the actor as `shared-admin` and **cannot** attribute an action to an individual person. This is documented in the playbook and accepted for Version 1.

## 5. Participant experience

### 5.1 Access

Every team in production uses the **same URL** — `/submit` — and identifies itself with two things Outskill issues: a **group number** and a **shared team access code**. There is no account, no password and no signup.

Outskill pastes that one URL into Circle by hand. There is deliberately no Circle integration, no iframe and no API in either direction: this platform knows nothing about where a learner arrived from, and nothing in the submission flow depends on another product being available (ADR-026). A per-team URL was rejected because the first team to forward or screenshot theirs hands its submission to everyone reading (ADR-027).

Access codes are twelve characters from a thirty-character alphabet with the misread characters removed — no `O`, `0`, `I`, `1`, `L` or `U` — grouped for reading aloud as `ABCD-EFGH-JKMN`. They are hashed with Argon2id and shown exactly once, at generation. Nothing can retrieve one afterwards, including an admin: a lost code is replaced, never resent. Codes are versioned, so regenerating one invalidates every session opened under the old code in a single write.

Verification is rate limited to eight attempts per fifteen minutes per hashed IP **and** group number, with a fifteen-minute lockout an admin can clear immediately. Keying on both means one hostile client cannot lock out a legitimate team, and one team fumbling its code cannot lock out an office behind a shared address. Every failure — unknown group, wrong code, revoked code, withdrawn team — returns one identical message, so the form cannot be used to discover which group numbers exist.

Entry is two steps: verify the code, then say who is editing. The name is an **activity label, not verified identity** — anyone holding the shared code can type anything, and nothing security-relevant depends on it (ADR-029). Between the two steps the verified team is carried in an HttpOnly cookie holding a short-lived signed assertion, never a bare team id (ADR-028). After that the team holds an opaque session cookie scoped to `/submit`; the access code itself never travels again, and never appears in a URL, in history, in logs, or in client-side storage.

The per-team invite route `/submit/[token]` still exists for the demo fixtures and for any invite distributed before the common entry existed. No production team needs one.

### 5.2 What a participant can see

Cohort name and instructions; the deadline in their own local time alongside IST; the approved product ideas for their cohort; the public rubric categories and weights; a download link for the pitch-deck template; the two-day submission guide; their own draft; a learner-safe record of what their teammates have been doing; and, after submitting, their own receipt on screen and as a PDF.

### 5.3 What a participant can never see

Any other team; internal test plans; browser evidence; category or total scores; confidence; ranking; the top 10; internal or participant feedback reports; disqualification discussion; the final-four workspace; AI prompts; anti-gaming rules.

This is enforced structurally — every participant route resolves the session cookie server-side to exactly one submission, no request carries a submission or team id that is trusted, and the query layer has no path from a participant session to assessment tables — not by hiding UI.

### 5.4 The form

Six autosaving steps, then a review-and-confirm gate.

| Step | Captures | Notes |
| --- | --- | --- |
| 1. Team | Group number, lead name/email/phone, active members and each member's broad contribution | Structured rows, not free text |
| 2. Product | Approved idea (exactly one), product name, primary user, exact problem, one-sentence promise, description, why AI is necessary, differentiation, single must-have workflow, up to two should-haves, deliberately excluded features | Mirrors the playbook's MoSCoW output — teams already wrote this |
| 3. Live product | HTTPS URL, whether login is required, core test steps with expected result per step, safe sample inputs, reset/cleanup instructions, known limitations | Conditional: demo username, demo password, login instructions — AES-256-GCM encrypted |
| 4. Artifacts | PDF pitch deck (upload), demo video link, ≤3-minute confirmation | Optional: transcript, screenshots |
| 5. Learning evidence | Three important bugs fixed, one deliberately excluded feature, one major trade-off, what changed Day 12 → Day 13, most important learning, next-seven-day plan, builder/stack, APIs/services, external templates or starter code used | Mirrors the playbook's bug log and reflection |
| 6. Declarations | Seven required declarations including consent for the automated judge to create/edit/delete demo data | All must be affirmatively checked |

Drafts autosave. Teams may edit freely while the cohort is open. **Final Submit** requires passing full validation and typing `FINAL SUBMIT`, then stamps `submitted_at`, issues a receipt ID, and locks learner editing. An admin can reopen a submission; reopening is audit-logged and visible to the team.

**Any member with the code may edit, and everyone edits the same entry.** Two people working at once is the normal case on Day 13, so writes are not last-write-wins: every save carries the version the client read, and a write that is behind is refused with a plain explanation rather than allowed to overwrite a teammate silently (ADR-030). The team sees a small activity panel — who opened the submission, who saved which section, who uploaded the deck, who saved the demo link, who opened the review, who made the final submission. That is the complete set, and it is separate from the internal audit log, which a learner never sees.

**Final Submit produces a receipt** on screen and as a downloadable PDF. The PDF is generated in-process — no external or paid service sees a participant's details — and carries the cohort, group number, product, idea, who submitted, when, and the receipt ID. It carries no access code, no credentials and no internal identifiers, and a safety assertion refuses to produce one that does. A team quoting its receipt ID in a support message is enough for an admin to find the submission.

### 5.5 The submission window

Whether a team may write is decided from the **server clock on every write** — every draft save, upload, removal and final submit. A browser clock is never an input, and correctness never depends on a scheduled job having run (ADR-031): a cohort still marked open past its deadline stops accepting writes at the deadline, whatever any scheduler did or did not do.

Outskill can:

- let the deadline close the window automatically;
- **close early**, guarded by a typed confirmation, because that is the moment several hundred teams lose the ability to edit;
- **pause**, which leaves teams able to read their entry but not change it;
- **reopen**, with a recorded reason.

Reopening after the official deadline **requires** either a new deadline or an explicit acceptance-until time. Without one the cohort would read as open while rejecting every save, which is the most confusing state this system could present to a team that has just been told they may resubmit.

### 5.6 The two-day guide

A written guide to Days 12 and 13 — what to build, what to prepare, how to submit, and what to do when something goes wrong — at `/submit/guide`, with a PDF at `/api/guide`. Both are built from one source, so a team working from the printout and a team working from the screen follow identical instructions.

It is readable **without signing in**: a team looking it up at 2am should not have to find their access code first, and there is nothing in it worth protecting. It is deliberately silent about how anything is scored beyond the public category weights. The admin playbook stays admin-only.

## 6. Assessment

### 6.1 Pipeline

`queued → preflight → artifact_analysis → test_plan_generation → browser_testing → evidence_review → scoring → consistency_review → completed`, with `manual_review`, `failed`, and `disqualified` as terminal or holding states.

### 6.2 Preflight

Completeness, deadline compliance, approved-idea membership, URL validity, DNS and HTTP reachability, HTTPS, redirect behaviour, deck readability, demo-link access, credential presence when login is required, duplicate detection, unsafe-URL screening, and product-type support.

Inaccessible products are retried on a backoff schedule with every attempt recorded, and failures are classified — timeout, DNS, auth, server error, blocked access — because a temporary outage must never be treated as a failed product.

### 6.3 Testing boundary

Automated deep testing applies to public HTTPS web applications reachable as a guest or with supplied demo credentials, with no CAPTCHA, no mandatory phone OTP, no mandatory email verification, no real payments, no real outbound email/SMS, and no production customer data.

Anything else — native mobile, extensions, hardware, manually installed software, unsupported auth, CAPTCHA-gated, or needing human setup — is routed to **manual review**, not penalised.

### 6.4 Deep browser testing

A fresh isolated browser context per submission, default eight-minute budget (configurable). The run covers: initial load, entry path, guest or login flow, the declared must-have workflow, CRUD where relevant, persistence across reload, navigation, the AI feature with safe test input, loading/success/error states, dead buttons, console errors, failed network calls, a mobile smoke test, keyboard accessibility, and an axe scan.

All data the judge creates is prefixed `OUTSKILL-JUDGE-` and cleaned up on a best-effort basis. Captured: screenshots, final state, trace, per-step status and timing, assertions, console errors, network failures, cleanup outcome.

### 6.5 Scoring

Fixed 100-point rubric, unchanged from the brief:

| # | Category | Points |
| --- | --- | --- |
| 1 | Problem and target-user clarity | 15 |
| 2 | Core workflow functionality | 25 |
| 3 | Stability, data and technical completeness | 15 |
| 4 | AI usefulness and differentiation | 15 |
| 5 | Learning and execution quality | 10 |
| 6 | UX and accessibility | 10 |
| 7 | Practical or commercial potential | 5 |
| 8 | Deck and demo clarity | 5 |
| | **Total** | **100** |

Every category returns raw score, weighted score, supporting evidence, contradictory evidence, missing evidence, confidence (0–1), and a concise rationale, validated against a Zod schema.

**Objective browser evidence outweighs unsupported deck claims.** A deck asserting a feature the browser could not exercise produces contradictory evidence and lowered confidence, not points.

One primary pass runs for everyone. A second consistency pass runs only for the top 20, low-confidence cases, manual-review cases, submissions within two points of the top-10 cutoff, close ties, and disputed scores. Rubric version, prompt version, and model version are frozen per cohort.

### 6.6 Ranking and selection

Eligible submissions are ranked by total score, tie-broken in order by core workflow, stability, AI usefulness, learning and execution, then fewer unresolved risks. The full ranking and the highlighted top 10 are private. Admins review evidence, override any category score with a mandatory reason, rerun stages, mark review complete, disqualify or restore, and finally select and order **exactly four** winners.

The system will not select winners. There is no code path that promotes a submission to winner without an admin action.

### 6.7 Disqualification

Permitted only for: late final submission without exception, an idea outside the approved list, missing product URL, missing PDF deck, missing demo link, an inaccessible required artifact after retries and grace, login required with no working credentials, malicious or prohibited content, interference with automated judging, a confirmed false declaration, or a confirmed serious rule violation.

Explicitly never for: weak UI, a low score, a secondary feature failing, a missing optional feature, low commercial potential, ordinary bugs, a temporary external outage, or AI suspicion without human confirmation.

Every disqualification carries a reason, evidence, admin visibility, a reversible status, and an audit entry.

### 6.8 Idea definitions are approved before they judge anyone

An idea's **title and description** come from the approved source catalogue and are always usable. Everything else on it — the minimum core flow, the expected entities, the AI opportunity, the allowed scope, the unsafe interpretations, the target user, the expected use case — is Outskill's own interpretation, written in this product, and it is what test-plan generation reads.

So an expanded definition starts as a `draft` and influences real judging only once a person has read it and approved it (ADR-025). Editing any expanded field returns it to draft automatically, because approval is of a specific wording, not of an idea in general.

## 7. Reports

**Internal report** (admin only): compliance, preflight results, test plan, browser evidence with screenshots, bugs found, scores with confidence, rank, risks, flags, model and prompt versions, and internal notes.

**Participant report** (generated, stored, **not exposed in Version 1**): product summary, three strengths, three priority improvements, bugs observed, and a next-seven-day plan. Contains no ranking, no other teams, no private flags, and no hidden scoring logic — so that exposing it in a later version is a product decision, not a redaction exercise.

## 8. Demo mode

`DEMO_MODE=1` runs the entire platform locally with no AI key, no Supabase project, and no deployed worker. Deterministic fixtures produce a full cohort: six synthetic teams and submissions covering complete, incomplete, inaccessible, login-required, manual-review and low-confidence cases, with realistic evidence, stable scores, a ranking, and four empty final-selection slots. No historical identity appears anywhere.

The root page differs by mode, deliberately. In production it is a minimal landing page: a **Start your submission** call to action pointing at `/submit`, a link to the two-day guide, a plain statement of what a team needs, and a restrained Outskill sign-in link. The exploratory demo home — scenario cards, seeded links, demo credentials — appears only when `DEMO_MODE=1`. Demo mode is also the only place a plaintext access code is ever displayed, because the memory driver generated the fixture codes itself; real codes exist as Argon2id hashes only.

## 9. Scale and cost

Designed for 300–500 submissions per cohort. Configurable worker concurrency and per-submission test duration; queue depth and ETA; retry counts; browser-minute, AI-call and token-usage accounting; projected completion time against the Day-14 10:00 AM target. AI pricing is never hard-coded — token counts are reported and priced by whatever rate the admin configures.

## 10. Retention

Defaults: demo credentials deleted at judging finalisation; traces and evidence retained 90 days; submissions and reports retained 90 days; admin may archive or delete early; every deletion is audit-logged. **No automatic deletion runs in development or demo mode.**

## 11. Acceptance criteria

The build is acceptable when all twenty criteria from the brief hold. They are tracked as a live checklist in `docs/BUILD_STATUS.md`, each mapped to the test or artifact that demonstrates it.

## 12. Open items requiring Outskill input

None are blocking. Recorded in `docs/reference-analysis.md` §7: real brand green, deck-template file size, playbook revision (still says three days), and a curriculum review of our extended idea definitions — which is the same review the approval gate in §6.8 asks for, and until it happens those definitions sit in draft.

One operational item belongs to Outskill by design: **somebody has to paste the submission URL into Circle**, and somebody has to hand each team its group number and access code. Both are manual because there is no integration and no email (ADR-024, ADR-026), so both need an owner.
