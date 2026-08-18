# Supabase setup

Creating the project, applying the schema, and wiring the application to it.

**This is a user-gated checkpoint.** Creating a Supabase project requires a
browser login, and applying migrations to a remote database is an irreversible
remote operation. Neither is done automatically.

---

## 1. Before you start

You will need:

- a Supabase account with permission to create a project in the right
  organisation;
- the Supabase CLI (`npx supabase --version`);
- a decision about the region — put it near your learners, not near you. For an
  Indian cohort that is `ap-south-1` (Mumbai).

You will **not** need to paste any secret into a chat, a document, or a commit.
Everything below either stays in the Supabase dashboard or goes into a `.env`
file that is git-ignored.

---

## 2. Create the project

In the Supabase dashboard:

1. **New project**, in the correct organisation.
2. Name it for the cohort, not for the platform — `outskill-hackathon-mar-2026`
   ages better than `outskill-judge`.
3. Choose the region.
4. Generate a database password. Store it in your password manager. You will not
   be shown it again, and it is not recoverable.
5. Wait for provisioning.

Note down, from **Project Settings → API** and **→ Database**:

| Value | Where it goes | Sensitivity |
| --- | --- | --- |
| Project URL | `SUPABASE_URL` | Public |
| `anon` key | not used by this application | Public |
| Secret key (`sb_secret_…`) | `SUPABASE_SECRET_KEY` | **Secret — server only** |
| Connection string | `DATABASE_URL` | **Secret** |

Use the **secret key**, not the legacy `service_role` key. Supabase is retiring
the latter, and it cannot be rotated independently of the project. The legacy
name is still accepted as a fallback so an existing deployment keeps working, but
a new setup should not use it.

**Connection string: use the TRANSACTION pooler**, from **Connect → Transaction
pooler**. The web tier is serverless, and a session-pooler connection pins a
Postgres backend for its whole life — a few hundred concurrent functions in the
final hour before a deadline exhaust the server that way. The transaction pooler
returns a backend after each transaction (ADR-032).

Transaction-pooler constraints the driver already respects, audited and clean:
no named prepared statements, no session `SET`, no temporary tables, no
LISTEN/NOTIFY, no session advisory locks, no held cursors.

The `service_role` key bypasses row-level security entirely. It belongs in the
web application's server environment and nowhere else. It must never reach the
browser, the worker, a log line, or a repository.

---

## 3. Link the CLI

```bash
npx supabase login          # opens a browser
npx supabase link --project-ref <your-project-ref>
```

The project ref is in the dashboard URL.

---

## 4. Apply the migrations

Four migrations, applied in order:

| File | Contents |
| --- | --- |
| `0001_schema.sql` | Tables, constraints, triggers |
| `0002_rls.sql` | Roles, policies, grants |
| `0003_storage.sql` | Six private buckets and their policies |
| `0004_production_entry.sql` | Access codes, sessions, activity, versioning, closure, idea approval |

Review them first — this is the last point at which a mistake is cheap:

```bash
npx supabase db diff --linked --schema public
```

Then apply:

```bash
npx supabase db push --linked
```

### Commands never to run against a linked project

```
supabase db reset --linked      # drops everything
drop schema public cascade      # the same, by hand
```

Neither has a use here. Migrations are forward-only. If one is wrong, write
another that corrects it.

---

## 5. Verify the schema landed

Run each of these in the SQL editor. They are cheap, and each catches a specific
way a setup goes wrong.

### Every table has RLS enabled

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and rowsecurity = false;
```

Expected: **no rows.** A table without RLS is a table any authenticated request
can read.

### Participants have no reach into assessment

```sql
select tablename, policyname, roles
from pg_policies
where schemaname = 'public'
  and 'ohj_participant' = any (roles)
order by tablename;
```

Expected: policies on `teams`, `team_members`, `cohorts`, `cohort_ideas`,
`submissions`, `submission_artifacts`, `submission_credentials`,
`submission_declarations`, `submission_events`, `resource_documents` and
`team_activity` — and **nothing else**.

Specifically, there must be **no** participant policy on `team_access_codes`,
`participant_sessions` or `verification_attempts`. A participant able to read
`team_access_codes` could enumerate every group in the cohort, which is exactly
what the generic verification error exists to prevent.

And no participant policy on any of: `category_scores`, `assessment_summaries`,
`assessment_evidence`, `browser_test_runs`, `ranking_snapshots`,
`ranking_entries`, `final_selections`, `feedback_reports`, `manual_review_flags`,
`disqualifications`, `audit_logs` (ADR-010).

### Nobody deletes through the application

```sql
select grantee, table_name
from information_schema.role_table_grants
where table_schema = 'public' and privilege_type = 'DELETE'
  and grantee in ('ohj_participant', 'ohj_admin', 'ohj_worker');
```

Expected: **no rows.** Removal is a retention job with elevated privileges, and
it is audit-logged.

### The entry tables exist with their constraints

```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('team_access_codes','participant_sessions',
                     'team_activity','verification_attempts');
```

Expected: four rows.

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'team_access_codes';
```

Expected: no column that could hold plaintext. If you see one, something has
been added that should not have been.

### One live code per team

```sql
select indexname from pg_indexes
where tablename = 'team_access_codes' and indexname = 'team_access_codes_one_live';
```

Expected: one row.

---

## 6. Storage buckets

`0003_storage.sql` creates six buckets, all private:

| Bucket | Contents | Size limit |
| --- | --- | --- |
| `submission-decks` | Pitch deck PDFs | 25 MB |
| `submission-screenshots` | Screenshots captured while testing a product | 10 MB |
| `browser-evidence` | Per-step browser evidence | 50 MB |
| `traces` | Playwright traces — the most sensitive artifact held, since a trace can contain a product in an authenticated state | 200 MB |
| `internal-reports` | Generated internal reports | 25 MB |
| `admin-resources` | Templates, instructions, the playbook | 50 MB |

Verify none is public:

```sql
select id, public from storage.buckets order by id;
```

Expected: `public = false` for all six. A public evidence bucket is a public
list of everything the judges saw.

---

## 7. Configure the application

Copy `.env.example` to `.env.local` and fill it in. `.env.example` ships with
empty placeholders and no real values; `.env.local` is git-ignored.

```
DEMO_MODE=0
NODE_ENV=production
APP_BASE_URL=

# Transaction pooler, not session pooler — see above.
DATABASE_URL=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
# Per serverless INSTANCE, and instances multiply. Small on purpose.
DATABASE_POOL_MAX=2

ADMIN_SESSION_SECRET=
CREDENTIAL_ENCRYPTION_KEY=
ADMIN_SEED_USERNAME=
ADMIN_SEED_PASSWORD=
```

`loadEnv` refuses to start with `DEMO_MODE=0` unless `ADMIN_SESSION_SECRET`
(32+ characters), `CREDENTIAL_ENCRYPTION_KEY`, and one of `DATABASE_URL` or
`SUPABASE_URL` are all present. It fails at boot rather than mid-request, which
is the behaviour you want.

| Value | Generate with | Notes |
| --- | --- | --- |
| `ADMIN_SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` | Also keys participant session hashes and signs verification handles |
| `CREDENTIAL_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` | Exactly 32 bytes, base64. **Losing it makes stored demo credentials permanently unreadable.** |
| `ADMIN_SEED_USERNAME` / `ADMIN_SEED_PASSWORD` | Chosen by you | Seeds the one shared admin on first run. Outside demo mode the app refuses to start without them if no admin exists. Rotate from `/admin/settings` afterwards. |

Generate both secrets fresh for each environment. Never reuse a staging secret
in production — the whole point of a per-environment secret is that a leak in
one place does not travel.

`APP_BASE_URL` appears in the access-code CSV as the submission URL. Getting it
wrong sends every team to the wrong address.

The application does **not** read `SUPABASE_ANON_KEY`. All database access is
server-side under the secret key or a direct Postgres connection, so there is no
anon-key path to configure.

Neither key may ever be exposed to the browser. Do not prefix either with
`NEXT_PUBLIC_` — that inlines the value into the client bundle, and both keys
bypass row-level security entirely.

---

## 8. What happens on first start

`getStore()` currently **throws** when `DEMO_MODE=0`, because the postgres
driver is not wired yet:

> DEMO_MODE is off but no database driver is configured.

That is deliberate. Silently falling back to fixtures in production would be far
worse than a startup failure — the platform would appear to work while accepting
submissions into memory that vanish on restart.

Wiring the postgres driver is the remaining step after this checkpoint. It
implements the same repository interfaces as the memory driver, so no
application code changes (ADR-003).

---

## 9. Do not seed remote data

Do not create synthetic teams, synthetic submissions, or a demo cohort on a real
project. The demo fixtures exist for `DEMO_MODE=1` and are deliberately
recognisable as fake; on a real project they would sit alongside genuine
submissions and eventually be mistaken for them.

Real cohorts are created through the admin UI, and real teams are imported from
a CSV.

---

## 10. First-run checklist

- [ ] Project created in the right organisation and region
- [ ] Database password stored in a password manager
- [ ] CLI linked
- [ ] Migrations 0001–0004 applied
- [ ] Every RLS verification query returns what it should
- [ ] All six storage buckets private
- [ ] `.env.local` filled in, never committed
- [ ] `ADMIN_SESSION_SECRET` freshly generated for this environment
- [ ] `APP_BASE_URL` correct
- [ ] No synthetic data on the remote project
- [ ] Admin account created and its password changed from any default
