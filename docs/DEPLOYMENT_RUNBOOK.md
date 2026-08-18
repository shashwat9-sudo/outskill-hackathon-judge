# Deployment Runbook

**Nothing in this document has been executed.** No infrastructure has been created, no service has been deployed, and no production data exists. Deployment requires explicit approval from Outskill.

Three steps in here are **user-gated checkpoints** — they cost money or touch production, so the build stops in front of each one and waits for a person to say go:

1. **Creating the Supabase project** and applying migrations (§4).
2. **Obtaining an AI provider account and key** (§2).
3. **Deploying anything** — web app or worker (§5, §6).

Everything before those gates is finished and verifiable locally. Nothing after them has been started.

---

## 1. What runs where

| Component | Runtime | Notes |
| --- | --- | --- |
| `apps/web` | Node 20+ | Participant portal and admin dashboard. Health at `/api/health` |
| `apps/worker` | Node 20+ **with Chromium**, from `apps/worker/Dockerfile` | Drives untrusted participant websites. Liveness at `/healthz`, readiness at `/readyz`, on `WORKER_HEALTH_PORT` (default 8080, container-internal) |
| PostgreSQL | Supabase | Also the assessment queue |
| Storage | Supabase Storage | Six private buckets |

**The worker must not share a host with anything else.** It exists as a separate process precisely so a hostile participant product cannot reach the web app's memory, session secrets, or request context.

---

## 2. Prerequisites (user-gated — each costs money)

1. A Supabase project (Postgres + Storage).
2. A host for `apps/web`.
3. A container host for `apps/worker` that can run Chromium and supports an egress network policy.
4. An AI provider account and key.

None of these have been created. Each is a paid resource, each is a checkpoint, and none of them is taken without explicit sign-off.

---

## 3. Secrets

Generate each on a trusted machine. Never paste a secret into chat, a ticket, or a commit.

```bash
# Admin session signing secret
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

# Credential encryption key — EXACTLY 32 bytes, base64
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Losing `CREDENTIAL_ENCRYPTION_KEY` makes every stored credential permanently unreadable.** Back it up in whatever Outskill uses for secrets, before first use.

`ADMIN_SEED_PASSWORD` seeds the shared account on first run. Rotate it at `/admin/settings` immediately afterwards; the seed value should never remain in use.

The configuration is validated by Zod at startup, so a missing or malformed value stops the process at boot rather than failing later inside a request.

---

## 4. Database

```bash
supabase link --project-ref <ref>
supabase db push          # applies supabase/migrations/*.sql in order
```

Four migrations:
1. `0001_schema.sql` — 34 tables, constraints, indexes
2. `0002_rls.sql` — row-level security for the three roles
3. `0003_storage.sql` — six private buckets and their policies
4. `0004_production_entry.sql` — `team_access_codes`, `participant_sessions`, `team_activity`, `verification_attempts`; submission versioning; cohort closure and reopening columns; idea-definition approval. Forward-only, and it drops or rewrites nothing.

### Verify before going further

```sql
-- The rubric must total exactly 100.
select rubric_version_id, sum(max_points) from rubric_categories group by 1;

-- RLS must be on and forced everywhere.
select tablename from pg_tables
 where schemaname = 'public'
   and tablename not in (select tablename from pg_tables where rowsecurity);
-- Expect zero rows.

-- The critical check: participants must have NO policy on assessment tables.
select tablename, count(*) from pg_policies
 where schemaname = 'public'
   and 'ohj_participant' = any(roles)
   and tablename in (
     'category_scores','assessment_summaries','ranking_entries',
     'ranking_snapshots','final_selections','feedback_reports',
     'assessment_evidence','browser_test_runs','disqualifications'
   )
 group by 1;
-- Expect ZERO ROWS. Any row here is a privacy defect — stop and fix it.

-- The same check for the entry tables. A participant role that could read
-- team_access_codes could enumerate every group in the cohort.
select tablename, cmd from pg_policies
 where schemaname = 'public'
   and 'ohj_participant' = any(roles)
   and tablename in (
     'team_access_codes','participant_sessions','verification_attempts','team_activity'
   );
-- Expect exactly ONE row: a SELECT policy on team_activity. Nothing else.
```

---

## 5. Web app

```bash
npm ci
npm run build
npm run start --workspace=@ohj/web
```

Required environment: `DEMO_MODE=0`, `NODE_ENV=production`, `APP_BASE_URL`, `ADMIN_SEED_USERNAME`, `ADMIN_SEED_PASSWORD`, `ADMIN_SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`), `DATABASE_URL`, `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`, `AI_EVALUATION_MODE`.

Startup refuses to proceed without `ADMIN_SESSION_SECRET` (32+ characters), `CREDENTIAL_ENCRYPTION_KEY`, and either `DATABASE_URL` or `SUPABASE_URL` whenever `DEMO_MODE` is off — and without `AI_API_KEY` whenever `AI_PROVIDER` is anything but `demo`.

`ADMIN_SESSION_SECRET` carries more weight than its name suggests. It signs admin sessions, and it also signs the ten-minute verification handle that carries a verified team between the two entry steps, and keys the hash of participant session tokens. Rotating it signs everyone out, admin and learner alike, which is a legitimate emergency action and a bad accident.

`APP_BASE_URL` is what the access-code sheet and the guide PDF print as the submission address. If it is wrong, the URL Outskill pastes into Circle is wrong.

**HTTPS is mandatory.** Session cookies are set `Secure` in production and will not survive a plain-HTTP origin. That applies to the participant cookie as much as the admin one.

`SUPABASE_SECRET_KEY` (and the legacy `SUPABASE_SERVICE_ROLE_KEY`) are server-side only. Neither may be prefixed `NEXT_PUBLIC_` and neither may reach the browser.

`AI_EVALUATION_MODE` defaults to `synthetic_only`, which refuses to send real learner work to an AI provider. Production judging requires setting it to `production` deliberately.

### Health

`GET /api/health` returns 200 with `{"status":"ok","checks":{"config":"ok","store":"ok"}}` when the process can actually serve a learner, and 503 with `degraded` when it cannot. The store check is a real read, not a ping — a store that constructs and then cannot answer is the failure worth catching.

Point the load balancer at it. It is unauthenticated and deliberately says nothing else: no version, no hostname, no environment variable, no database URL, no counts.

---

## 6. Worker — the part that needs care

The worker visits URLs chosen by the people being judged. Treat its host as untrusted-adjacent.

The image is `apps/worker/Dockerfile` — build it, do not hand-write one:

```bash
docker build -f apps/worker/Dockerfile -t ohj-worker .
```

It builds from `mcr.microsoft.com/playwright:v1.62.1-noble` and runs as the non-root `pwuser`. Two things about that tag matter:

- It must match the **resolved** Playwright version, not the range in `package.json`. The base image bundles specific browser builds, and a client/browser mismatch fails at runtime rather than at build time — the worst kind to discover in production. Check with `npm ls playwright` before changing either.
- Bumping Playwright means bumping the tag in the same commit.

The build context is the repository root, because `npm ci --workspace` still needs the full lockfile.

### Worker health

The worker serves two routes on `WORKER_HEALTH_PORT` (default 8080). Keep the port container-internal; there is nothing on it for the internet.

| Route | Meaning | Probe |
| --- | --- | --- |
| `/healthz` | Liveness. 200 while the process answers. | Restart probe. The image's `HEALTHCHECK` uses this. |
| `/readyz` | Readiness. 200 when the polling loop ran recently and is not draining; 503 with `stalled` or `draining` otherwise, plus `quietForSeconds` and `inFlight`. | Traffic/scheduling probe **only**. |

**Do not point a restart probe at `/readyz`.** A worker in the middle of a browser run is *busy*, not stalled, and killing it there loses someone's assessment. That is why liveness ignores staleness entirely, and why the staleness limit for readiness is derived from the poll interval and the browser budget rather than fixed.

`SIGTERM` starts a graceful drain: readiness fails immediately so nothing new is scheduled, liveness stays up while in-flight assessments finish, and the process exits when the loop stops.

### Required: network egress policy

The application checks resolved addresses and re-checks immediately before every navigation, which narrows the DNS-rebinding window. **It does not close it.** Only a network-layer policy does.

Block egress from the worker to:

```
10.0.0.0/8        172.16.0.0/12     192.168.0.0/16
127.0.0.0/8       169.254.0.0/16    100.64.0.0/10
::1/128           fc00::/7          fe80::/10
```

Explicitly including `169.254.169.254` — the cloud metadata endpoint.

Without this, the guard is application-level only, and ADR-008 records that as a known residual risk.

### Also required

- No access to the internal network or other services.
- Read-only filesystem apart from a scratch volume for evidence.
- Memory and CPU limits — a hostile page can otherwise exhaust the host.
- Scoped secrets only: `DATABASE_URL` and `CREDENTIAL_ENCRYPTION_KEY`. **Never** `ADMIN_SESSION_SECRET`.
- Log shipping with redaction. The worker already redacts, but the pipeline should not undo it.

### Scaling

Start with `WORKER_CONCURRENCY=4`. Jobs are leased, so extra worker instances are safe — `FOR UPDATE SKIP LOCKED` makes double-processing impossible, and a crashed worker's jobs are reclaimed on lease expiry.

At 500 submissions with an eight-minute budget, concurrency 8 is roughly nine hours of browser time. Check the projection on `/admin/assessment-queue` rather than trusting the arithmetic.

---

## 7. Pre-deployment checklist

- [ ] `npm run verify` passes (lint, typecheck, unit + integration, build)
- [ ] `npm run test:e2e` passes
- [ ] Migrations applied and the verification queries return the expected results
- [ ] `select count(*) from pg_policies where 'ohj_participant' = any(roles) and tablename in (assessment tables)` returns **zero**
- [ ] The entry-table policy query returns exactly one row: SELECT on `team_activity`
- [ ] All six buckets are private (`select id, public from storage.buckets` — every row false)
- [ ] Secrets generated on a trusted machine and stored in a secrets manager
- [ ] `CREDENTIAL_ENCRYPTION_KEY` backed up
- [ ] `APP_BASE_URL` is the real public origin — it is the URL printed on the code sheet and in the guide
- [ ] `/api/health` returns 200 from outside, and 503 if the database is stopped
- [ ] Worker `/healthz` and `/readyz` reachable inside the container; the restart probe points at `/healthz` only
- [ ] Worker image tag matches `npm ls playwright`
- [ ] Worker egress policy applied **and tested** — from inside the container, confirm `curl http://169.254.169.254` fails
- [ ] Worker holds no admin session secret
- [ ] HTTPS enforced on the web app
- [ ] `DEMO_MODE=0` in production, and verified at `/admin/settings`
- [ ] Shared admin password rotated away from the seed value
- [ ] `git ls-files | grep reference-materials` returns nothing

---

## 8. Post-deployment verification

1. `curl https://<app>/api/health` returns 200 and `"status":"ok"`.
2. Sign in to `/admin`. Confirm *Runtime configuration* shows demo mode off and the postgres driver.
3. Create a throwaway cohort, import one team, issue an access code and download the sheet.
4. Open `/submit` in a clean browser. Confirm the URL contains no team identifier, enter the group number and code, then a name.
5. Enter a **wrong** code for a group that does not exist and confirm the message is identical to the wrong-code message.
6. Confirm the participant page shows the rubric and the deadline — and no score, rank or shortlist.
7. Submit a test entry, confirm it locks, and download the receipt PDF. Check it carries no code and no credential.
8. Look the submission up by its receipt ID from the Overview page.
9. Confirm `/submit/guide` and `/api/guide` load without a session.
10. Queue it and confirm the worker claims it within a poll interval, and that `/readyz` reports ready.
11. Confirm evidence, scores and a ranking appear in the admin dashboard.
12. From a browser with no admin session, request `/admin/ranking` and confirm the redirect carries no state.
13. Revoke the test team's access code and confirm the open session is signed out.
14. Delete the throwaway cohort.

---

## 9. Rollback

The web app is stateless — redeploy the previous build.

Migrations are additive within Version 1. There is no destructive migration to reverse. If a schema change must be undone, write a forward migration; do not edit an applied one.

If the worker misbehaves, stop it. Jobs stay leased until expiry, then become claimable again. Nothing is lost, and no submission is left half-assessed.

---

## 10. Retention

Defaults: credentials destroyed at judging finalisation; traces and evidence 90 days; submissions and reports 90 days.

The deletion job runs **only** when `NODE_ENV=production` and `DEMO_MODE=0` (ADR-019), so a policy written for production cannot destroy a development database. Every deletion is audit-logged.

---

## 11. Monitoring

Watch, in priority order:

1. **Queue depth vs the shortlist deadline** — the only metric that matters on the night.
2. `/api/health` — a 503 during the submission window means teams cannot submit.
3. Worker `/readyz` — `stalled` means the loop is wedged; `draining` during a deploy is expected.
4. Worker liveness — leases expiring without heartbeats means a worker is dying.
5. Failed-stage rate — a spike usually means a network or provider problem, not 400 bad products.
6. AI call count and token usage — reported as raw counts; apply your own rate.
7. Admin login failures — a spike is worth a look.
8. Verification lockouts during the submission window. A handful is normal. A cluster on one address usually means a NAT and a confused team, not an attack — and either way, clearing it takes seconds.

---

## 12. Open items before a production run

1. The postgres driver is specified and the schema is in place, but it is not wired. With `DEMO_MODE=0` the web app throws when it builds a store and the worker refuses to start, rather than either of them silently serving or assessing fixture data. Wire and test the driver before a real cohort; until then, `/api/health` in a `DEMO_MODE=0` deployment will report `degraded`, which is the honest answer.
2. Confirm the AI provider and model, and freeze both for the cohort.
3. Load-test the queue at cohort scale.
4. Supply the real Outskill brand green (ADR-014).
5. Agree who holds the shared admin credential and the rotation schedule.
