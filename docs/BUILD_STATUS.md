# Build Status

## Current position

**All seven phases complete, plus a UX, information-architecture and branding pass.**
The platform runs end to end locally in demo mode. Nothing has been deployed.

**Gate:** lint ✅ · typecheck ✅ · 244 unit/integration tests ✅ · 67 E2E tests ✅ · build ✅

| Phase | State |
| --- | --- |
| 0 — Analysis | ✅ complete |
| 1 — Local demo | ✅ complete |
| 2 — Supabase | ✅ schema, RLS and storage written; driver wiring pending a project |
| 3 — Preflight and AI | ✅ complete |
| 4 — Playwright worker | ✅ complete |
| 5 — Scoring and ranking | ✅ complete |
| 6 — Hardening | ✅ complete |

---

## UX, IA and branding pass

A focused redesign on top of the working platform. No change to the assessment
logic, scoring, ranking, final-four selection, schema, routes, demo-mode
behaviour or security controls.

### The rendering defect, and its root cause

The demo home page showed the "Seeded invite links" table headings with **no
rows**. Reproduced in dev mode: the rows rendered on first load and vanished
after any hot reload.

The store is cached on `globalThis` so fixture state survives module reloading,
but the demo-only accessor tested `store instanceof MemoryDataStore`. After a
reload the class object differs from the one the cached instance was built with,
so the check returned false, `getMemoryStore()` returned null, and the invite
array was empty — headings with zero rows, in a build that otherwise passed.

Fixed by declaring the demo capability on the `DataStore` interface and
feature-detecting it (`asDemoStore`), which cannot fail across a module
boundary. Two other call sites had the same bug. Regression tests cover both the
capability check and that all six invite tokens resolve to their own team.

### Demo dates

Fixed past dates made every demo open with an expired deadline. Dates are now
derived from a session clock captured once at module load: Day 12 opened this
morning, the deadline is tomorrow at 11:59 PM IST, the shortlist is due the day
after at 10:00 AM. Frozen for the process, so a dev session and a test run stay
stable. Assessment fixtures were rebased onto the same clock so recorded events
sit in the past. The demo cohort now ships **open**, so the learner journey is
explorable without an operator changing anything first.

### What was redesigned

| Surface | Change |
| --- | --- |
| Visual system | Near-black canvas, charcoal and dark-green surfaces, off-white text, grey-green supporting text, one bright lime accent. All colour flows through `--brand-*` tokens in one file. |
| Production root | Participant-facing landing page. No demo credentials, no synthetic links, no admin detail. Admin entry is a restrained link. |
| Demo root | Marked internal, two primary entry cards, and six scenario cards rendered from the real fixture source. |
| Learner journey | Branded shell, dual-timezone deadline, six-step progress, per-step explanations, idea selection as cards, sticky action bar, save status, grouped missing fields, dedicated receipt page. |
| Admin IA | Sidebar with cohort context; Judging, Shortlist and Finalists replace Queue, Ranking and Final four. |
| Admin Overview | Run-this-cohort checklist with per-step state, metric cards, an attention list of only actionable issues, and stage-appropriate quick actions. |
| Cohorts | Cards plus a guided three-step creation drawer. Lifecycle controls state their effect before changing status. |
| Judging | Visual pipeline, needs-attention before consumption detail, and an explicit note that the average duration covers the whole pipeline while the 8-minute limit applies only to browser testing. |
| Shortlist | Labelled private, top entries with category breakdown and evidence links, full ranking secondary, no winner language. |
| Finalists | Four numbered slots, none pre-filled, each requiring a recorded reason. |
| Resources | Download cards grouped by audience. Storage internals moved to Settings → System diagnostics. |
| Settings | Five areas; judging configuration in minutes and counts, raw keys under Advanced. |
| Onboarding | Dismissible six-step panel on first demo sign-in, remembered locally. |

### Defects found during visual review

Reviewing the captured screenshots surfaced five issues, all fixed:

1. **Two steppers in the DOM** — one hidden per breakpoint, which meant two `nav` landmarks with the same label and a broken mobile selector. Replaced with one responsive stepper.
2. **`Card` and `Disclosure` dropped `data-testid`** — arbitrary props were not spread, so test hooks never reached the DOM. Added explicit `testId` props.
3. **"Required" validation messages** — a missing field reports Zod's type error, not the min-length one, so the review screen showed three bare "Required" lines. Added `required_error` messages throughout.
4. **Sticky action bar could obscure the last field.** Added bottom clearance and reflowed the bar on small screens.
5. **Duplicated completion percentage** and an "Export top 10" label that was wrong whenever the shortlist target was not 10.

Playwright also empties `test-results/` before each run, which was deleting the
review screenshots; its own artefacts now go to a subfolder.

### Tests added

| Area | Where |
| --- | --- |
| Demo dates are never expired; clock frozen per process | `packages/shared/src/fixtures/demo.test.ts` |
| Demo capability survives module reloading; six tokens resolve | same |
| Dark theme tokens applied; lime CTA with black text; no default Tailwind blue | `e2e/branding.spec.ts` |
| Six scenario cards; every learner link opens a valid invite route | `e2e/demo-home.spec.ts` |
| Six-step indicator, per-step explanations, idea cards, masked password, receipt | `e2e/participant.spec.ts` |
| No admin navigation, no scores/rank/evidence on portal or receipt | same |
| Operator navigation labels; checklist with states; attention list | `e2e/admin.spec.ts` |
| Guided cohort creation; lifecycle effects explained | same |
| Judging shows no milliseconds; usage detail collapsed | same |
| Shortlist labelled private, no winner language | same |
| Finalists require exactly four | same |
| Resource cards by audience; storage detail not on the main page | same |
| Settings in minutes; raw values retained under Advanced | same |

### Screenshots

`test-results/ux-review/` — thirteen surfaces at 1440×960 and 390×844, captured
by `e2e/screenshots.spec.ts`.

---

## Acceptance criteria

| # | Criterion | State | Demonstrated by |
| --- | --- | --- | --- |
| 1 | Demo cohort works end to end | ✅ | `DEMO_MODE=1 npm run dev` — six teams, full pipeline output, ranking |
| 2 | Participant submits via secure invite | ✅ | `e2e/participant.spec.ts` — invite access, six steps, lock, receipt |
| 3 | Participant sees no judging information | ✅ | 6 negative E2E tests + `store.test.ts` participant-isolation block |
| 4 | Admin manages cohort and ideas | ✅ | `e2e/admin.spec.ts` — cohorts, all eight ideas editable |
| 5 | Shared admin password can be rotated | ✅ | `rotateAdminCredentials`; E2E asserts rotation without the current password is refused |
| 6 | PDF upload is private | ✅ | `submission-decks` bucket private; no participant SELECT policy on storage objects |
| 7 | Demo credentials are encrypted | ✅ | AES-256-GCM round-trip, tamper-detection and wrong-key tests |
| 8 | Submission can be queued | ✅ | `enqueueCohort`; lease-based claim tests |
| 9 | Demo assessment produces preflight, test, evidence, score, feedback | ✅ | Fixture cohort carries all five; admin detail view renders each |
| 10 | Worker tests a controlled sample app | ✅ | 30 worker tests against the fixture app's known defects |
| 11 | Rubric totals exactly 100 | ✅ | Compile-time type proof, runtime import guard, DB constraint trigger, unit test |
| 12 | Every score has evidence | ✅ | Evidence rows per category; `validateScoreCeilings` rejects an evidence-free category |
| 13 | Low confidence is flagged | ✅ | Group 61 fixture; threshold check raises a manual-review flag |
| 14 | Eligible submissions are ranked | ✅ | Ranking snapshot excludes draft, unreachable and manual-review cases |
| 15 | Top 10 remains private | ✅ | No participant route can reach it; RLS grants no policy; E2E asserts it |
| 16 | Admin selects exactly four | ✅ | `validateFinalSelection` + E2E asserting fewer than four is refused |
| 17 | Participant report remains private | ✅ | `isExposedToParticipant` defaults false; no Version 1 route reads it |
| 18 | Historical calibration does not depend on old websites | ✅ | Text-only calibration; no historical URL is ever fetched |
| 19 | No PII or private source file is committed | ✅ | `git ls-files \| grep reference-materials` → 0 |
| 20 | Lint, typecheck, tests and build pass | ✅ | `npm run verify` + `npm run test:e2e` |

All twenty still hold after the redesign. Participant isolation, the security
controls, the scoring and ranking logic, the schema and the assessment pipeline
were not modified.

---

## Security review (Phase 6 checklist)

| Check | Result |
| --- | --- |
| Participant routes cannot reach any assessment table | ✅ `ParticipantStore` exposes 8 methods, none touching assessment data; 6 negative E2E tests |
| SSRF blocklist verified against the full address table | ✅ 23 address-classification tests including IPv4-mapped IPv6 and boundary cases |
| Prompt-injection fixture does not alter a worker run | ✅ Worker test: the run follows the plan, not the page |
| Credentials absent from every AI payload | ✅ `packages/ai` never references a credential field; `assertNoCredentials` throws if one appears |
| Credentials absent from logs and traces | ✅ Executor masks them; worker test asserts the secret is absent from the whole result |
| Admin session flags, CSRF, rate limit, lockout verified | ✅ Unit tests for lockout; E2E for identical failure messages and rotation refusal |
| Storage buckets private; signed URLs expire | ✅ All six `public = false`; access only via short-lived signed URLs |
| `git ls-files` proves no reference material or PII is tracked | ✅ 0 matches |
| Rubric sums to exactly 100 | ✅ Four independent guards |
| No code path selects a winner without an admin action | ✅ `setFinalSelection` has exactly one caller, behind `requireAdmin()` + CSRF |

---

## What was built

| Area | Detail |
| --- | --- |
| Monorepo | npm workspaces; `apps/web`, `apps/worker`, `packages/shared`, `packages/ai` |
| Participant portal | `/submit/[token]`, six autosaving steps, review, typed FINAL SUBMIT, receipt, lock |
| Admin portal | 13 routes, 11-tab submission detail, override, disqualification, ranking, final four |
| Database | 34 tables, 3 migrations, RLS for three roles, six private buckets |
| AI | Provider-independent adapter, deterministic demo provider, versioned prompts, two-layer redaction, injection containment |
| Worker | Preflight (13 checks), DSL executor, SSRF guard, deep browser testing, evidence capture, fixture app |
| Tests | 229 unit/integration, 30 worker (browser), 26 E2E |
| Docs | PRD, architecture, threat model, ERD, build plan, decisions, reference analysis, admin playbook, deployment runbook |
| Deck | 11-slide internal briefing, generated programmatically in black/white/green |

---

## Notable findings during the build

1. **The playbook's stability checklist became the browser-test assertion set.** Teams are measured against the standard they were taught — core flow twice, no dead ends, CRUD works, data persists — which is what makes the stability category defensible rather than arbitrary.
2. **The playbook's MoSCoW output maps one-to-one onto submission Step 2**, so the form asks for something teams already wrote, and the test planner gets a team-authored definition of the core flow.
3. **The eighteen historical data-quality failures each became a specific validation** (`reference-analysis.md` §5) rather than a warning in the instructions.
4. **No Outskill green exists in any supplied asset** — the deck template uses the stock Google Slides theme. The brand green is a documented, configurable placeholder (ADR-014).
5. **The E2E suite caught a real defect**: a closure was being passed from a Server Component to a Client Component for CSV export, which crashed two admin pages in a production build but not in tests that never rendered them.
6. **The SSRF guard blocked our own fixture app**, which is the guard working correctly. Rather than weakening it, the executor gained an explicit test-only opt-in that still enforces scheme and same-origin, and is refused outright when `NODE_ENV=production`.

---

## Open items for Outskill

None blocking. Full detail in `reference-analysis.md` §7 and `DEPLOYMENT_RUNBOOK.md` §12.

1. **Real brand green** — a placeholder is in use.
2. **Playbook revision** — it still describes a three-day hackathon and the old submission portal, and is internally inconsistent on demo length (3–5 min vs 2–3 min). Learners will read it.
3. **Curriculum review of the extended idea definitions** — ours are an interpretation of two-sentence source descriptions.
4. **Deck template size** — 8.3 MB, served through a signed URL; a compressed variant would help on slow connections.
5. **Postgres driver wiring** — the schema is complete; the worker deliberately refuses to run with `DEMO_MODE=0` rather than silently assessing fixtures.

---

## Requires approval before proceeding

Per the working rules, the build stopped short of anything irreversible or paid:

- No Supabase project created.
- No AI provider account or key.
- No deployment of any kind.
- No production data touched.

`DEPLOYMENT_RUNBOOK.md` documents exactly what each step would involve.
