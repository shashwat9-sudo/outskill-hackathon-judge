# Production checklist

Everything that must be true before real learners use this, in the order it has
to happen.

Three items require a decision or a credential that only you can supply. They
are marked **STOP** and nothing past them proceeds without you.

---

## A. Before the cohort exists

### A1. Repository hygiene

- [ ] `reference-materials/` is git-ignored and has never been committed
      (`git log --all -- reference-materials/` returns nothing)
- [ ] No `.env` file with real values is tracked
- [ ] `.env.example` contains only empty placeholders

### A2. Local gate passes

```bash
npm run typecheck && npm run lint && npx vitest run && npx playwright test
```

- [ ] Typecheck clean
- [ ] Lint clean
- [ ] Unit tests pass
- [ ] Playwright tests pass
- [ ] `npm run build --workspace @ohj/web` compiles

Current state is recorded in `BUILD_STATUS.md`. Re-run rather than trusting it.

### A3. STOP — Supabase project

Requires a browser login and an irreversible remote operation.

Follow `SUPABASE_SETUP.md` end to end, including every verification query.

- [ ] Project created, region chosen deliberately
- [ ] Migrations 0001–0004 applied
- [ ] RLS verification queries return what they should
- [ ] All six storage buckets private
- [ ] No synthetic data on the remote project

### A4. Secrets

Generated locally, stored in a password manager and in the hosting platform's
secret store. Never pasted into a chat, a document, a commit, or an issue.

- [ ] `ADMIN_SESSION_SECRET` — freshly generated for this environment, at least
      32 characters, not reused from staging
- [ ] `CREDENTIAL_ENCRYPTION_KEY` — exactly 32 bytes base64. Losing it makes
      stored demo credentials permanently unreadable
- [ ] `ADMIN_SEED_USERNAME` and `ADMIN_SEED_PASSWORD` — outside demo mode the
      app refuses to start with no admin account and no seed values
- [ ] `DATABASE_URL`
- [ ] `SUPABASE_SECRET_KEY` (preferred) or legacy `SUPABASE_SERVICE_ROLE_KEY` — server-side only, never in the browser,
      never in the worker
- [ ] `APP_BASE_URL` — correct, because it becomes the submission URL on every
      access-code sheet

### A5. STOP — AI provider

Assessment calls a paid API. Nothing is spent without your approval.

- [ ] Provider and model chosen
- [ ] `AI_API_KEY` set in the server environment only
- [ ] Cost per submission estimated against the expected 300–500
- [ ] Confirmed: no name, email, phone number, password or credential is sent to
      the model; assessment content is sent under anonymised submission IDs

### A6. Postgres driver

- [ ] The postgres driver implements the repository interfaces and `getStore()`
      returns it when `DEMO_MODE=0`

Until this is done, the application throws on startup with `DEMO_MODE=0`. That
is deliberate — silently falling back to fixtures would be far worse.

### A7. STOP — Deployment

- [ ] Deployment approved
- [ ] Web application deployed with `DEMO_MODE=0`
- [ ] `GET /api/health` returns 200 with `{"status":"ok"}`
- [ ] `/` shows the production landing page, **not** the demo home
- [ ] No demo credentials, synthetic teams or invite links appear anywhere

### A8. Admin account

- [ ] Admin account created
- [ ] Password changed from any default, stored in the shared password manager
- [ ] Everyone who will operate the cohort can sign in
- [ ] They know it is a shared account and every action is audit-logged

---

## B. Setting up the cohort

### B1. Cohort

- [ ] Created through the admin UI
- [ ] Day 12 start and Day 13 deadline correct, in the right timezone
- [ ] Deadline confirmed as 11:59 PM IST on Day 13
- [ ] Shortlist target set (10)
- [ ] Status still `draft`

### B2. Ideas

- [ ] The approved idea list is present and correct
- [ ] Every expanded definition reviewed and **approved**
      (Admin → Cohorts → Ideas — the banner tells you how many are still draft)

Unapproved definitions are Outskill's own interpretation. Judging against an
unreviewed interpretation measures teams against something nobody agreed to.

### B3. Teams

- [ ] Team CSV imported
- [ ] Import problems resolved — no duplicate group numbers, no invalid emails
- [ ] Team count matches the roster

### B4. Access codes

Follow `ACCESS_CODE_OPERATIONS.md`.

- [ ] Codes issued and the CSV downloaded **once**
- [ ] The CSV is stored somewhere appropriate for a credential list
- [ ] Codes distributed through Outskill's own channel
- [ ] "Waiting for a code" reads zero

### B5. The submission URL

- [ ] `APP_BASE_URL/submit` opens the entry page
- [ ] That URL is pasted into Circle **by hand** — there is no integration and
      there should never be one
- [ ] The link is where teams will actually look

### B6. Guide

- [ ] `/submit/guide` renders
- [ ] `/api/guide` downloads a readable PDF
- [ ] The deadline shown matches the cohort

### B7. Rehearsal

Do this. Everything above can be correct on paper and still fail here.

- [ ] Sign in as a real team with a real code, on a phone, on mobile data
- [ ] Fill in every step, upload a PDF, save a demo link
- [ ] Have a second person sign in with the same code and confirm both can edit
- [ ] Have both save at once and confirm the stale write is refused, not lost
- [ ] Final submit, check the receipt, download the receipt PDF
- [ ] Look up that receipt ID from the admin overview
- [ ] Reopen the submission, confirm the team can edit again

Then remove the rehearsal team, or make sure it is recognisable as a rehearsal.

---

## C. During the hackathon

### C1. Opening

- [ ] Cohort status set to `open`
- [ ] `/submit` shows the deadline and the time remaining
- [ ] A test sign-in works from outside your network

### C2. Watch for

- Teams "Waiting for a code" — chase them
- Teams locked out — clear it (`ACCESS_CODE_OPERATIONS.md` §5)
- "Editing right now" staying at zero after the window opens — something is
  wrong with distribution, not with the platform
- The cohorts list warning that the deadline has passed while status still reads
  open — harmless, but reconcile it

### C3. Closing

Follow `DEADLINE_AND_CLOSURE.md`.

- [ ] Automatic closing works without anyone doing anything
- [ ] If closing early: typed `CLOSE SUBMISSIONS`, deliberately
- [ ] If reopening after the deadline: an acceptance time is set, and a reason
      is recorded

---

## D. Before judging

### D1. STOP — Worker

The worker runs a real browser against participant-supplied URLs. It has its own
gate.

- [ ] Every condition in `WORKER_PRODUCTION_GATE.md` (G1–G10) verified
- [ ] Network egress policy in place and **tested from inside the container**
- [ ] Worker deployed separately from the web application
- [ ] Worker has no service-role key
- [ ] `/healthz` and `/readyz` wired to the platform
- [ ] Pilot run on 3–5 real submissions, evidence read by hand

### D2. Judging

- [ ] Cohort closed
- [ ] Queue started
- [ ] Manual-review flags worked through
- [ ] Disqualifications confirmed by a human, with a reason

### D3. Shortlist and finalists

- [ ] Ranking generated
- [ ] Private top 10 reviewed before 10:00 AM IST on Day 14
- [ ] Four finalists selected **by a person**

The platform never announces winners and never publishes a ranking. Nothing here
changes that.

---

## E. Standing invariants

These must remain true at every point above. Each has test coverage; re-check
them after any change.

- [ ] No learner surface shows a score, rank, evidence, shortlist position,
      finalist status, manual-review note or internal comment
- [ ] `/submit` gives one identical message for every verification failure
- [ ] An access code never appears in a URL, browser history, analytics, a log,
      an error message, audit metadata, or client-side storage
- [ ] Demo credentials, synthetic teams and invite links appear only when
      `DEMO_MODE=1`
- [ ] There is no public ranking route
- [ ] `reference-materials/` is not committed and not web-served
- [ ] Every admin mutation is audit-logged
- [ ] Nothing deletes through the application

---

## F. Exports

Admin CSV exports are for Outskill's internal use. They must never contain:

- access-code hashes
- passwords of any kind
- demo credentials
- private browser traces
- API keys

The access-code sheet is the one export that contains live credentials, by
necessity. Treat it accordingly.
