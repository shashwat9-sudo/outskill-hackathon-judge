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
Admin ──CSV──▶ teams ──▶ access codes (Argon2id, shown once)
                                  │
                                  │  group number + code, given to the team
                                  ▼
Outskill pastes ONE URL into Circle, by hand ────▶ Participant
                                                          │
                                                          ▼
                                            /submit  ①  verify group + code
                                                     ②  who is editing (a name)
                                                          │  ohj_team_session
                                                          ▼
                                          /submit/portal  (draft autosave,
                                                           versioned writes)
                                                          │  Final Submit
                                                          ▼
                                            submissions (locked) ──▶ receipt
                                                                     + /submit/receipt
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

Next.js App Router. Route groups with distinct trust levels:

| Route | Auth | May read |
| --- | --- | --- |
| `/` | None | A landing page. Production shows a call to action and the guide link; the exploratory demo home appears only under `DEMO_MODE=1` |
| `/submit` | None (this is where a team proves who it is) | The active cohort's name and window state, nothing team-specific |
| `/submit/guide` · `/api/guide` | None | The two-day guide and its PDF — instructions, not results |
| `/submit/portal` · `/submit/receipt` | Participant session cookie | One cohort, its ideas, the public rubric, one team, one submission, that team's own activity |
| `/submit/[token]` | Invite token (hashed lookup, constant-time compare) | The same, for the demo fixtures and pre-existing invites |
| `/admin/*` · `/api/admin/*` | Shared admin session cookie | Everything |
| `/api/health` | None | Nothing. Two booleans and a status word |

Server actions handle all mutations. Every participant action re-resolves the **session cookie** server-side and re-derives the team and submission from it — the client never supplies a submission id, a team id or an access code that is trusted, which is what makes cross-team writes impossible rather than merely blocked.

**Rendering:** admin pages are dynamic server components; the participant form is a client component over a server-action autosave endpoint.

**Components:** a small in-house accessible component library (`apps/web/src/components/ui`) rather than the shadcn CLI — same conventions and Tailwind-based styling, but no network-dependent generator step and no unnecessary runtime dependencies. Dialogs use native `<dialog>`; tabs implement the WAI-ARIA tabs pattern with roving tabindex. See ADR-004.

### 4.1 The entry flow

One common URL, two steps, because they answer two different questions.

1. **Which team is this?** Group number and shared access code, posted once. Shape checks run locally; the code is verified against an Argon2id hash. Failure is rate limited on the hashed IP *and* the group number, and every failure returns one identical message.
2. **Who is editing?** A name, and optionally what they work on. It is an activity label, not verified identity — anyone with the shared code can type anything, and no authorisation decision reads it.

Between the two, the verified team is carried in an HttpOnly cookie (`ohj_team_pending`) holding a signed ten-minute HMAC assertion of the team id and its expiry. Not the access code — it would then be posted twice — and not a bare team id, which anyone who learned or guessed one could exchange for a session without ever holding the code.

The invite route reaches the same second step through a separate server action rather than an optional parameter on the common one, so nothing in the production path can be persuaded to accept a token from a form field.

### 4.2 The session model

| Property | Choice | Why |
| --- | --- | --- |
| Token | 32 random bytes, base64url, opaque | A stored session can be revoked; a self-describing signed token cannot |
| Storage | Only a hash of the token — keyed HMAC-SHA-256 where a server secret is configured, plain SHA-256 otherwise | A database read yields nothing usable, and the keyed form also stops an attacker precomputing lookups against captured cookies |
| Cookie | `ohj_team_session`, HttpOnly, `SameSite=Lax`, `Secure` in production, `path=/submit` | Never sent to `/admin`; a cross-site form post cannot act as a team |
| Lifetime | Effective deadline plus 24 hours, floored at one hour and capped at 14 days | A session opened minutes before closing still works; a distant deadline does not mint a near-permanent cookie |
| Revocation | Bound to `access_code_version` | Regenerating a team's code invalidates every session under the old one in a single write, without finding them |

Signing out ends that browser's session only. Other members keep theirs.

### 4.3 Shared editing

Several people hold the same code and edit at once, so writes are versioned rather than last-write-wins: each save carries the version the client read, and a stale write is refused with a message and the current version instead of overwriting a teammate. The team also sees a learner-safe activity feed — a closed set of six event kinds, deliberately separate from the internal audit log, which records far more and belongs to admins.

### 4.4 Health

`/api/health` returns 200 only when configuration loaded **and** the data store answered a real read; anything else is 503. A check that reports healthy because the process is running would keep a broken instance in the load balancer through an entire deadline hour.

It is unauthenticated, so it says almost nothing: a status word and one word per check. No version string, no hostname, no environment variable, no database URL, no counts.

## 5. apps/worker

A polling loop, not a server. Each iteration:

1. Claim up to `WORKER_CONCURRENCY` jobs with `FOR UPDATE SKIP LOCKED`, marking them `running` with a lease and heartbeat.
2. Advance each claimed job through its next pipeline stage inside a stage-level try/catch.
3. Persist stage output, evidence, and timing.
4. Release the job — advanced, retried with backoff, or parked in `manual_review` / `failed`.

Stale leases (worker crashed mid-job) are reclaimed by a lease-expiry sweep, so a killed worker never strands a submission.

Browser work runs in a fresh `browser.newContext()` per submission with a hard wall-clock budget (default 8 minutes), no persistent profile, no shared storage state, and downloads disabled.

### 5.1 Liveness and readiness

A polling loop is invisible from outside until it wedges — on a database call, on a browser that never closes — and the process keeps running while no job advances. A container platform restarts an unhealthy process; it cannot restart a quiet one. So the worker serves two routes on `WORKER_HEALTH_PORT` (default 8080, container-internal):

- **`/healthz`** — liveness. Always 200 while the event loop answers, and deliberately blind to staleness: a worker deep in a browser run is **busy**, not stalled, and must not be killed halfway through someone's assessment.
- **`/readyz`** — readiness. 200 when the loop completed an iteration recently and is not draining; 503 with `stalled` or `draining` otherwise. The staleness limit is derived from the poll interval and the browser budget rather than fixed, because a shorter limit would restart healthy workers.

Readiness is computed from the loop's own iteration timestamp, not from a timer that ticks independently — a self-ticking heartbeat would report healthy precisely when the loop was wedged. `SIGTERM` sets draining, which fails readiness immediately while liveness stays up until in-flight assessments finish. The health server is `unref`'d, so it can never be the reason a dead worker's container stays alive.

### 5.2 The container image

`apps/worker/Dockerfile` builds from the Playwright base image (`mcr.microsoft.com/playwright:v1.62.1-noble`) rather than a plain Node image: browsers need dozens of system libraries, and the alternative is tracking Debian package names by hand. The tag must match the **resolved** Playwright version, not the range in `package.json` — the base image bundles specific browser builds, and a client/browser mismatch fails at runtime rather than at build time.

It runs as the non-root `pwuser`, ships the evidence directory so a misconfigured mount fails loudly instead of writing into a layer that vanishes on restart, and its `HEALTHCHECK` probes `/healthz` only — readiness is the orchestrator's business, and restarting a busy worker is exactly the outcome to avoid. The entry point is the process itself, with no shell wrapper, so `SIGTERM` starts a graceful drain.

## 6. packages/shared

The contract layer. Everything that must agree between web and worker lives here.

- **`rubric/`** — the eight categories, their weights, and a compile-time-and-runtime assertion that they sum to 100. Weighted-score maths and the tie-break comparator.
- **`schemas/`** — Zod schemas for every submission step, assessment stage output, and API boundary. One source of truth for both client validation and server validation.
- **`testing/`** — the test-action DSL: a closed union of permitted actions. Anything not in the union cannot be represented, let alone executed.
- **`security/`** — URL validation and SSRF guards, invite-token hashing, AES-256-GCM credential envelope, Argon2id password helpers, **team access codes** (generation, normalisation, verification, rate-limit arithmetic) and **participant sessions** (token generation and hashing, the signed verification handle, editor-name validation, session expiry and validity).
- **`data/`** — repository interfaces plus two drivers: `memory` (demo mode, deterministic) and `postgres`. Application code depends on the interface, never on a driver.
- **`domain/`** — status transition tables, deadline evaluation, disqualification rules, eligibility rules, the **submission window** (the server-clock decision about who may write, and what a valid reopen looks like), **optimistic concurrency** and the learner-safe activity vocabulary, and two hand-written PDF generators for the receipt and for long documents.
- **`content/`** — the two-day submission guide, as one source rendered both as a page and as a PDF, so the two cannot drift.

`access-code-constants.ts` deserves its own note: the entry form is a client component and needs the expected code length and the single failure message, while `access-code.ts` imports `node:crypto` and Argon2 and must never enter a browser bundle. The constants file has no imports at all, which is what makes it safe to re-export through `@ohj/shared/client`.

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
| Unit | Vitest | Rubric totals, weighting, tie-breaks, status transitions, deadlines, invite hashing, access-code generation and normalisation, verification rate limiting, session hashing and validity, verification-handle signing, submission-window and reopen rules, optimistic concurrency, receipt-PDF safety, credential crypto, redaction, disqualification rules, participant isolation, URL/SSRF validation, JSON validation, worker readiness |
| Component | Vitest + React Testing Library | Form steps, validation surfacing, accessibility affordances |
| Integration | Vitest against the memory driver (and Postgres when configured) | CSV import, invite generation, access-code issue and revocation, session revocation on regeneration, draft save, stale-write refusal, final lock, admin reopen, PDF upload, signed URLs, queue claim, score persistence, ranking snapshot, override, final-four selection, password rotation |
| E2E | Playwright | Full participant and admin journeys, the common entry flow, the guide, closure and reopening, receipt lookup, health, plus negative isolation tests |
| Worker | Playwright against a local fixture app | Safe URL accepted, private URL rejected, evidence recorded, timeout handled, console/network errors captured, credentials masked, prompt injection ignored |

The worker's fixture app is a deliberately imperfect local application — it has a dead button, a console error, a failing network call, and an accessibility violation — so the worker's detection is proven against known ground truth rather than assumed.


---

## Production data layer (Phase A)

### Driver selection

`getStoreAsync()` returns `MemoryDataStore` when `DEMO_MODE=1` and
`PostgresDataStore` when `DEMO_MODE=0`. There is **no fallback in either
direction**: serving fixtures because the database is unreachable would let the
platform look healthy while accepting real submissions into memory that vanish
on the next restart.

Missing production configuration throws `ConfigError` listing every problem at
once, before any request is served.

### Connection model (ADR-032)

The web tier is serverless, so `DATABASE_URL` must be Supabase's **transaction
pooler**. A session-pooler connection pins a Postgres backend for its whole
life; a few hundred concurrent invocations in the final hour before a deadline
exhaust the server that way.

Consequences the driver respects, audited and clean:

| Constraint | Status |
| --- | --- |
| No named prepared statements | ✅ none |
| No session `SET` / `set_config` | ✅ none |
| No temporary tables | ✅ none |
| No LISTEN/NOTIFY | ✅ none |
| No session advisory locks | ✅ none |
| No cursors held across statements | ✅ none |

Pool defaults are deliberately small — `max: 2` **per instance**, and serverless
multiplies instances.

### Supabase keys

`SUPABASE_SECRET_KEY` (`sb_secret_…`) is preferred. The legacy
`SUPABASE_SERVICE_ROLE_KEY` is accepted as a documented fallback via
`supabaseSecretKey()`. Both bypass RLS; neither may be prefixed `NEXT_PUBLIC_`.

The **worker receives no Supabase key at all** — it does not call the Storage
API, and least privilege means it holds nothing it cannot use.

### Feature gating

`PostgresDataStore` declares what it can do:

```ts
capabilities: { assessment: false, ranking: false }
```

The 35 assessment and 6 ranking methods throw `FeatureUnavailableError` rather
than returning `[]` or `null`. An empty queue and a zero score both *look* like
real answers; a throw cannot be mistaken for one. Callers read
`storeCapabilities(store)` and show a production-safe state.

### Testing the data layer

There is no Docker and no local Postgres on a typical machine, so the driver
would otherwise ship unverified. **PGlite** — Postgres 18 compiled to
WebAssembly — runs the actual migration files in-process and reproduces
production exactly (38 tables, 38 with RLS, 78 policies, 3 roles, 13 enums).

It has already caught bugs that would have failed identically in production: a
parameter used as both an enum and text, a wrong `on conflict` target, and a
`bytea` column decoded as comma-separated byte numbers.
