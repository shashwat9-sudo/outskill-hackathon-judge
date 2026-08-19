# Judge API — for the Outskill Hackathon product

The Judge is a private backend. It has no learner-facing UI in the new design:
the Hackathon product owns the form, the identifiers and the relationship, and
calls these two endpoints.

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

## 1. Submit a product for judging

```
POST /api/partner/submissions
Content-Type: application/json
```

### Request

```json
{
  "externalCohortId": "HACK14",
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
| `externalCohortId` | yes | Your cohort id, or the Judge cohort code. Must already exist in the Judge. |
| `externalSubmissionId` | yes | **Immutable, and the idempotency key.** |
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

**Idempotency.** Keyed on `externalSubmissionId`. A repeat returns the original
assessment and does not re-judge. Later fields in a duplicate delivery are
ignored — the first delivery is what was judged, and the snapshot records it.

---

## 2. Read the result

```
GET /api/partner/submissions/{externalSubmissionId}/result
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

`status` — `queued` · `in_progress` · `completed` · `manual_review` · `failed` ·
`disqualified`. `404` when the id is unknown.

All eight categories are always returned in rubric order, with their real
maximums, even before scoring has run — so you never have to handle a missing
category. Before scoring, `totalScore` is `null` and `confidence` is `null`;
they are not zero, because zero would read as *"assessed badly"* rather than
*"not assessed yet"*.

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

**Ranking stays here.** The Hackathon product does not compute scores or
standings; it reads them. Ranking derives from eligible completed assessments,
and `inTopTen` is a private shortlist — an input to a human decision. No machine
declares a winner.
