# Final launch readiness

Where the Outskill Hackathon Judge actually stands, as of 14 August 2026.

Written to be read by someone deciding whether to run a real hackathon on it.
Every line is either verified or explicitly marked as not verified.

---

## Verdict

| Question | Answer |
| --- | --- |
| **Ready for an internal Outskill demo?** | **YES** |
| **Ready for a real learner production launch?** | **NO** — four things below |

The submission platform is complete and proven against real infrastructure. The
judging pipeline is complete and has been run end to end against a real browser
and a real model. What is missing is deployment, scale evidence, and a decision
about the AI provider.

---

## 1. Verified

| Area | Result | How |
| --- | --- | --- |
| Submission acceptance | **PASS** | Manual + automated against real Supabase |
| Real Supabase Storage | **PASS** | Object present, 64,476 bytes, valid PDF, byte count matches metadata |
| Cross-team isolation | **PASS** | Two live browser contexts; zero leakage in rendered HTML |
| Wrong-team code rejection | **PASS** | A genuine code refused against two other groups |
| Collaboration conflict handling | **PASS** | Stale write refused; newer value survived; original restored |
| Pause / resume | **PASS** | Writes refused server-side, not just in the interface |
| Close / reopen | **PASS** | Editing and final submit both refused while closed |
| Code rotation | **PASS** | Only the target team rotated; sessions revoked; draft preserved |
| Final submit | **PASS** | Four concurrent attempts, exactly one accepted |
| Exactly one receipt | **PASS** | Postgres: 1 locked, 1 receipt, 1 distinct receipt, 1 event |
| Locked-write rejection | **PASS** | Field edit and artifact change both refused |
| Receipt correctness | **PASS** | Group, product, timestamp, identity — no score, rank or secret |
| Participant privacy | **PASS** | Rendered HTML and all JSON payloads swept |
| Admin deck retrieval | **PASS** | Streamed, private bucket, audited — **confirmed in a real browser** |
| Learner receipt download | **PASS** | **Confirmed in a real browser** on the real submitted receipt |
| Queue concurrency | **PASS** | 8 workers / 40 jobs on real Postgres; mutation-proved |
| Controlled browser judge | **PASS** | Real Playwright, real Gemini, 31 steps, 8/8 categories |
| Cohort archive | **PASS** | Driven by the operator, then verified read-only: `archived`, **0 of 342** sessions live, `cohort.archived` written, 3 submissions and 2 artifacts preserved |
| Learner self-service guidance | **PASS** | 44 browser tests incl. a 360px pass; zero-autofill and zero-mutation proved structurally and by driving the UI |

## 2. Repository completeness

| | |
| --- | --- |
| Assessment repository | **35 / 35** |
| Ranking repository | **6 / 6** |
| Capability flag | Verified against the interface, not asserted |

## 3. Test totals

| Suite | Count |
| --- | --- |
| Unit / integration | **1,221 passing**, 4 skipped |
| End-to-end (hermetic) | **157 passing** (includes a 5-width responsive pass) |
| Acceptance (real infrastructure) | 22 passing, 6 skipped — superseded by the staging suite, which runs against the deployment |
| Queue concurrency (real Postgres) | **4 passing** |
| Lint / typecheck / production build | clean |

The 6 acceptance skips are not failures. That suite is a one-way sequence and
group 901 is now final-submitted, so the tests describing an editable draft no
longer apply. Each states its reason.

## 4. What blocks a real learner launch

**1. Not deployed.** The application has only ever run on one laptop. No
hosting, no domain, no TLS, no worker process running anywhere. `APP_BASE_URL`
is currently a deliberately dead `.invalid` domain and must become the real
address before a single access code is issued — the code sheet carries it.

**2. Judging has never run on real learner data, by design.**
`AI_EVALUATION_MODE=synthetic_only` refuses it. Turning that off is a decision
about a free-tier provider's data-retention terms, not a configuration change.

**3. No scale evidence.** The queue is proven at 40 jobs and 8 workers. A real
cohort is 300–500 submissions with browser tests that take minutes each. Nothing
has measured that.

**4. ~~One acceptance test is intermittently flaky~~ — CLOSED.** F-17 was
compilation latency in `next dev`, not a defect in the entry flow. 100
consecutive sign-ins against the deployed production build, 100 successes, five
batches, fresh browser context each time, `retries: 0`. See the acceptance log
for the numbers and for the one caveat: the original suite cannot run against
the archived cohort, so what was re-run is the same entry sequence rather than
the identical suite.

**The remaining blocker in its place: the judging worker is not deployed.**
Nothing is judged until it is. See `docs/WORKER_DEPLOYMENT.md`.

The admin UI gap that used to sit here is closed — the operator has driven it
against real acceptance data.

## 5. Findings

### Fixed

| | Severity | What it was |
| --- | --- | --- |
| F-3 | P1 | `/submit` silently signed a device in as whoever it already was |
| F-4 | P1 | Verification was not cohort-scoped; group numbers repeat per cohort |
| F-5 | P2 | The e2e suite was poisoned by a developer's real credentials |
| F-6 | P2 | The test gate clobbered the running server's build directory |
| F-7 | **P0** | Deck uploads were recorded but never stored |
| F-8 | P1 | The draft payload shadowed the artifacts it described |
| F-9 | P1 | `byteSize` was a string wearing a number's type |
| F-12 | **P0** | A partial draft save destroyed every other step |
| F-13 | P1 | A stale tab reported success it never achieved |
| F-14 | P1 | A model got no shape for discriminated unions and guessed |
| F-15 | P1 | A browser that never loaded the product was still scored |
| F-18 | P1 | The cohort lifecycle was unreachable: no `open → closed` in the UI at all, Archive only from `finalised`, and the Archive button did not archive |
| F-19 | P2 | The shared Postgres test fixture hard-coded a 13 Aug 2026 deadline; 18 tests failed at midnight because the window had closed |

Two of these — F-7 and F-12 — would each have destroyed learner work in
production, and neither was reachable through the interface. Both were found by
running the real thing.

### Open

| | Severity | What remains |
| --- | --- | --- |
| F-1 | — | **Closed.** Secure admin deck view/download implemented |
| F-10 | — | **Not a defect.** The rate limiter working; the harness was fixed |
| F-11 | — | **Closed.** Admin UI confirmed by the operator against real data |
| F-11A | — | **Closed.** Download deck now downloads; confirmed in a real browser |
| F-16 | — | **Closed.** Learner receipt download works; confirmed in a real browser |
| F-17 | — | **Closed.** Dev-server compilation latency. 100/100 sign-ins against the deployed production build. |

**Remaining P0: none. Remaining P1: none. Remaining P2: none.**

F-18 was found by an operator looking for a button, and it hid two further
defects behind the missing one — the lifecycle could not advance at all, and the
control that did exist wrote a status column without revoking anybody's session.
The fix has since been exercised on real data: the acceptance cohort was closed
and archived through the interface, and a read-only check confirms all 342
participant sessions revoked and a `cohort.archived` entry written.

F-19 broke nothing in the product and would have broken every future working
day: a fixture pinned to the first cohort's real deadline meant eighteen tests
started failing the moment that date passed. Both fixture cohorts are now
relative to the clock.

F-11A and F-16 were both found by pressing the buttons on real data, after the
automated suite was green. F-16 in particular had never worked for anybody and
would have failed for every team at the moment they wanted proof of submission.
Neither was reachable by the tests that existed.

## 5a. Learner self-service guidance

Built so the submission flow is explained once in a session and never again per
learner: plain-English questions, rules stated before anyone types, worked
examples on request, a two-minute first-run tour, a per-step "what's missing"
list that links to the field that fixes it, a completed example page, and one
five-item help menu.

| Guarantee | How it is held |
| --- | --- |
| No autofill, anywhere | No "copy example" / "use this answer" / "generate" control exists; asserted across every learner file and driven in a browser |
| No AI answer generation | Same check; the guidance modules cannot reach a model |
| Viewing guidance mutates nothing | Guidance files import no server action and no store — proved by walking the import graph transitively, and mutation-tested by planting a write |
| The example is read-only | The page renders no input, textarea, checkbox or form at all — not a disabled one, none |
| Declarations are never pre-ticked | Each reads from the stored draft; asserted in source and in a browser |
| The example is application-owned | Invented project, group 0, `@example.com` only; no learner submission is used |
| Stated rules are the enforced rules | Every stated minimum is fed `min` and `min − 1` characters against the real schema |
| Nothing learner-facing leaks judging | Guidance surfaces swept for score, rank, evidence, confidence and shortlist fields |
| F-13 protections unchanged | The stale-save suite still passes, with the conflict wording rewritten |

### Responsive

Measured at 360 / 768 / 1280 / 1440 / 1920 by `e2e/responsive-qa.spec.ts`, which
drives the whole journey at each width and checks the document rather than the
intent: horizontal overflow, controls outside the viewport, line lengths, and
control widths. Screenshots and the raw numbers land in
`test-results/responsive-qa/`.

Seven layout defects were found this way and fixed:

| | Where | What it was |
| --- | --- | --- |
| R-1 | 360px | The page scrolled sideways — a nowrap step strip inside an `auto` grid track grew the column to 1,017px |
| R-2 | 360px | "Save and continue" was off-screen on load; a `sticky` bar cannot leave a container that begins below the fold |
| R-3 | 360px | The step list took 344px above the first question |
| R-4 | **360px** | **"Save and continue" clipped off the right edge from step two onwards** — a `shrink-0` button row held at 365px inside a 328px bar. Nothing overflowed, because the bar clipped it: the button was simply gone |
| R-5 | 640–1024px | "Need help?" sat on top of the action bar, covering the primary action |
| R-6 | 768px | The tablet inherited the phone's folded navigation — a stretched phone |
| R-7 | ≥1024px | Textareas ran to ~95 characters a line, and the footer, rubric panel and rubric table ran to 966–1,152px |

R-4 is the one worth noting: it produced no overflow and no error, and the only
symptom was a missing button on a screen size nobody had driven past step one.

All five widths now report zero overflow, zero off-screen controls, no line over
760px, and no control over 672px.

## 6. What is deliberately not built

- **Integration with the existing Outskill hackathon product** — deferred, and
  should stay deferred until this ships standalone.
- **A synthetic purge tool** — see `SYNTHETIC_CLEANUP_MANIFEST.md`. The Danger
  Zone correctly refuses to delete the acceptance cohort, and no tool should be
  written in a hurry to get around a safety check.
- **A test-only admin credential** — creating one to close F-11 would put a
  second usable admin account in a production database to make a report look
  greener.

## 7. Before a real cohort

1. Deploy, and set `APP_BASE_URL` to the real address
2. Decide the AI provider and its data terms, then set `AI_EVALUATION_MODE`
3. Run the worker somewhere, with a real browser budget
4. Load-test the queue at cohort scale
5. ~~Re-run the acceptance suite against a production build and settle F-17~~ — done; F-17 closed
6. Archive or purge the acceptance cohort
