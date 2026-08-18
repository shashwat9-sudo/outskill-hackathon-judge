# Build Status

## Current position

**All seven phases complete, plus a UX, information-architecture and branding pass, plus the production learner entry.**
The platform runs end to end locally in demo mode. Nothing has been deployed.

**Gate:** lint ✅ · typecheck ✅ · 406 unit/integration tests ✅ · 104 Playwright tests ✅ · build ✅

| Phase | State |
| --- | --- |
| 0 — Analysis | ✅ complete |
| 1 — Local demo | ✅ complete |
| 2 — Supabase | ✅ schema, RLS and storage written; driver wiring pending a project |
| 3 — Preflight and AI | ✅ complete |
| 4 — Playwright worker | ✅ complete |
| 5 — Scoring and ranking | ✅ complete |
| 6 — Hardening | ✅ complete |
| Production learner entry | ✅ complete in code; unwired against a real database, like everything else |

---

## Production-readiness baseline

Recorded before the production-entry phase began, on a clean tree:

| Gate | Result |
| --- | --- |
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run test` | ✅ 244 passed (8 files) |
| `npm run test:e2e` | ✅ 67 passed |
| `npm run build` | ✅ compiled |

Starting state: 3 migrations (`0001_schema`, `0002_rls`, `0003_storage`), 29
env keys, invite-token participant access, 27 admin actions. No broken baseline
to fix.

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

## Production learner entry

The change that turned a demo-shaped intake into one a real cohort could use.
No change to assessment logic, scoring, ranking, final-four selection or the
existing security controls.

### What landed

| Area | What it is now |
| --- | --- |
| Entry | One common URL, `/submit`, with no team identifier in it. Outskill pastes it into Circle by hand — there is no Circle integration, iframe or API, and none is planned (ADR-026). |
| Credential | Group number plus a shared team access code: 12 characters, 30-character alphabet without `O`/`0`/`I`/`1`/`L`/`U`, formatted `ABCD-EFGH-JKMN`, Argon2id-hashed, versioned, shown once (ADR-027). |
| Anti-enumeration | One identical failure message for every cause, so the form cannot be used to discover which group numbers exist. |
| Rate limiting | 8 attempts per 15 minutes per hashed IP **and** group, 15-minute lockout, cleared by an admin in one click. |
| Entry flow | Two steps — verify, then "who is editing" — bridged by an HttpOnly cookie holding a signed 10-minute HMAC assertion, never a bare team id (ADR-028). |
| Session | Opaque 32-byte token, only a hash of it stored, cookie `ohj_team_session` (HttpOnly, `SameSite=Lax`, `path=/submit`), bound to the access-code version so regeneration revokes everything at once. |
| Shared editing | Any member with the code edits the same entry. `submissions.version` refuses a stale write instead of overwriting a teammate (ADR-030), and a learner-safe activity feed of six event kinds shows who did what. |
| Submission window | Computed from the server clock on every write (ADR-031). Automatic deadline, manual close behind a typed `CLOSE SUBMISSIONS`, pause/resume, reopen with a reason, and reopen-with-extension — which is *required* after the deadline. |
| Receipt | On-screen plus a PDF at `/submit/receipt`: session-only, generated in-process, and asserted to carry no code, credential or internal id before the bytes exist. Admins can look a submission up by receipt ID. |
| Guide | Two-day submission guide at `/submit/guide` and `/api/guide`, one source for both, readable without signing in. The admin playbook stays admin-only. |
| Idea definitions | `draft` / `approved`, with the expanded fields influencing real judging only once approved, and any edit returning them to draft (ADR-025). |
| Operations | `/api/health` (200/503, reveals nothing), worker `/healthz` and `/readyz` (liveness vs readiness — a worker inside a browser run is **busy**, not stalled), and `apps/worker/Dockerfile` on the Playwright base image, non-root. |
| Production root | A minimal landing page with a *Start your submission* call to action and the guide link. The exploratory demo home appears only under `DEMO_MODE=1`. |
| Schema | `0004_production_entry.sql`: four new tables, submission versioning, cohort closure and reopening columns, idea-definition approval. Forward-only; nothing dropped or rewritten. |

### RLS posture of the new tables

Admin has full access to all four. Participants get **SELECT on `team_activity`
for their own team only**, and **no policy at all** on `team_access_codes`,
`participant_sessions` or `verification_attempts` — a participant role able to
read access codes could enumerate the cohort, which is exactly what the generic
error message exists to prevent. The migration says so at the point where
someone would otherwise add one. The worker gets nothing on any of the four.

### Tests added

| Area | Where |
| --- | --- |
| Code generation, alphabet exclusions, normalisation, verification, rate-limit arithmetic | `packages/shared/src/security/access-code.test.ts` |
| Session tokens, keyed hashing, editor-name validation, session lifetime and validity, cookie scoping | `packages/shared/src/security/participant-session.test.ts` |
| Window states, deadline enforcement, extension handling, reopen validation | `packages/shared/src/domain/submission-window.test.ts` |
| Stale-write refusal, activity vocabulary, relative time | `packages/shared/src/domain/concurrency.test.ts` |
| Receipt PDF structure and the safety assertion | `packages/shared/src/domain/receipt-pdf.test.ts` |
| Worker liveness vs readiness, staleness limits, draining | `apps/worker/src/health.test.ts` |
| Verification, generic failure message, rate limiting and lockout clearing, code issue and revocation, session revocation on regeneration, shared editing, window enforcement | `packages/shared/src/data/memory/store.test.ts` |
| Common entry, identical failure messages, code absent from URL/history/storage, editor name, session forgery, isolation | `e2e/submit-entry.spec.ts` |
| Guide without sign-in, access-code screens, closing and reopening, receipt lookup, idea approval, health | `e2e/operations.spec.ts` |

### Verified

| Gate | Result |
| --- | --- |
| `npm run lint` | ✅ clean |
| `npm run typecheck` | ✅ clean |
| `npm run test` | ✅ 406 passed (15 files) |
| `npm run test:e2e` | ✅ 104 passed (7 files) |
| `npm run build` | ✅ compiled |

### Explicitly NOT done

Stated plainly, because a green gate above says nothing about any of this:

1. **The postgres driver is still unwired.** `getStore()` throws when
   `DEMO_MODE=0`, and the worker refuses to start. Everything above has been
   exercised against the memory driver only. Failing loudly is deliberate —
   silently serving fixtures in production would be far worse — but it means
   no line of this has run against real Postgres, RLS or Supabase Storage.
2. **No Supabase project exists.** `0004_production_entry.sql` has never been
   applied anywhere. The RLS posture described above is what the migration
   says, not something a database has confirmed.
3. **No AI provider account or key.** Everything AI-shaped runs on the
   deterministic demo provider.
4. **Nothing is deployed.** No web host, no worker container, no egress policy.
   The Dockerfile is written and its version-pinning rule is documented; no
   container has been deployed anywhere.
---

## Acceptance criteria

| # | Criterion | State | Demonstrated by |
| --- | --- | --- | --- |
| 1 | Demo cohort works end to end | ✅ | `DEMO_MODE=1 npm run dev` — six teams, full pipeline output, ranking |
| 2 | Participant submits via secure access | ✅ | `e2e/submit-entry.spec.ts` — common URL, group number and access code, editor name, session; `e2e/participant.spec.ts` — six steps, lock, receipt |
| 3 | Participant sees no judging information | ✅ | Negative E2E tests on the portal, the receipt and the new entry flow, plus the `store.test.ts` participant-isolation block |
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

All twenty still hold after the redesign and after the production learner entry.
The scoring and ranking logic, the assessment pipeline and the existing security
controls were not modified; the entry work added tables and routes rather than
changing any of them.

---

## Security review (Phase 6 checklist)

| Check | Result |
| --- | --- |
| Participant routes cannot reach any assessment table | ✅ `ParticipantStore` exposes 14 methods, every one resolving the session server-side and none touching assessment data; negative E2E tests on the portal, the receipt and the entry flow |
| Every verification failure returns one identical message | ✅ Unit tests on the message; E2E asserts a wrong code and an unknown group are indistinguishable |
| No participant policy on the three sensitive entry tables | ✅ `0004_production_entry.sql` grants none, and says why at the point someone would add one |
| The access code never reaches a URL, history or client storage | ✅ E2E inspects the URL, the history entries and both web storages after signing in |
| An invented session cookie does not open the portal | ✅ `e2e/submit-entry.spec.ts` |
| Regenerating a code ends every session under the old one | ✅ Version-binding unit tests plus a store integration test |
| A stale write is refused rather than applied | ✅ `concurrency.test.ts` and the shared-editing block in `store.test.ts` |
| The receipt PDF carries no code, credential or internal id | ✅ `assertReceiptSafe` throws before bytes exist; asserted for all three |
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
| Participant entry | One common `/submit`, group number plus shared access code, two-step entry, opaque session, shared editing, activity feed |
| Participant portal | `/submit/portal`, six autosaving steps, review, typed FINAL SUBMIT, receipt on screen and as a PDF, lock |
| Participant reading | `/submit/guide` and `/api/guide`, readable without signing in, one source for page and PDF |
| Admin portal | 18 page routes, 36 admin actions, 11-tab submission detail, access codes, closure controls, receipt lookup, override, disqualification, ranking, final four |
| Database | 38 tables, 4 migrations, RLS for three roles, six private buckets |
| AI | Provider-independent adapter, deterministic demo provider, versioned prompts, two-layer redaction, injection containment |
| Worker | Preflight (13 checks), DSL executor, SSRF guard, deep browser testing, evidence capture, fixture app, `/healthz` and `/readyz`, Playwright-based container image |
| Operations | `/api/health`, 30 validated environment keys, config that refuses to boot when it is wrong |
| Tests | 406 unit/integration (including 30 worker browser tests), 104 Playwright |
| Docs | PRD, architecture, threat model, ERD, build plan, decisions, reference analysis, admin playbook, deployment runbook, learner journey, admin operations, branding |
| Deck | 11-slide internal briefing, generated programmatically in black/white/green |

---

## Notable findings during the build

1. **The playbook's stability checklist became the browser-test assertion set.** Teams are measured against the standard they were taught — core flow twice, no dead ends, CRUD works, data persists — which is what makes the stability category defensible rather than arbitrary.
2. **The playbook's MoSCoW output maps one-to-one onto submission Step 2**, so the form asks for something teams already wrote, and the test planner gets a team-authored definition of the core flow.
3. **The eighteen historical data-quality failures each became a specific validation** (`reference-analysis.md` §5) rather than a warning in the instructions.
4. **No Outskill green exists in any supplied asset** — the deck template uses the stock Google Slides theme. The brand green is a documented, configurable placeholder (ADR-014).
5. **The E2E suite caught a real defect**: a closure was being passed from a Server Component to a Client Component for CSV export, which crashed two admin pages in a production build but not in tests that never rendered them.
6. **The SSRF guard blocked our own fixture app**, which is the guard working correctly. Rather than weakening it, the executor gained an explicit test-only opt-in that still enforces scheme and same-origin, and is refused outright when `NODE_ENV=production`.
7. **The access-code constants had to be split from the access-code code.** The entry form is a client component and needs the expected length and the failure message; `access-code.ts` imports `node:crypto` and Argon2 and must never enter a browser bundle. The constants file has no imports at all, which is what makes it safe to re-export through `@ohj/shared/client`.
8. **Reopening a cohort is the state most likely to be got wrong**, not closing it. Reopening after the deadline without an extension produces a cohort that reads as open and rejects every save — so the shared validator refuses it, and the form asks for the acceptance time up front rather than letting an operator meet that refusal by surprise.
9. **The Playwright base-image tag must track the resolved version, not the range.** The image bundles specific browser builds, so a client/browser mismatch fails at runtime rather than at build time. The Dockerfile says so, next to the tag.

---

## Open items for Outskill

None blocking. Full detail in `reference-analysis.md` §7 and `DEPLOYMENT_RUNBOOK.md` §12.

1. **Real brand green** — a placeholder is in use.
2. **Playbook revision** — it still describes a three-day hackathon and the old submission portal, and is internally inconsistent on demo length (3–5 min vs 2–3 min). Learners will read it.
3. **Curriculum review of the extended idea definitions** — ours are an interpretation of two-sentence source descriptions.
4. **Deck template size** — 8.3 MB, served through a signed URL; a compressed variant would help on slow connections.
5. **Postgres driver wiring** — the schema is complete through `0004_production_entry.sql`; the web app throws and the worker refuses to start with `DEMO_MODE=0` rather than silently serving or assessing fixtures.
6. **Approve the expanded idea definitions** for the cohort before judging starts. Until then they sit in draft and do not influence real judging (ADR-025).
7. **Agree who pastes the submission URL into Circle, and when.** It is a manual step by design (ADR-026), which means it is also a step someone has to own.

---

## Requires approval before proceeding

Per the working rules, the build stopped short of anything irreversible or paid:

- No Supabase project created.
- No AI provider account or key.
- No deployment of any kind.
- No production data touched.

`DEPLOYMENT_RUNBOOK.md` documents exactly what each step would involve.
