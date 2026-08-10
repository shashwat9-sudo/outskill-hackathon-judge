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
- No participant accounts, signup, or password reset. Access is an invite token.
- No admin signup or multi-user admin roles. One shared account.
- No mobile-native app testing, browser-extension testing, or hardware testing — these route to manual review.
- No paid queue infrastructure. Postgres `FOR UPDATE SKIP LOCKED` is the queue.
- No automatic import of historical records.
- No automatic winner selection or announcement, under any circumstance.

## 4. Users

| User | Access | Needs |
| --- | --- | --- |
| **Participant (team)** | One invite link per team, no account | Understand the rules and deadline, submit once, correct mistakes before the deadline, know their submission landed |
| **Outskill internal team** | One shared admin account | Configure the cohort, watch the queue, inspect evidence, correct the machine, choose four winners, defend the outcome |
| **Assessment worker** | Service credentials, no UI | Claim jobs, drive browsers safely, record evidence |

Shared admin access is a deliberate simplification with a known cost: audit entries record the actor as `shared-admin` and **cannot** attribute an action to an individual person. This is documented in the playbook and accepted for Version 1.

## 5. Participant experience

### 5.1 Access

Admin imports teams by CSV, the system generates a cryptographically random invite token per team, stores only its hash, and produces a CSV of group number + lead email + invite URL for distribution. Tokens are revocable and regenerable.

Participants land on `/submit/[token]`. No login, no password, no account.

### 5.2 What a participant can see

Cohort name and instructions; the deadline in their own local time alongside IST; the approved product ideas for their cohort; the public rubric categories and weights; a download link for the pitch-deck template; their own draft; and, after submitting, their own receipt.

### 5.3 What a participant can never see

Any other team; internal test plans; browser evidence; category or total scores; confidence; ranking; the top 10; internal or participant feedback reports; disqualification discussion; the final-four workspace; AI prompts; anti-gaming rules.

This is enforced structurally — the participant route resolves a token to exactly one submission and the query layer has no path from a participant session to assessment tables — not by hiding UI.

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

## 7. Reports

**Internal report** (admin only): compliance, preflight results, test plan, browser evidence with screenshots, bugs found, scores with confidence, rank, risks, flags, model and prompt versions, and internal notes.

**Participant report** (generated, stored, **not exposed in Version 1**): product summary, three strengths, three priority improvements, bugs observed, and a next-seven-day plan. Contains no ranking, no other teams, no private flags, and no hidden scoring logic — so that exposing it in a later version is a product decision, not a redaction exercise.

## 8. Demo mode

`DEMO_MODE=1` runs the entire platform locally with no AI key, no Supabase project, and no deployed worker. Deterministic fixtures produce a full cohort: six synthetic teams and submissions covering complete, incomplete, inaccessible, login-required, manual-review and low-confidence cases, with realistic evidence, stable scores, a ranking, and four empty final-selection slots. No historical identity appears anywhere.

## 9. Scale and cost

Designed for 300–500 submissions per cohort. Configurable worker concurrency and per-submission test duration; queue depth and ETA; retry counts; browser-minute, AI-call and token-usage accounting; projected completion time against the Day-14 10:00 AM target. AI pricing is never hard-coded — token counts are reported and priced by whatever rate the admin configures.

## 10. Retention

Defaults: demo credentials deleted at judging finalisation; traces and evidence retained 90 days; submissions and reports retained 90 days; admin may archive or delete early; every deletion is audit-logged. **No automatic deletion runs in development or demo mode.**

## 11. Acceptance criteria

The build is acceptable when all twenty criteria from the brief hold. They are tracked as a live checklist in `docs/BUILD_STATUS.md`, each mapped to the test or artifact that demonstrates it.

## 12. Open items requiring Outskill input

None are blocking. Recorded in `docs/reference-analysis.md` §7: real brand green, deck-template file size, playbook revision (still says three days), and a curriculum review of our extended idea definitions.
