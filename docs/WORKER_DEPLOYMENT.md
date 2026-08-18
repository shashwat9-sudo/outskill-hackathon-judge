# Deploying the judging worker

The web app is on Vercel. The worker cannot be: it drives a real Chromium
against a participant's product for minutes per submission and writes a trace as
it goes. That needs a machine with a browser on it and time to use it.

Everything here is prepared and proven as far as it can be without a Google
Cloud account. **The deploy itself needs yours** — a project, billing, and
secrets only your team should hold.

Nothing in this document contains a secret value, and nothing should be added
that does.

---

## 1. What has already been proven

| | |
| --- | --- |
| Judging path, end to end | Real Playwright, real evidence, real Gemini. 8/8 categories scored, known fixture defects detected. |
| Queue at scale | 400 jobs, 8 concurrent workers, real PostgreSQL. 0 duplicates, 0 double-claims, 0 stuck, 0 errors. |
| Lease behaviour | A live lease is not stolen; an expired one is recovered by the next worker. |
| Playwright pin | Installed `1.62.1` matches the image tag `v1.62.1-noble` exactly. |
| Image build | **Not run locally — Docker is not installed on the build machine.** See §7. |

---

## 2. Environment variables

Set on the Cloud Run service. **Names only below — never paste a value into a
chat, a ticket or a commit.**

### Plain values (safe in the deploy command)

| Name | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | |
| `DEMO_MODE` | `0` | Anything else serves fixtures instead of the database. |
| `AI_EVALUATION_MODE` | `synthetic_only` | **Hold this until real learner processing is separately approved.** It refuses to send anything to a model that did not come from a synthetic cohort. |
| `BROWSER_HEADLESS` | `true` | |
| `WORKER_CONCURRENCY` | `2` | Browsers per instance. See §4. |
| `WORKER_HEALTH_PORT` | `8080` | Liveness and readiness. |
| `JOB_LEASE_SECONDS` | `900` | Must exceed the longest browser run. |
| `JOB_MAX_ATTEMPTS` | `3` | Bounded retry. Do not raise this to hide a failure. |
| `BROWSER_TEST_BUDGET_MS` | `480000` | Per-submission ceiling. |

### From Secret Manager

| Secret name | Holds |
| --- | --- |
| `ohj-database-url` | `DATABASE_URL` — **the pooler URL, port 6543**, not the direct port |
| `ohj-supabase-url` | `SUPABASE_URL` |
| `ohj-supabase-secret-key` | `SUPABASE_SECRET_KEY` |
| `ohj-credential-key` | `CREDENTIAL_ENCRYPTION_KEY` |
| `ohj-session-secret` | `ADMIN_SESSION_SECRET` |
| `ohj-ai-provider` | `AI_PROVIDER` |
| `ohj-ai-api-key` | `AI_API_KEY` |

**`CREDENTIAL_ENCRYPTION_KEY` must be byte-identical to the one the web app
uses.** Demo credentials already stored are encrypted with it. A different key
does not fail at start-up — it fails at the moment a judge tries to read a
team's login, mid-run, on the night.

The AI key exists **only** on the worker. The web app has none, deliberately:
it never calls a model, so a key there could only leak, never help.

---

## 3. Creating the secrets

**console.cloud.google.com → Security → Secret Manager → Create secret**, once
per row above. Paste each value from your local `.env.local` **into the Google
console**. Never into a chat.

Then grant the service account access: **Secret Manager Secret Accessor** on
each secret, for the Cloud Run service identity.

---

## 4. Cloud Run configuration

```bash
./scripts/deploy-worker-cloudrun.sh <PROJECT_ID> asia-south1
```

| Setting | Value | Why |
| --- | --- | --- |
| CPU | **2** | One Chromium per concurrent job, plus the trace writer. |
| Memory | **4 GiB** | A browser with a trace open is 1–1.5 GiB; two plus headroom. |
| `--concurrency` | **1** | Cloud Run request concurrency, not job concurrency. Nothing calls this service; leave it at 1 so the platform never multiplexes. |
| `WORKER_CONCURRENCY` | **2** | Jobs per instance. 2 × 3 instances = 6 in flight. |
| Min instances | **1** | **Load-bearing.** Scale-to-zero means judge-to-zero: nothing calls this service, so a scaled-down instance never wakes. |
| Max instances | **3** | 6 concurrent browsers against 300–500 submissions. Raise only after watching the queue drain. |
| `--no-cpu-throttling` | **on** | **Load-bearing.** Cloud Run parks the CPU between requests. A worker that receives none would be parked permanently, holding a lease it cannot progress. |
| Timeout | **3600s** | Longer than any single job. |
| Ingress | `--no-allow-unauthenticated` | There is no endpoint anyone should call. |
| Region | `asia-south1` | Beside the database in `ap-south-1`. A worker in `us-central1` pays that round trip on every one of the dozens of queries per assessment. |

**Cost note:** `--min-instances=1` with `--no-cpu-throttling` means the instance
runs continuously. That is a standing charge, and it is a billing decision for
your team.

---

## 5. Network safety

A judging worker fetches URLs that strangers supplied. That is an SSRF risk by
definition, and a cloud host sharpens it: `169.254.169.254` returns credentials
on GCP as readily as anywhere else.

### The application layer — tested, working now

The guard resolves the hostname **and then checks the resolved addresses**,
which is the only placement that works: a name the submitter controls can point
anywhere, so checking the name catches nothing.

Denied, each with a named test: `127.0.0.0/8`, `0.0.0.0`, `::1`, `10/8`,
`172.16/12`, `192.168/16`, `169.254.0.0/16`, **`169.254.169.254` reported as its
own reason**, `fc00::/7`, `fe80::/10`, and by name `localhost`, `*.localhost`,
`*.local`, `ip6-localhost`.

Default-deny: an address that cannot be resolved or classified does not proceed.
A blocked address raises a manual-review flag rather than failing silently.

### The network layer — must be configured at deploy time

Application checks are necessary and not sufficient: a DNS rebind can pass the
check and then resolve differently when the browser connects. Close that at the
platform:

1. **Create a VPC connector** and set egress:
   `--vpc-egress=all-traffic --vpc-connector=<name>`
2. **Cloud NAT** for outbound internet, so egress leaves by a known address.
3. **Firewall egress rules**, in this order:
   - `deny` to `169.254.169.254/32` — priority **100** (metadata)
   - `deny` to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — priority **200**
   - `deny` to `fc00::/7`, `fe80::/10` — priority **300**
   - `allow` to `0.0.0.0/0` — priority **1000**
4. Keep the metadata server reachable **only** for the service identity's own
   token fetch, or disable it entirely if secrets come from Secret Manager
   mounts rather than the metadata endpoint.

Until step 3 exists, the application layer is the only line. It is tested and it
holds against everything we can express in code; it cannot hold against a rebind
that changes between check and connect.

---

## 6. Health and logs

```bash
gcloud run services logs read ohj-judging-worker \
  --project <PROJECT_ID> --region asia-south1 --limit 50
```

- **`/healthz`** — liveness. Answers while a browser run is in flight; a worker
  inside a run is *busy*, not stalled.
- **`/readyz`** — readiness. Reports not-ready when the database is unreachable.

A healthy idle worker logs that it started, connected, and is polling an empty
queue, then goes quiet. That is correct.

**Logs carry job ids, submission ids and stage names. They must never carry an
access code, a demo credential, or a secret** — asserted by
`credential-boundary.test.ts`.

---

## 7. The image

Built from `apps/worker/Dockerfile`: Playwright base image pinned to
**`v1.62.1-noble`**, matching the resolved client exactly. Non-root (`pwuser`).
`SIGTERM` handled, so a redeploy releases its lease rather than stranding a job
for the lease duration.

**The image has not been built locally** — Docker is not installed on this
machine. `scripts/deploy-worker-cloudrun.sh` uses **Cloud Build**, which is
better anyway: the image is built on the architecture it runs on, and an image
built on an arm64 laptop will not start on an amd64 instance.

The first `gcloud builds submit` is therefore also the first build. If it fails,
it will fail there with a readable error, before anything is deployed.

---

## 8. Rollback

Cloud Run keeps every revision.

```bash
# What is deployed, and what came before
gcloud run revisions list --service ohj-judging-worker \
  --project <PROJECT_ID> --region asia-south1

# Send all traffic back to the previous revision
gcloud run services update-traffic ohj-judging-worker \
  --project <PROJECT_ID> --region asia-south1 \
  --to-revisions <PREVIOUS_REVISION>=100
```

**Rolling back is safe mid-run.** Jobs are leased, not assigned: a worker that
disappears leaves a lease that expires, and the next worker picks the job up
with its attempt count intact. Nothing is lost and nothing is double-scored —
`unique (job_id, category_key)` makes a second write of the same score
impossible at the database level.

To stop judging without redeploying, scale to zero:

```bash
gcloud run services update ohj-judging-worker --min-instances=0 --max-instances=0 \
  --project <PROJECT_ID> --region asia-south1
```

In-flight leases expire and the jobs return to the queue.

---

## 9. The first synthetic production job

Do this before any rehearsal, and never against a real cohort.

1. **Confirm the mode.** The service must show
   `AI_EVALUATION_MODE=synthetic_only`. If it does not, stop.
2. **Create one disposable synthetic cohort** — `npx tsx
   scripts/seed-synthetic-cohort.ts staging` — with `@example.com` learners
   only. It refuses to touch `AIAP C13 Demo` or any `PRODUCTION TEST` cohort.
3. **Final-submit one synthetic team** through the deployed web app.
4. **Close the cohort**, then start judging from the admin interface.
5. **Watch one job through**, in the logs: `queued → preflight →
   artifact_analysis → test_plan_generation → browser_testing → evidence_review
   → scoring → completed`.
6. **Read the evidence, not just the score.** Open the submission in the admin
   interface and check that screenshots exist, the trace is downloadable, and
   the categories cite what they saw.
7. **Confirm no finalist was chosen.** The system ranks and shortlists; it never
   selects. `final_selections` must be empty.

If any stage stalls, check `assessment_jobs.last_error` before restarting
anything. A restart clears the symptom and loses the reason.

---

## 10. What must stay true

- `AI_EVALUATION_MODE=synthetic_only` until real learner processing is approved
  separately and deliberately.
- No real learner cohort is judged. `AIAP C13 Demo` holds 640 real learners.
- The system never declares a winner. Humans choose the final four, and every
  choice is recorded against the person who made it.

---

## The worker's database login

The worker must not connect as `postgres`.

Migration `0002_rls.sql` wrote a careful set of policies for `ohj_worker`: it
reads submissions, writes assessment output, may read a product credential at
the moment it uses one, and has no access at all to the ranking tables, because
a machine does not choose winners (ADR-018). None of that was in force. The role
was created `nologin`, so the worker connected as `postgres` instead — an owner
and a superuser, which bypasses row-level security silently. Every policy was
decoration.

Migration `0006_worker_least_privilege.sql` narrows the grants to match the
policies and makes the role usable. It deliberately contains no password: a
password in a migration is a password in Git.

**Once, per environment**, run as a database superuser:

```sql
alter role ohj_worker with login password '<generate one, store it in the password manager>';
```

Then set the worker's `DATABASE_URL` to connect as `ohj_worker` rather than
`postgres`. On Railway this is an environment variable on the service; it is
never committed, never printed, and never shared with the web app, which has its
own connection.

The worker checks at boot and **refuses to start** if its connection bypasses
row-level security. That is deliberate: the failure it guards against is
invisible at runtime, because everything works — that is the problem. For a
local database that has never had the roles created, set
`WORKER_ALLOW_SUPERUSER_DB=1`, which logs a warning naming the role.

Verified by `packages/shared/src/data/postgres/worker-privileges.test.ts`, which
tries each forbidden operation and asserts the refusal. Seven of its twelve
tests fail if migration 0006 is removed.

## Evidence uploads

The worker holds no Supabase Storage credential, deliberately. It captures
screenshots and traces to a local directory, asks the web app for permission to
write one object, uploads to that one path, and asks the web app to confirm —
and only the confirmation writes a path to the database. The web app checks with
Storage before it records anything, so a row never claims evidence that is not
in the bucket.

Two environment variables enable it:

- `WORKER_API_TOKEN` — a shared secret, at least 32 characters, set on **both**
  Vercel and Railway with the same value. Compared in constant time. Never
  logged, never placed in a URL, and never sent to the Storage host.
- `APP_BASE_URL` — where the web app lives.

Without them the worker still judges and simply records no evidence paths, which
is honest; the alternative is writing down a local path that will not exist
tomorrow.

The local staging directory is emptied at boot — anything left behind belongs to
a container that no longer exists — and each job's directory is removed once its
uploads have been attempted. A local file is deleted only after the web app
confirms the object is really in the bucket. A failed upload keeps its bytes and
logs the reason; evidence we still have is worth more than a tidy directory.
