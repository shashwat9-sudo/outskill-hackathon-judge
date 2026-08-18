# AI provider setup

How to give the judge a model, and what each choice costs.

Verified against the real Gemini API on 12 August 2026 with synthetic fixture
data. Two calls, both valid on the first attempt, ~4.9k tokens. No learner data
was involved and no Supabase row changed.

---

## 1. Which provider

The provider is chosen entirely by environment variable. No assessment or domain
code refers to a provider by name, so switching is a configuration change.

| `AI_PROVIDER` | Key needed | Cost | Use |
| --- | --- | --- | --- |
| `demo` | no | none | Default. Fixed sample results, no network call. |
| `gemini` | yes | free tier available | **Recommended for internal evaluation.** |
| `ollama` | no | none | A model on your own machine. |
| `anthropic` | yes | paid | Later, for production judging. |
| `openai` | yes | paid | Later, for production judging. |
| `custom` | yes | depends | Any OpenAI-compatible gateway. |

---

## 2. Recommended internal-evaluation configuration

Put this in `.env.local`. Do not paste the key anywhere else.

```
AI_PROVIDER=gemini
AI_MODEL=gemini-3.5-flash-lite
AI_API_KEY=<your key>
AI_EVALUATION_MODE=synthetic_only
```

**Not `gemini-2.5-flash-lite`.** It still appears in the model list, and a new
key cannot use it — the API answers *"no longer available to new users"*. That
is worth knowing because the listing endpoint says nothing about it; only an
attempted call does.

Confirmed working on a new free key: `gemini-3.5-flash-lite`,
`gemini-3.1-flash-lite`, `gemini-flash-lite-latest`.

A pinned version is preferred over `-latest`. Judging should be reproducible,
and an alias that silently moves to a new model between two runs makes two
cohorts incomparable for a reason nobody recorded.

Changing model is `AI_MODEL` alone — the name goes straight into the request
path and is never hard-coded.

A wrong model name produces a 404 whose message names the model and points at
`AI_MODEL`, rather than a generic provider error.

---

## 3. Getting a free Gemini API key

1. Open <https://aistudio.google.com/apikey>.
2. Sign in with a Google account.
3. Press **Create API key**.
4. Choose a Google Cloud project, or let it create one.
5. Copy the key.
6. Paste it into `.env.local` as `AI_API_KEY=…`.

**Billing is not required** for the free tier. Google AI Studio issues a key
against a project with no billing account, and Gemini's free tier allows a
limited number of requests per minute and per day at no cost.

Two things worth knowing before you use it:

- **Free-tier content may be used to improve Google's models.** This is the
  reason `AI_EVALUATION_MODE=synthetic_only` is the default, and why the system
  refuses to send real learner work while it is set. A paid tier carries
  different terms — check them before switching to `production`.
- **Free quotas are per-day and per-minute.** When one is exhausted the system
  does not retry, because retrying cannot fix it and consumes what remains
  faster. The error says so and suggests the alternatives.

---

## 4. The synthetic-only guard

`AI_EVALUATION_MODE` decides what an external model is allowed to see.

| Value | Behaviour |
| --- | --- |
| `synthetic_only` | **Default.** Only demo/fixture data is sent. Real learner work is refused. |
| `production` | Real cohorts may be judged. |

The guard runs before every provider call, not once at startup, so changing the
mode does not require a restart to take effect — and a worker that has been
running since before the change cannot keep sending.

It refuses rather than warns. An operator under deadline pressure who sees "are
you sure?" clicks yes; one who sees *"this cohort holds real learner work and
the current mode forbids sending it"* goes and changes the setting deliberately.

**What counts as synthetic** is derived from the store, not from a label anyone
can edit: the in-memory driver *is* the demo fixtures, and the Postgres driver
holds real learner work — all of it. So under `synthetic_only`, an external
provider receives nothing from the production database whatever it is named.

The `demo` provider is exempt because it makes no network call. There is no
boundary to protect when nothing crosses one.

---

## 5. Running with no API at all

```
AI_PROVIDER=ollama
AI_MODEL=llama3.2
```

Requires [Ollama](https://ollama.com) running locally and the model pulled:

```
ollama pull llama3.2
```

Nothing leaves the machine and nothing is charged. Quality depends entirely on
the local model — a small one will fail schema validation more often, which the
retry-then-refuse path handles by sending the submission to manual review rather
than inventing a score. Treat local results as a rehearsal of the pipeline, not
as a judgement.

No model has been downloaded. Nothing here installs one.

---

## 6. What the operator sees

The judging page states which of four situations applies, because "a key exists"
is not the same as "judging is safe":

| State | Meaning |
| --- | --- |
| **Demo fixtures** | Fixed sample results. Nothing sent, nothing charged. |
| **No AI provider configured** | The worker will not start. Submissions are safe. |
| **Local model** | Runs on this machine. Nothing leaves it. |
| **Internal evaluation** | Only demo data is sent. A real cohort cannot be judged. |
| **Production judging** | Real submissions go to an external provider, and this costs money. |

---

## 7. What is never sent

Enforced by test, not by convention.

- **Demo credentials.** Decrypted once, in the browser stage, at the moment a
  form is filled. The artifact-analysis stage used to decrypt them purely to
  assert they were absent from the payload — which put plaintext in memory
  exactly when a payload was being built. It no longer does.
- **Learner names, emails, phone numbers.** Removed by a redaction pass, and
  structurally absent from every payload builder.
- **Team identifiers.** Submissions reach a model as `SUB-XXXXXXXXXXXX`, a hash
  salted per cohort.
- **Access codes, WhatsApp links, admin or database credentials.** No builder has
  a field for them.

See `apps/worker/src/credential-boundary.test.ts` and
`packages/shared/src/data/participant-boundary.test.ts`.
