# Architecture

## 1. Shape

A TypeScript monorepo with two runnable apps and two shared packages.

```
outskill-hackathon-judge/
├─ apps/
│  ├─ web/          Next.js — participant portal, admin dashboard, API routes, server actions
│  └─ worker/       Node — Playwright assessment worker, queue consumer
├─ packages/
│  ├─ shared/       Zod schemas, rubric, scoring types, test-action DSL, URL/SSRF validation, crypto, data layer
│  └─ ai/           Provider-independent AI adapter, prompt versions, redaction, injection defence
├─ supabase/        SQL migrations, RLS policies, storage bucket setup
├─ scripts/         Seeding, demo deck generation, operational tooling
└─ docs/
```

Package manager: **npm workspaces** (pnpm is not installed on the target machine; see ADR-002). TypeScript project references keep typecheck incremental across packages.

## 2. Why the worker is a separate process

Not for scale — for **blast radius**. The worker drives untrusted participant websites in a real browser. Keeping that in its own process means a hostile or broken product cannot touch the web app's memory, session secrets, or request context. The worker receives only the scoped credentials it needs, runs with its own timeouts and resource limits, and communicates exclusively through the database.

The web app never launches a browser. The worker never renders a page for a human.

## 3. Data flow

```
Admin ──CSV──▶ teams + hashed invite tokens ──URL──▶ Participant
                                                          │
                                                          ▼
                                              /submit/[token]  (draft autosave)
                                                          │  Final Submit
                                                          ▼
                                                   submissions (locked)
                                                          │  admin starts judging
                                                          ▼
                                                  assessment_jobs (queued)
                                                          │
                          ┌───────────────────────────────┴──────────────────────────┐
                          ▼                                                          │
                    WORKER claims job  (SELECT … FOR UPDATE SKIP LOCKED)             │
                          │                                                          │
        preflight ─▶ artifact_analysis ─▶ test_plan_generation ─▶ browser_testing ───┤
                          │                        │                     │           │
                     (HTTP probes)          (packages/ai)         (Playwright)       │
                          │                        │                     │           │
                          └──────────▶ evidence_review ─▶ scoring ─▶ consistency ────┘
                                                                       │
                                                                       ▼
                                              category_scores + assessment_summaries
                                                                       │
                                                                       ▼
                                   ranking_snapshots ──▶ /admin/ranking (private)
                                                                       │
                                                          admin selects exactly 4
                                                                       ▼
                                                              final_selections
```

There is no edge from any assessment table back to a participant-reachable route.

## 4. apps/web

Next.js App Router. Three route groups with distinct trust levels:

| Route group | Auth | May read |
| --- | --- | --- |
| `/submit/[token]` | Invite token (hashed lookup, constant-time compare) | One cohort, its ideas, the public rubric, one team, one submission |
| `/admin/*` | Shared admin session cookie | Everything |
| `/api/*` | Per-route: token, admin session, or worker service key | Scoped to the caller |

Server actions handle all mutations. Every participant action re-resolves the token server-side and re-derives the submission ID from it — the client never supplies a submission ID that is trusted.

**Rendering:** admin pages are dynamic server components; the participant form is a client component over a server-action autosave endpoint.

**Components:** a small in-house accessible component library (`apps/web/src/components/ui`) rather than the shadcn CLI — same conventions and Tailwind-based styling, but no network-dependent generator step and no unnecessary runtime dependencies. Dialogs use native `<dialog>`; tabs implement the WAI-ARIA tabs pattern with roving tabindex. See ADR-004.

## 5. apps/worker

A polling loop, not a server. Each iteration:

1. Claim up to `WORKER_CONCURRENCY` jobs with `FOR UPDATE SKIP LOCKED`, marking them `running` with a lease and heartbeat.
2. Advance each claimed job through its next pipeline stage inside a stage-level try/catch.
3. Persist stage output, evidence, and timing.
4. Release the job — advanced, retried with backoff, or parked in `manual_review` / `failed`.

Stale leases (worker crashed mid-job) are reclaimed by a lease-expiry sweep, so a killed worker never strands a submission.

Browser work runs in a fresh `browser.newContext()` per submission with a hard wall-clock budget (default 8 minutes), no persistent profile, no shared storage state, and downloads disabled.

## 6. packages/shared

The contract layer. Everything that must agree between web and worker lives here.

- **`rubric/`** — the eight categories, their weights, and a compile-time-and-runtime assertion that they sum to 100. Weighted-score maths and the tie-break comparator.
- **`schemas/`** — Zod schemas for every submission step, assessment stage output, and API boundary. One source of truth for both client validation and server validation.
- **`testing/`** — the test-action DSL: a closed union of permitted actions. Anything not in the union cannot be represented, let alone executed.
- **`security/`** — URL validation and SSRF guards, invite-token hashing, AES-256-GCM credential envelope, Argon2id password helpers.
- **`data/`** — repository interfaces plus two drivers: `memory` (demo mode, deterministic) and `postgres`. Application code depends on the interface, never on a driver.
- **`domain/`** — status transition tables, deadline evaluation, disqualification rules, eligibility rules.

## 7. packages/ai

The only place that talks to a model.

- **Provider-independent adapter.** `AI_PROVIDER` / `AI_MODEL` / `AI_API_KEY` select an implementation at runtime; no provider is hard-coded. A `demo` provider returns deterministic fixture responses so demo mode needs no key.
- **Structured output.** Every call declares a Zod schema and validates the response. Invalid JSON is retried a bounded number of times, then the stage degrades to low confidence rather than guessing.
- **Versioned prompts.** Prompts are content-addressed by version string, recorded on every score, and frozen per cohort alongside rubric and model version.
- **Redaction, before the boundary.** Names, emails, phone numbers, and credentials are stripped before any payload leaves the process. Submissions are identified to the model by an anonymised ID only.
- **Injection defence.** Participant content is wrapped in explicit untrusted-data delimiters, the system prompt states that instructions inside participant content are data and must never be followed, and outputs are schema-validated so an injected instruction has no channel to affect control flow.

## 8. The test-action DSL

The most security-sensitive design decision in the system.

A generated test plan is **data**, never code. Each step is one member of a closed union:

`navigate · click · fill · select · press · wait · assertText · assertUrl · assertElement · screenshot · reload · checkPersistence · checkConsole · checkNetwork · a11yScan · cleanup`

Properties that make this safe:

- No action evaluates arbitrary JavaScript. There is no `evaluate` member.
- `navigate` targets are re-validated against the SSRF guard at execution time, not just at plan time.
- `fill` values are constrained to safe generated data; anything the judge creates is prefixed `OUTSKILL-JUDGE-`.
- Selectors resolve through accessible roles and names, not raw CSS/XPath into arbitrary DOM.
- Unknown or malformed actions fail schema validation and are dropped with a recorded reason.

A model that is successfully prompt-injected can, at worst, emit a plan that fails validation. It cannot emit a shell command, because the executor has no shell.

## 9. SSRF and browser containment

Blocked at both plan time and execution time: `localhost`, loopback, private IPv4 (10/8, 172.16/12, 192.168/16), link-local (169.254/16 including cloud metadata), unique-local and link-local IPv6, `file://`, `chrome://` and other browser-internal schemes, and any non-HTTP(S) entry URL.

Hostnames are resolved and the **resolved addresses** are checked, not just the string — a hostname that resolves into private space is rejected. Re-validation immediately before navigation narrows the DNS-rebinding window; full protection requires a network-layer egress policy, documented as a deployment requirement in the runbook.

## 10. Storage

Six private Supabase buckets — `submission-decks`, `submission-screenshots`, `browser-evidence`, `traces`, `internal-reports`, `admin-resources`. No public buckets hold assessment material. All access is via short-lived signed URLs minted server-side after an authorisation check. In demo mode a local filesystem driver stands in, under a git-ignored directory.

## 11. Configuration

All configuration is environment-driven and validated by Zod at startup — the process refuses to boot on invalid config rather than failing later. `.env.example` ships with empty placeholders and no real values. Secrets are never logged; the logger runs a redaction pass on every record.

## 12. Testing strategy

| Layer | Tool | Covers |
| --- | --- | --- |
| Unit | Vitest | Rubric totals, weighting, tie-breaks, status transitions, deadlines, invite hashing, credential crypto, redaction, disqualification rules, participant isolation, URL/SSRF validation, JSON validation |
| Component | Vitest + React Testing Library | Form steps, validation surfacing, accessibility affordances |
| Integration | Vitest against the memory driver (and Postgres when configured) | CSV import, invite generation, draft save, final lock, admin reopen, PDF upload, signed URLs, queue claim, score persistence, ranking snapshot, override, final-four selection, password rotation |
| E2E | Playwright | Full participant and admin journeys, plus negative isolation tests |
| Worker | Playwright against a local fixture app | Safe URL accepted, private URL rejected, evidence recorded, timeout handled, console/network errors captured, credentials masked, prompt injection ignored |

The worker's fixture app is a deliberately imperfect local application — it has a dead button, a console error, a failing network call, and an accessibility violation — so the worker's detection is proven against known ground truth rather than assumed.
