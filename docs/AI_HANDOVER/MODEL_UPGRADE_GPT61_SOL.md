# Production model upgrade: gpt-5.6-terra → gpt-6.1-sol

Record of the judging-model change made between AIAP C15 and the next cohort,
and the procedure for reverting it. Variable names only; no values.

## What changes, and what does not

Only the model the Railway judging worker sends to OpenAI. The variable is
`AI_MODEL`; `AI_PROVIDER` stays `openai`, `AI_EVALUATION_MODE` stays
`production`, and `OPENAI_API_KEY` is reused unchanged. Nothing in the
repository hard-codes a judging model: the worker reads `AI_MODEL` at boot and
stamps that exact string on every artefact it produces (`model_version` on
artifact analyses, test plans, category scores, assessment summaries and
feedback reports).

Untouched by design: rubric v2 and its weights, prompts (`assessment-prompts-v2`),
browser automation and evidence collection, cohort configuration, ranking, and
every historical row. Rows judged by `gpt-5.6-terra` keep that value; nothing
is relabelled.

## Pre-flight (2026-11-02, read-only)

Both C15 cohorts were finished before the worker changed model:

| Cohort | Jobs | Stage | Leased | Feedback | Open flags | Current ranking | Winners |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AIAP-C15-IST | 38 | all `completed` | 0 | 38 `generated` | 29 | 29 entries | not yet selected |
| AIAP-C15-EST | 39 | all `completed` | 0 | 39 `generated` | 28 | 39 entries | not yet selected |

No non-terminal job existed anywhere in the database, no lease was held, no
consistency review had been queued (the table holds no C15 rows), and every
C15 artefact carries `model_version = gpt-5.6-terra`, `prompt_version =
assessment-prompts-v2`.

An MD5 fingerprint of every C15 result table (submissions, jobs, analyses,
summaries, 616 category scores, flags, preflight checks, plans, runs, 3,378
evidence rows, snapshots, 68 ranking entries, final selections) was taken
before and after the worker restarted on the new model. Identical.

## Adapter compatibility (`packages/ai/src/provider.ts`)

The OpenAI adapter already speaks the Responses API in the form gpt-6.1-sol
needs, and no request-shape change was required:

- `POST /v1/responses` with `input`, `max_output_tokens` (not `max_tokens`).
- Strict Structured Outputs (`text.format.type = json_schema`, `strict: true`)
  for every judging schema; `toStrictJsonSchema` converts all five without
  approximating, and Zod re-validates afterwards.
- Reasoning items in `output` are skipped; text is read from `message` items.
- `status: incomplete` is a hard failure naming the limit hit;
  `status: failed` likewise; an empty 200 is retried.
- Timeouts abort the request (`AI_TIMEOUT_MS`, default 60 s) and are retried
  with jittered exponential backoff; 429 obeys `Retry-After`; 5xx retries;
  400/401/403/404 do not. `AI_MAX_RETRIES` default 2.
- Output budgets: 4,096 tokens default; 8,000 for test-plan generation and
  scoring. On a reasoning model these budgets include reasoning tokens, so
  they are the thing to watch in the synthetic run below.
- No `reasoning.effort` is sent, so the model's default (medium) applies.

Diagnostics added for this upgrade (no behavioural change to judging):
`AiResponse.providerModel` (the snapshot the API reports having served) and
`AiResponse.reasoningTokens`; the "stopped early" error now says how many
output tokens were spent and how many were reasoning.

## Synthetic validation

`scripts/controlled-ai-run.ts` runs the four model calls the pipeline makes
for one submission — artifact analysis, test-plan generation, scoring across
all eight categories, participant feedback — through the real adapter, real
prompts and real schemas, on a fictional submission with planted PII and a
planted credential that must be redacted before anything is sent. It opens
no database connection, reads no sheet, queues no job and writes nothing.

```
OPENAI_API_KEY=<key> npx tsx scripts/controlled-ai-run.ts --provider openai --model gpt-6.1-sol --json /tmp/sol-run.json
OPENAI_API_KEY=<key> npx tsx scripts/openai-smoke.ts --model gpt-6.1-sol
```

(`npx vite-node <script> -- <flags>` works where tsx's esbuild service does
not.) The key is `OPENAI_API_KEY` only. `AI_API_KEY` holds the Gemini
credential on the worker and in `.env.local`, and both scripts refuse to send
it to OpenAI. The run records, per stage: served model, schema validity,
attempts and HTTP requests, latency against the 60 s timeout, input / cached /
output / reasoning tokens, share of the output budget used, and an estimated
cost at list price.

Decision rule for budgets: if any stage used more than ~70% of its output
budget, or ran longer than ~40 s, raise only that stage's `maxOutputTokens`
(pipeline.ts) or `AI_TIMEOUT_MS` on the worker, and re-run. Do not raise every
budget.

### Results (2026-11-02, via `railway run --no-local` on the live service)

Smoke test: served model `gpt-6.1-sol`, strict schema valid, 1 attempt,
456 in / 64 out tokens, 5.5 s.

Controlled run, three repetitions, every stage valid on the first attempt,
all eight categories scored within their ceilings, feedback safety check
passed, planted PII and credential removed from every payload:

| Stage | Budget | Output tokens (reasoning) | Latency |
| --- | --- | --- | --- |
| Artifact analysis | 4,096 | 600–635 (84–100) | 10–12 s |
| Test-plan generation | 8,000 | 4,469–5,271 (778–956) | 48–57 s |
| Scoring, 8 categories | 8,000 | 2,121–2,161 (142–260) | 32–33 s |
| Feedback | 4,096 | 844–908 (98–146) | 15–17 s |

About 10.5k input and 8.1k output tokens per submission, of which ~1.2k are
reasoning; $0.09–0.10 per submission at list price, roughly $4 per 40 teams
before the top-20 consistency pass. Output budgets are adequate (the largest
use is 66% of the test-plan budget).

The timeout was not. Test-plan generation ran to 95% of the 60 s limit on a
small fictional submission; a real one with a longer declared workflow would
abort, retry twice at 60 s each, and fail the job. Under gpt-5.6-terra every
C15 job completed in one attempt with no timeout ever recorded, so this is
new behaviour of the new model. The one configuration change made:
`AI_TIMEOUT_MS=120000` on the live worker service. Output budgets, retries
and prompts are unchanged. A fourth run through the service's injected
environment confirmed the value reaches the adapter.

## Cutover

The live worker is the Railway service deployed by the GitHub integration
into project **lucky-dedication / production** (commit status
"lucky-dedication - outskill-hackathon-judge"). The project named
`outskill-hackathon-judge-worker` visible to the CLI login is a dormant
leftover and must not be redeployed.

Variables on the live service: `AI_PROVIDER=openai`, `AI_MODEL=gpt-6.1-sol`,
`AI_EVALUATION_MODE=production`, `AI_TIMEOUT_MS=120000`, `OPENAI_API_KEY`
unchanged. The project belongs to a different Railway account from the one
that owns the dormant worker project; log the CLI in as that account (device
code approved from wherever it is signed in) before `railway run`. Saving the
variable redeploys the service. Vercel is untouched: the web tier holds no AI
configuration and reads the model from the worker's own report.

Verification, from the worker's report in `worker_status` (shown on the
Admin → Judging banner): `ai_provider = openai`, `ai_model = gpt-6.1-sol`,
`evaluation_mode = production`, `demo_mode = false`, `started_at` after the
variable change, `last_seen_at` within the last minute, and zero leased jobs.

## Rollback

Only `AI_MODEL` moves back:

1. Railway → project lucky-dedication → the worker service → Variables.
2. Set `AI_MODEL=gpt-5.6-terra`. Leave `AI_PROVIDER`, `OPENAI_API_KEY` and
   `AI_EVALUATION_MODE` as they are. `AI_TIMEOUT_MS=120000` can stay: the
   old model never approached 60 s, so the wider limit is harmless to it.
3. Save; Railway redeploys. The worker finishes in-flight work on SIGTERM,
   restarts, and reports the model it is now using within a minute.
4. Confirm on Admin → Judging: "Production judging — openai (gpt-5.6-terra)".
5. Any job that failed under the new model is re-queued from its submission
   page ("Rerun assessment") and is judged by whichever model the worker
   reports at that moment — do this after step 4, not before.

Do not run a cohort half on one model and half on the other. If a rollback
happens mid-batch, re-run the jobs completed under the first model so every
team in that batch is scored the same way.

## Cost

List prices from third-party listings checked 2026-11-02 (confirm on OpenAI's
pricing page before budgeting), USD per million tokens:

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| gpt-5.6-terra | 2.00 | 0.20 | 12.00 |
| gpt-6.1-sol | 2.00 | 0.10 | 10.00 |

Input price is unchanged and output is about 17% cheaper per token. Whether a
submission costs less overall depends on how many reasoning tokens Sol spends
at medium effort, which the synthetic run measures.
