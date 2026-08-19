# Judge API — for the Outskill Hackathon product

The Judge is a private backend. It has no learner-facing UI in the new design:
the Hackathon product owns the form, the identifiers and the relationship, and
calls these three endpoints.

1. `POST /api/partner/cohorts` — register a cohort (once, before submissions)
2. `POST /api/partner/submissions` — submit a product for judging
3. `GET  /api/partner/cohorts/{cohort}/submissions/{submission}/result` — read scores

**Base URL:** `https://outskill-hackathon-judge.vercel.app`

## Authentication

Every request carries a bearer token:

```
Authorization: Bearer <PARTNER_API_TOKEN>
```

This is **not** `WORKER_API_TOKEN`. That one authorises the judging worker to
upload evidence for a job it holds — a different capability for a different
process. Sharing one secret would mean a leak on either side handing over both,
with no way to rotate one without breaking the other.

An absent, short or wrong token gets `404 Not found`, not `401`. Whether these
endpoints exist is not something an unauthenticated caller should learn.

---

## 1. Register a cohort  (do this first)

```
POST /api/partner/cohorts
Content-Type: application/json
```

Ops should never have to recreate cohorts by hand in the Judge admin, so the
internal product declares them. **Idempotent — safe to call on every deploy.**

```json
{
  "externalCohortId": "AIAP-C13",
  "name": "AI Accelerator Cohort 13",
  "code": "AIAP-C13",
  "day12StartAt": "2026-09-10T00:00:00.000Z",
  "day13DeadlineAt": "2026-09-11T18:00:00.000Z",
  "shortlistTarget": 10
}
```

Only `externalCohortId` and `name` are required. Dates default to now → now+2
days; `shortlistTarget` defaults to 10.

`201` on creation, `200` when it already existed:

```json
{ "ok": true, "cohortId": "6ed7884e-56e4-...", "externalCohortId": "AIAP-C13", "created": true }
```

### How the mapping works

`AIAP-C13` → one Judge cohort UUID, **permanently**. Re-syncing refreshes the
name, dates and shortlist target; it never re-points the identifier at a
different UUID, because that would strand every submission already judged under
it and move teams between rankings.

**Why this is explicit rather than created by the first submission.** A cohort
decides which ranking a team competes in and which private Top 10 they can
reach. A mistyped `externalCohortId` in your configuration should fail loudly at
submission time — not quietly open a second competition with one entrant in it.
A cohort also needs dates, a rubric version and a shortlist target that no
submission payload carries.

Submitting to an unknown cohort returns `422` with `unknownCohort: true` and
creates nothing.

**Learner and browser clients must never call this.** It sits behind
`PARTNER_API_TOKEN`, server-to-server only.

---

## 2. Submit a product for judging

```
POST /api/partner/submissions
Content-Type: application/json
```

### Request

```json
{
  "externalCohortId": "AIAP-C13",
  "externalSubmissionId": "sub_01HQ...",
  "groupNumber": 12,
  "ideaSlug": "meal-planner",
  "productName": "FridgeChef",
  "briefDescription": "Suggests dinners from what you already have. For busy parents.",
  "mainUserAction": "Type in the ingredients in your fridge and get a dinner suggestion you can cook tonight.",
  "aiValue": "It writes the recipe from whatever odd combination of things you have left.",
  "productUrl": "https://fridgechef.example.com",
  "accessMode": "open",
  "judgeCredentials": null,
  "loomUrl": "https://loom.com/share/abc",
  "deckUrl": "https://docs.google.com/presentation/d/abc",
  "submittedAt": "2026-08-19T18:30:00.000Z",
  "submissionVersion": 3
}
```

| Field | Required | Notes |
|---|---|---|
| `externalCohortId` | yes | **Server-supplied, from your backend configuration — never typed by a learner.** Must already be registered (endpoint 1). |
| `externalSubmissionId` | yes | Immutable. Unique *within a cohort*. |
| `groupNumber` | yes | 1–999. |
| `ideaSlug` | no | One of the eight approved ideas. Unknown slugs are accepted and left unlinked. |
| `productName` | yes | |
| `briefDescription` | no | What it does, who it is for, what problem it solves. |
| `mainUserAction` | **yes** | The answer to *"What is the main thing a user should be able to do successfully?"* **This drives the browser test plan.** |
| `aiValue` | no | The answer to *"How does AI help the user?"* |
| `productUrl` | yes | http/https. Public hostname — private/internal addresses are refused. |
| `accessMode` | yes | `"open"` or `"credentials"`. |
| `judgeCredentials` | only if `accessMode: "credentials"` | `{ username, password, notes? }`. Encrypted at rest, decrypted only at the moment the browser signs in, never returned. |
| `loomUrl`, `deckUrl` | no | Supporting evidence. Unreachable links produce missing evidence, never a guess. |
| `submittedAt` | no | ISO 8601. Defaults to now. |
| `submissionVersion` | no | Recorded in the snapshot. |

**Do not send team member names, emails or phone numbers.** The contract has
nowhere to put them, and the Judge does not need them to decide whether a
product works.

### Responses

`201 Created` — accepted, queued for judging:

```json
{ "ok": true, "submissionId": "9f2c...", "status": "submitted", "duplicate": false }
```

`200 OK` — already had it. Safe to retry as often as you like:

```json
{ "ok": true, "submissionId": "9f2c...", "status": "submitted", "duplicate": true }
```

`400` missing/invalid field · `422` payload understood but unusable (unknown
cohort, `credentials` with no credentials) · `404` bad token · `503` deployment
cannot accept partner work.

**Idempotency and identity.** A submission is identified by
`(source, externalCohortId, externalSubmissionId)` — the cohort is part of *who
a submission is*, not just a field it carries. A repeat delivery within one
cohort returns the original assessment with `duplicate: true` and does not
re-judge; later fields in a duplicate are ignored, and the snapshot records what
was actually judged.

The same `externalSubmissionId` arriving under two different cohorts is **two
submissions**, judged and ranked separately. That holds even though your ids are
globally unique today — the Judge does not depend on an assumption it cannot
enforce.

**Cohort isolation.** Group 42 in C13 and Group 42 in C14 are different teams.
Ranking, the private Top 10 and re-judging are all scoped to one Judge cohort,
and a submission can never appear in another cohort's standings.

---

## 3. Read the result

```
GET /api/partner/cohorts/{externalCohortId}/submissions/{externalSubmissionId}/result
```

### Response — `200 OK`

```json
{
  "found": true,
  "externalSubmissionId": "sub_01HQ...",
  "status": "completed",
  "totalScore": 71.5,
  "maxScore": 100,
  "categories": [
    { "key": "problem_clarity",     "title": "Problem and user clarity",   "score": 12, "maxPoints": 15, "reasoning": "…", "confidence": 0.9 },
    { "key": "solution_usefulness", "title": "Solution usefulness",        "score": 11, "maxPoints": 15, "reasoning": "…", "confidence": 0.9 },
    { "key": "core_workflow",       "title": "Working core experience",    "score": 20, "maxPoints": 25, "reasoning": "…", "confidence": 0.8 },
    { "key": "ease_of_use",         "title": "Ease of use",                "score": 7,  "maxPoints": 10, "reasoning": "…", "confidence": 0.9 },
    { "key": "ai_usefulness",       "title": "AI usefulness",              "score": 10, "maxPoints": 15, "reasoning": "…", "confidence": 0.8 },
    { "key": "two_day_execution",   "title": "Two-day execution",          "score": 7,  "maxPoints": 10, "reasoning": "…", "confidence": 0.9 },
    { "key": "deck_demo",           "title": "Demo and deck clarity",      "score": 3,  "maxPoints": 5,  "reasoning": "…", "confidence": 0.7 },
    { "key": "practical_potential", "title": "Practical potential",        "score": 4,  "maxPoints": 5,  "reasoning": "…", "confidence": 0.7 }
  ],
  "manualReview": { "flagged": false, "reasons": [] },
  "disqualified": { "flagged": false, "reason": null },
  "confidence": 0.84,
  "rank": 4,
  "inTopTen": true,
  "rubricVersion": "rubric-v2"
}
```

Before judging finishes, the same shape carries nulls:

```json
{
  "found": true,
  "status": "queued",
  "totalScore": null,
  "maxScore": 100,
  "categories": [
    { "key": "problem_clarity", "title": "Problem and user clarity", "score": null, "maxPoints": 15, "reasoning": "", "confidence": null }
  ],
  "confidence": null,
  "rank": null,
  "inTopTen": false,
  "rubricVersion": "rubric-v2"
}
```

`status` — `queued` · `in_progress` · `completed` · `manual_review` · `failed` ·
`disqualified`. `404` when the cohort/submission pair is unknown — including a
submission that exists in a *different* cohort.

All eight categories are always returned in rubric order, with their real
maximums, even before scoring has run — so you never have to handle a missing
category.

**`null` means not assessed. `0` means assessed and earned nothing.** Until
scoring completes, every `score` is `null`, and so are `totalScore` and
`confidence`. A category that was genuinely judged and scored zero returns `0`
with its reasoning — for example a product with no AI in it. Rendering the two
identically would leave a team unable to tell "we haven't judged you yet" from
"you scored nothing", so the API refuses to conflate them.

### What this endpoint never returns

Credentials, evidence objects, storage paths, screenshots, traces, prompts,
model output beyond the written reasoning, or worker logs. Evidence stays in the
Judge and is viewed there, behind an admin session.

---

## Judging model, in brief

**Rubric v2, 100 points.** Problem and user clarity 15 · Solution usefulness 15
· **Working core experience 25** · Ease of use 10 · AI usefulness 15 · Two-day
execution 10 · Demo and deck clarity 5 · Practical potential 5.

These are beginner builders with two days. Nothing scores framework choice,
architecture, database design, code quality or production hardening. Rough edges
cost a point or two in the category that covers them and nothing anywhere else.
The heaviest category by far is whether `mainUserAction` actually works when a
normal person tries it.

**Evidence order.** The live product is primary. The description, the two
answers, the Loom and the deck are supporting. A claim in a deck never overrides
what the browser observed, and nothing is invented when a link cannot be opened.

**Manual review, not a zero.** When we could not observe fairly — product
unreachable, supplied login rejected, CAPTCHA, deck or Loom unavailable where it
mattered, contradictory evidence, or a malformed AI result — the submission is
flagged for a human. A failure to observe is ours, not the team's.

**Disqualification** is reserved for explicit rule breaches. Bugs, missing
polish, weak UX and failed features affect the score and are never DQ by
themselves.

**Ranking stays here, and stays inside a cohort.** The internal product does not
compute scores or standings; it reads them. Ranking derives from eligible
completed assessments within one Judge cohort, and `inTopTen` is a private
shortlist scoped to that cohort — an input to a human decision. C13 and C14 each
have their own rank 1. No machine declares a winner.
