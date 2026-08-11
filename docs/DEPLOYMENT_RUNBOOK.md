# Deployment Runbook

**Nothing in this document has been executed.** No infrastructure has been created, no service has been deployed, and no production data exists. Deployment requires explicit approval from Outskill.

---

## 1. What runs where

| Component | Runtime | Notes |
| --- | --- | --- |
| `apps/web` | Node 20+ | Participant portal and admin dashboard |
| `apps/worker` | Node 20+ **with Chromium** | Drives untrusted participant websites |
| PostgreSQL | Supabase | Also the assessment queue |
| Storage | Supabase Storage | Six private buckets |

**The worker must not share a host with anything else.** It exists as a separate process precisely so a hostile participant product cannot reach the web app's memory, session secrets, or request context.

---

## 2. Prerequisites (require approval — each costs money)

1. A Supabase project (Postgres + Storage).
2. A host for `apps/web`.
3. A container host for `apps/worker` that can run Chromium and supports an egress network policy.
4. An AI provider account and key.

None of these have been created. Each is a paid resource and needs sign-off.

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

Three migrations:
1. `0001_schema.sql` — 34 tables, constraints, indexes
2. `0002_rls.sql` — row-level security for the three roles
3. `0003_storage.sql` — six private buckets and their policies

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
```

---

## 5. Web app

```bash
npm ci
npm run build
npm run start --workspace=@ohj/web
```

Required environment: `DEMO_MODE=0`, `NODE_ENV=production`, `APP_BASE_URL`, `ADMIN_SEED_USERNAME`, `ADMIN_SEED_PASSWORD`, `ADMIN_SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`.

**HTTPS is mandatory.** Session cookies are set `Secure` in production and will not survive a plain-HTTP origin.

`SUPABASE_SERVICE_ROLE_KEY` is server-side only. It must never be prefixed `NEXT_PUBLIC_` and must never reach the browser.

---

## 6. Worker — the part that needs care

The worker visits URLs chosen by the people being judged. Treat its host as untrusted-adjacent.

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN npm ci --omit=dev
USER pwuser
CMD ["npm", "run", "start", "--workspace=@ohj/worker"]
```

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
- [ ] Migrations applied and the three verification queries return the expected results
- [ ] `select count(*) from pg_policies where 'ohj_participant' = any(roles) and tablename in (assessment tables)` returns **zero**
- [ ] All six buckets are private (`select id, public from storage.buckets` — every row false)
- [ ] Secrets generated on a trusted machine and stored in a secrets manager
- [ ] `CREDENTIAL_ENCRYPTION_KEY` backed up
- [ ] Worker egress policy applied **and tested** — from inside the container, confirm `curl http://169.254.169.254` fails
- [ ] Worker holds no admin session secret
- [ ] HTTPS enforced on the web app
- [ ] `DEMO_MODE=0` in production, and verified at `/admin/settings`
- [ ] Shared admin password rotated away from the seed value
- [ ] `git ls-files | grep reference-materials` returns nothing

---

## 8. Post-deployment verification

1. Sign in to `/admin`. Confirm *Runtime configuration* shows demo mode off and the postgres driver.
2. Create a throwaway cohort, import one team, open the invite link.
3. Confirm the participant page shows the rubric and the deadline — and no score, rank or shortlist.
4. Submit a test entry and confirm it locks and issues a receipt.
5. Queue it and confirm the worker claims it within a poll interval.
6. Confirm evidence, scores and a ranking appear in the admin dashboard.
7. From a browser with no admin session, request `/admin/ranking` and confirm the redirect carries no state.
8. Delete the throwaway cohort.

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
2. Worker liveness — leases expiring without heartbeats means a worker is dying.
3. Failed-stage rate — a spike usually means a network or provider problem, not 400 bad products.
4. AI call count and token usage — reported as raw counts; apply your own rate.
5. Admin login failures — a spike is worth a look.

---

## 12. Open items before a production run

1. The postgres driver is specified and the schema is in place, but the worker currently refuses to start with `DEMO_MODE=0` rather than silently assessing fixtures. Wire and test the driver before a real cohort.
2. Confirm the AI provider and model, and freeze both for the cohort.
3. Load-test the queue at cohort scale.
4. Supply the real Outskill brand green (ADR-014).
5. Agree who holds the shared admin credential and the rotation schedule.
