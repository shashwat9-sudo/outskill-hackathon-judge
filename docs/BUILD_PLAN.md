# Build Plan

Seven phases. Every phase ends with lint, typecheck, unit tests, and build all passing, a `docs/BUILD_STATUS.md` update, and a git commit. Failures are fixed before the next phase starts.

---

## Phase 0 — Analysis ✅

Protect private material, derive the historical calibration files, read the three supplied sources, and write the documentation the rest of the build is measured against.

| Deliverable | State |
| --- | --- |
| `.gitignore` excluding `reference-materials/` before anything else | done |
| Three derived historical Markdown files | done |
| PPTX + 2 PDFs inspected and sanitised | done |
| `docs/reference-analysis.md` | done |
| `docs/PRD.md` · `ARCHITECTURE.md` · `THREAT_MODEL.md` · `DATABASE_ERD.md` · `BUILD_PLAN.md` · `DECISIONS.md` · `BUILD_STATUS.md` | done |

**Exit:** documentation self-reviewed; private material verified untracked by `git ls-files`.

---

## Phase 1 — Local demo

The whole product, running locally, with no external dependency. This is the phase that proves the design; later phases swap fixtures for real infrastructure behind unchanged interfaces.

1. **Monorepo** — npm workspaces, TypeScript project references, ESLint flat config, Vitest, shared `tsconfig.base.json`, `.env.example`.
2. **`packages/shared` core** — rubric (with the sum-to-100 assertion), Zod schemas for all six submission steps, status transition tables, deadline evaluation, eligibility and disqualification rules, tie-break comparator, URL/SSRF validation, invite-token hashing, AES-256-GCM envelope, Argon2id helpers, the test-action DSL.
3. **Data layer** — repository interfaces plus the deterministic `memory` driver. Application code never imports a driver directly.
4. **Design system** — Tailwind, brand tokens (black / white / Outskill green), and the accessible component set: button, input, textarea, select, checkbox, radio, field, form-error, card, badge, table, tabs, dialog, toast, progress, stepper.
5. **Participant portal** — `/submit/[token]`: cohort details, dual-timezone deadline, approved ideas, public rubric, deck-template download, six autosaving steps, review screen, typed-confirmation final submit, receipt, post-submit lock.
6. **Admin portal** — login plus all thirteen routes and the eleven submission-detail tabs, reading from the demo driver.
7. **Fixtures** — one cohort, eight ideas, six synthetic teams and submissions spanning complete / incomplete / inaccessible / login-required / manual-review / low-confidence, with evidence, deterministic scores, a ranking, and four empty final-selection slots.
8. **Route isolation** — participant routes structurally unable to reach assessment data, with negative tests proving it.
9. **Tests** — unit + component + the first integration and E2E passes.

**Exit:** `DEMO_MODE=1 npm run dev` demonstrates the full journey end to end; acceptance criteria 1–5, 8–9, 11–17 demonstrable against fixtures.

---

## Phase 2 — Supabase

Replace the memory driver with real Postgres, without changing a single call site.

1. SQL migrations for all 34 tables with constraints, foreign keys, indexes, and safe cascades.
2. The rubric sum-to-100 constraint trigger and the `action` CHECK on `test_plan_steps`.
3. RLS policies for the three roles, including the deliberate *absence* of participant SELECT policies on assessment tables.
4. Six private storage buckets and signed-URL minting.
5. The `postgres` repository driver, satisfying the same interfaces as `memory`.
6. Real invite generation, CSV import/export, real draft and final submission, encrypted credential storage.
7. Integration tests runnable against both drivers — the same suite, two backends.

**Exit:** the app runs identically on either driver; acceptance criteria 6–7 demonstrable.

---

## Phase 3 — Preflight and AI

1. **Preflight engine** — all thirteen checks, retries with backoff, per-attempt recording, and failure classification (timeout / DNS / auth / server / blocked).
2. **PDF extraction** — deck text and page-image extraction via `pdfjs-dist`, page counting, placeholder-text detection.
3. **Redaction** — PII stripping and anonymised submission IDs, with tests asserting nothing identifying survives.
4. **AI adapter** — provider-independent, config-selected, with a deterministic `demo` provider; structured output validated by Zod with bounded retries; versioned prompts; injection-defence wrapping.
5. **Artifact analysis stage**, including honest `video_analysis_limited` handling.
6. **Test-plan generation** — constrained to the DSL, validated, with rejected steps recorded rather than silently dropped.
7. **Queue** — `FOR UPDATE SKIP LOCKED` claiming, leases, heartbeats, and stale-lease reclamation.

**Exit:** a submission advances from `queued` to `test_plan_generation` with real artifacts, with or without an AI key.

---

## Phase 4 — Playwright worker

1. Worker process, config, polling loop, graceful shutdown.
2. DSL executor — one handler per action, no `evaluate`, no shell.
3. SSRF guard at plan time **and** immediately before each navigation, on resolved addresses.
4. Deep test suite: load, entry path, guest/login, must-have workflow, CRUD, persistence after reload, navigation, AI feature with safe input, loading/success/error states, dead buttons, console errors, network failures, mobile smoke, keyboard accessibility, axe scan.
5. `OUTSKILL-JUDGE-` prefixed test data and best-effort cleanup.
6. Evidence capture — screenshots, final state, trace, per-step status and timing, assertions, console, network, cleanup result.
7. **Local fixture app** with a *known* dead button, console error, failing request, and accessibility violation, so detection is proven against ground truth.
8. Worker tests: safe URL accepted, private URL rejected, timeout handled, credentials masked, injection ignored.

**Exit:** acceptance criterion 10 — the worker deeply tests a controlled sample app and records evidence.

---

## Phase 5 — Scoring and ranking

1. Evidence review — assemble browser, artifact, and preflight evidence per category.
2. Scoring — versioned prompt, Zod-validated per-category output with raw/weighted score, three evidence stances, confidence, and rationale; browser evidence weighted above unsupported claims.
3. Confidence and low-confidence flagging.
4. Consistency pass, restricted to the six defined triggers.
5. Feedback reports — generated, stored, exposed to nobody.
6. Internal reports with full evidence and version stamps.
7. Ranking snapshots with the tie-break chain and private top-10 highlighting.
8. Admin actions: evidence review, category override with mandatory reason, stage rerun, review complete, disqualify/restore, select and order exactly four, export shortlist.

**Exit:** acceptance criteria 12–17 demonstrable on the full fixture cohort.

---

## Phase 6 — Hardening

1. Admin operating playbook, all seventeen required sections including the Day 13 → Day 14 checklist.
2. Internal demo deck, generated programmatically in black / white / Outskill green.
3. Security review against the Phase 6 checklist in the threat model.
4. Full test suite green: unit, component, integration, E2E, worker.
5. Deployment runbook — including the network egress policy the worker requires.
6. Scale and cost instrumentation: queue ETA, browser minutes, AI calls, token usage, projected completion against the Day-14 target.
7. Retention implementation, with automatic deletion disabled in dev and demo.
8. Final pass over all twenty acceptance criteria.

**Exit:** every acceptance criterion demonstrated. No deployment without explicit approval.

---

## Sequencing notes

Phases 1 → 2 → 3 are strictly ordered: the interfaces defined in Phase 1 are what Phase 2 implements and Phase 3 consumes. Phase 4 depends on the DSL and SSRF guard from Phase 1 and the test plans from Phase 3. Phase 5 depends on Phase 4's evidence. Phase 6 depends on everything.

The single highest-risk dependency is the DSL: if it is designed loosely in Phase 1, Phase 4 inherits an unsafe executor. It is therefore specified as a closed union with a database CHECK constraint before any executor code is written.

## Stop conditions

Work continues automatically through every locally achievable phase, and pauses only for: a real external credential, a paid service, a production deployment, or an irreversible operation.

Phases 2–5 are fully implemented locally against the demo driver and fixture app; a real Supabase project and AI key are required only to exercise them against live infrastructure, and both are optional for the acceptance run.
