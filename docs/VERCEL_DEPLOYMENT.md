# Deploying to Vercel

What was done, what it costs to repeat, and what is still missing before real
learners are pointed at it.

Written on 16 August 2026, against the first staging deployment.

---

## What exists now

| | |
| --- | --- |
| **URL** | `https://outskill-hackathon-judge.vercel.app` |
| Vercel project | `outskill-hackathon-judge` (`shashwatom-8192s-projects`) |
| Supabase project | `eoxfmegmwbchctfrfglr` — the same database the local machine uses |
| Function region | `bom1` (Mumbai), matching the database's `ap-south-1` |
| AI | `AI_PROVIDER=demo`, no API key deployed at all |
| Worker | **not deployed** — it cannot run on Vercel, and staging does not judge |

The deployment is a real production build serving real data. It is called
staging because nothing has been distributed to a learner, not because it is a
separate database.

---

## Repeating a deploy

Three commands, from the repository root:

```bash
npx vercel deploy --prod --yes                 # build and ship
./scripts/vercel-env-push.sh production        # only when a secret changes
./scripts/vercel-set-base-url.sh https://…     # only when the URL changes
```

There is no git remote and no GitHub integration. The CLI uploads the working
directory, filtered by `.vercelignore`. That was a deliberate choice: it keeps
private material — `reference-materials/`, `.env.local`, screenshots of real
screens — off a third-party service by construction rather than by policy.

### The environment

`scripts/vercel-env-push.sh` copies what the deployment needs and nothing else.
Values are piped on standard input and never printed, so running it does not put
a secret in a terminal, a screenshot, or a transcript.

Deployed: `ADMIN_SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `DATABASE_URL`,
`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DEMO_MODE=0`, `DATABASE_POOL_MAX=1`,
`AI_PROVIDER=demo`, `AI_EVALUATION_MODE=synthetic_only`, `APP_BASE_URL`.

Deliberately **not** deployed:

- **`AI_API_KEY`** — the web app never calls a model. A key that is not there
  cannot leak from there.
- **`ADMIN_SEED_USERNAME` / `ADMIN_SEED_PASSWORD`** — the admin account already
  exists in the database. Sending its password to a hosting provider would
  create a second copy of a credential that currently has one.

`CREDENTIAL_ENCRYPTION_KEY` must be **the same value as the local one**. Demo
credentials already stored are encrypted with it, and a different key would not
fail at boot — it would fail at the moment a judge tries to read a team's login.

### Why the connection string matters

`DATABASE_URL` points at Supabase's **transaction pooler** on port 6543, not the
direct database port. Serverless multiplies instances rather than reusing one
process, and a few hundred cold starts against a direct connection exhausts the
database's connection limit long before the traffic is interesting.
`DATABASE_POOL_MAX=1` follows from the same reasoning: fan-in is the pooler's
job, not the application's.

---

## What had to change for Vercel

| | What | Why |
| --- | --- | --- |
| `vercel.json` | `buildCommand`, `outputDirectory`, `regions` | npm workspaces: the Next app is at `apps/web` but the lockfile and the shared packages are at the root, so the build has to run from the root and point at the app's output. |
| `next.config.mjs` | `serverActions.bodySizeLimit: '4mb'` | Next's default is 1 MB. Below that, the deck upload fails before reaching any of our own validation. |
| Four route files | `export const maxDuration` | `functions` patterns in `vercel.json` do not match App Router routes — the runtime decides what becomes a function, and the file path is not the handle. The first deploy failed on exactly this. |
| `.vercelignore` | build outputs, test artefacts, private material | Without it the upload carries ~460 MB of local build directories and, worse, screenshots of real screens. |
| `eslint.config.mjs` | allow `console` in `e2e-staging` | The staging suite's job is to report what it measured. |

Nothing about the product changed.

---

## Blockers before real learners

### D-1 — a 25 MB deck cannot reach a serverless function

The form promises 25 MB. A serverless request body tops out around 4.5 MB, so
anything larger is refused by the platform before the application sees it — and
the learner gets a platform error, not one of our sentences.

`serverActions.bodySizeLimit` is now 4 MB, which makes small and medium decks
work and does not fix the gap. **The real fix is to upload straight to Supabase
Storage from the browser with a signed URL**, and have the server record the
artifact only after confirming the object exists.

It was deliberately not attempted during deployment preparation: rewriting the
upload path is exactly the change that produced F-7, where uploads were recorded
and no bytes were stored, and it needs its own work and its own tests.

Until it is done, either cap the deck at 4 MB in the form — which changes what
teams are asked for — or do the direct-upload work. It is the largest single
item between here and a real launch.

### D-2 — the worker is not deployed, and cannot be deployed here

Judging runs Playwright and a headless browser per submission. That is not a
serverless workload: it needs a long-running machine with a browser installed.
Vercel is the wrong shape for it, and nothing in this deployment attempts it.

Not required for staging, and not required until real judging is approved. When
it is, it needs a container host — Railway, Render, Fly, or a plain VM — with
the same database and Storage credentials, `AI_PROVIDER` set to a real provider,
and its own decision about `AI_EVALUATION_MODE`.

### D-3 — the deployment is public

Anyone with the URL reaches the learner entry page, and the admin surface sits
behind one password on the same host. The database holds 640 real learners.

The admin password was rotated on 12 August and the surface itself is sound —
Argon2id, lockout after repeated failures, `httpOnly` `sameSite=strict` cookies,
every bucket private, RLS on all 38 tables. But a staging deployment does not
need to be reachable by strangers at all. **Vercel's Deployment Protection**
(Project → Settings → Deployment Protection → Vercel Authentication) closes it
to everyone outside the Vercel team in one setting, and should be turned on
between test runs.

---

## What was tested against the deployment

`npm run test:staging` — eleven checks over HTTPS against the real build, using
two synthetic teams whose codes live in a CSV on the operator's Desktop. It
starts no server and holds no credential of its own.

Covered: entry page and cohort naming, wrong-code refusal, sign-in, the
first-run walkthrough, draft save and reload, sign-out and back in, cross-team
isolation, the judging-data sweep, guide and completed example, deck upload into
Supabase Storage, final submit and the receipt PDF.

Not covered: **the admin interface**. Driving it needs the admin password, which
is the operator's. Cohort creation, learner import, code issuing and the
distribution CSV therefore remain a manual check.
