# Google Sheets → Judge

## The flow

```
Outskill Hackathon Product → Google Sheet → Judge Intake (Dry Run / Sync)
  → Supabase queue → Railway worker → AI + Playwright + evidence
  → rubric-v2 scores → cohort ranking → private Top 10 → Judge Admin
```

The Hackathon product is the only learner-facing frontend. The Judge is a
private backend: it reads the sheet, judges the products, and keeps the scores.
Google Sheets is **input only** — nothing is ever written back.

---

## The service account

**`outskill-hackathon-judge@outskill-hackathon-judge.iam.gserviceaccount.com`**

- Needs **Viewer** on the submissions spreadsheet. Nothing more — v1 never writes.
- Needs the **Google Sheets API** enabled on its project.
- Scope: **`https://www.googleapis.com/auth/spreadsheets.readonly`** only. Not
  Drive: a Drive scope would grant reach over every file the account can see,
  and this account needs exactly one spreadsheet.

The diagnostic warns loudly if the credential authenticates as any other
principal — reading with a credential nobody reviewed is not "close enough".

### The key never lives in this repository

No JSON file, no PEM, nothing committed. It is a server environment variable on
the Judge (Vercel) side only. **Railway does not need it** — the worker judges
products and never reads the sheet. It is never bundled for a browser (the
client barrel does not export the Google module), never logged, and never echoed
into an error: signing failures are replaced with a message saying what to check.

Most platforms store PEMs with escaped `\n`. That is normalised at the point of
use, along with stray surrounding quotes, because a PEM with wrong line breaks
fails to sign with an error that explains nothing.

---

## Environment variables

| Variable | Example | Secret |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `outskill-hackathon-judge@…iam.gserviceaccount.com` | no |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----\n…` | **yes** |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | `1AbC…` (from the sheet URL) | no |
| `GOOGLE_SHEETS_TAB_NAME` | `Submissions - AIAP C13` | no |
| `GOOGLE_SHEETS_EXTERNAL_COHORT_ID` | `AIAP-C13` | no |
| `GOOGLE_SHEETS_COHORT_NAME` | `AI Accelerator Cohort 13` | no |

Placeholders are in `.env.example`.

---

## The sheet

Exact headers, in the order the Hackathon product writes them:

```
Timestamp | Group Number | Category | Product Name | Team Leader | Team Members |
Primary Contact | MVP/Product Link | Access | Login Email | Login Password |
Brief Description | Main User Action | How AI Helps | What We Got Working |
Loom Video Link | Final Deck Link
```

A small set of **aliases** is accepted for reworded columns (`Group` for `Group
Number`, `Product URL` for `MVP/Product Link`, and similar). The headers above
stay canonical; anything not recognised fails closed rather than being guessed
at, because mapping an ambiguous column is how a product URL ends up judged as
a Loom link.

**Columns are matched by name, never by position.** Reordering, re-casing or
re-spacing them changes nothing. A *missing* required column fails the whole
sheet rather than shifting values into the wrong fields.

Required for judging: Group Number, Category, Product Name, MVP/Product Link,
Access, Brief Description, Main User Action, How AI Helps, What We Got Working.
Loom and deck are supporting evidence — their absence is a scoring outcome, not
an intake failure.

### The three learner questions

| Question | Feeds |
|---|---|
| **Main User Action** — *"What is the ONE main thing a user should be able to do successfully in your product?"* | **Playwright test-plan generation.** The browser tries exactly this, as a normal user would. |
| **How AI Helps** — *"How does AI help the user or make the product more useful?"* | AI Usefulness (15). No technical explanation expected. |
| **What We Got Working** — *"What did your team manage to get working in these two days?"* | Two-Day Execution (10). **Context, not proof** — where it disagrees with the browser run, the browser wins. |

### Mapping

| Sheet column | Judge field |
|---|---|
| Group Number | `groupNumber` |
| Category | approved idea (`ideaSlug`) |
| Product Name | `productName` |
| Brief Description | `briefDescription` |
| Main User Action | `mainUserAction` |
| How AI Helps | `aiValue` |
| What We Got Working | `whatGotWorking` |
| MVP/Product Link | `productUrl` |
| Access | `accessMode` |
| Login Email / Password | encrypted credentials |
| Loom Video Link | `loomUrl` |
| Final Deck Link | `deckUrl` |
| Timestamp | `submittedAt` (audit) |

**Team Leader, Team Members and Primary Contact are read past and never mapped.**
A submission is `Group 12` inside the Judge. None of that reaches an AI provider,
a snapshot, a log or a report.

### Access

`Open Access` → no credentials; anything typed in the login cells is **dropped**
rather than stored. `Specific Login` → both Login Email and Login Password
required, encrypted with the existing credential envelope, decrypted only at the
moment the browser signs in.

Casing and spacing are normalised (`open access`, `OPEN ACCESS`, `Public`).
Anything genuinely unrecognised **fails the row** — guessing sends a browser at a
login wall with no credentials, or skips a login the team meant, and both end
with a working product scored as broken.

**The password appears in exactly one place: encrypted storage.** Never in the
snapshot, validation messages, sync report, logs, audit text or API results.

---

## Cohort configuration

The sheet has **no cohort column**, and learners are never asked for one. One
configured spreadsheet/tab maps server-side to one `externalCohortId`.

```
GOOGLE_SHEETS_EXTERNAL_COHORT_ID=AIAP-C13
         ↓  (POST /api/partner/cohorts, once)
AIAP-C13 → Judge cohort UUID 6ed7884e-…   — permanent
```

Sync calls the trusted partner cohort-sync path itself, so **Ops never recreates
cohorts by hand**. It is idempotent: re-running refreshes the name and dates and
never re-points the identifier at a different UUID, which would strand
already-judged submissions and move teams between rankings.

A missing or mistyped `GOOGLE_SHEETS_EXTERNAL_COHORT_ID` **fails loudly** and
ingests nothing.

Ranking and the private Top 10 are scoped to one Judge cohort. C13 and C14 each
have their own rank 1, and Group 42 exists in both as two different teams.

---

## Submission identity

```
source               = outskill-google-sheets
externalCohortId     = AIAP-C13          (configured)
externalSubmissionId = group-12          (derived from Group Number)
```

Never the row number, the row position or the Timestamp. Sheets get sorted and
have rows inserted above others; identity based on position would make every one
of those look like a new submission and judge the same product again.

### A group that submitted twice

Resubmitting is ordinary — a team notices a broken link before the deadline and
sends the form again — so **the latest valid response wins** and earlier ones are
recorded as superseded. One submission and one judging job per group, however
many times they submitted.

Ordering is by the Google Form **Timestamp**. If a timestamp is missing or
unreadable, sheet position decides instead (Forms appends, so a later row is a
later submission); a row with a readable timestamp is always preferred over one
without. Nothing is ever invented — a fabricated date would silently decide
which of a team's submissions gets judged.

**A newer broken response never discards an older working one.** If the most
recent row fails validation, the last valid row is imported and Preview says
why the newer one was not used — otherwise a team would be marked on a
submission they had already replaced, with nothing explaining it.

The same group number under a *different* cohort is valid and isolated.

---

## Running it

**Judge Admin → Google Sheet intake** (`/admin/intake`). Three steps, in order:

1. **Test connection** — confirms we can open the sheet, that it is the expected
   service account, and that the required columns are present. Changes nothing.
2. **Check the sheet** — the dry run. Shows counts and a per-group table saying
   what would be imported and what needs fixing. Writes nothing.
3. **Import final submissions** — needs a check first, then a confirmation
   naming the cohort and the exact number. Queues judging jobs.

The API route `POST /api/admin/intake/sheet` does the same thing for scripting;
both require an admin session.

### If the sheet changes between checking and importing

Each check produces a fingerprint of what an import would act on. Import
re-reads the sheet and compares — a mismatch refuses the import and asks for
another check, so the numbers on screen always describe what actually happens.
Cosmetic edits (a team member's name, a reordered column) do not invalidate a
check; a changed product URL or main user action does.

### A group that changed after it was imported

Reported as **"Already imported, but the Sheet has changed since"** and *not*
re-imported. Replacing an assessment because somebody edited a cell afterwards
changes a team's score, so it is a human decision, not a side effect of pressing
import again.

### Dry Run — `{ "mode": "dryRun" }`

Authenticates, reads the sheet, validates headers, normalises and validates every
row, detects duplicate groups, and reports counts and errors.

**Writes nothing.** No cohort, no submission, no job, no AI call, no Railway
call. Dry Run and Sync walk the same code to the same point — only the last step
differs — so what Dry Run reports is what Sync will do.

### Sync — `{ "mode": "sync" }`

Syncs the cohort, then ingests every valid unique row through the existing
partner ingest path, queuing one judging job each. Submissions appear in Judge
Admin through the ordinary model: no second import, no access codes.

**Safe to re-run.** Already-ingested rows count as `alreadyIngested` and queue
nothing.

### The report

`spreadsheetId` (masked) · `tabName` · `externalCohortId` · `judgeCohortId` ·
`rowsRead` · `blankRowsIgnored` · `validRows` · `invalidRows` ·
`duplicateGroups` · `newSubmissions` · `alreadyIngested` · `jobsQueued` ·
`errors[{row, groupNumber, field, reason}]`

Safe to paste into a chat: no password, no learner contact data, no key.

### CSV fallback

Send `{ "csv": "<contents>" }` with the **same headers**. Emergency use — Google
Sheets is the production intake. Both paths share one parser, validator and
ingest, so the fallback cannot behave differently on the day you need it.

---

## Verifying connectivity

```bash
node scripts/check-google-sheet.mjs
```

Reports the authenticated account (warning if unexpected), masked spreadsheet
id, tab, **header names**, data row count, and whether required headers are
present. Prints no cell values and never the key.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401` | Key rotated, revoked or malformed | Re-issue the key; check the PEM is complete including BEGIN/END |
| `403` | Sheet not shared | Share it with the service account as **Viewer**; confirm the Sheets API is enabled |
| `404` | Wrong spreadsheet id | Check `GOOGLE_SHEETS_SPREADSHEET_ID` against the sheet URL |
| `No tab named …` | Wrong tab | Check `GOOGLE_SHEETS_TAB_NAME` (often `Form Responses 1`) |
| `missing required column` | Header renamed or removed | Restore the header; casing and spacing do not matter |
| `429` | Rate limited | Wait and re-run; Sync is idempotent |
| `No external cohort is configured` | Env not set | Set `GOOGLE_SHEETS_EXTERNAL_COHORT_ID` |

**A Google failure creates no partial work.** Nothing is written until the sheet
has been read in full, so a failure halfway cannot leave a cohort half-judged.

### Rotating the key

Create a new key in Google Cloud → update `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
on Vercel → run the diagnostic → delete the old key. No code change, no redeploy
of the worker, and never paste the key into a ticket or a chat.

---

## What stays in the Judge

Scores, reasoning, confidence, evidence, manual review, DQ, ranking and the
private Top 10. Google Sheets is input only in v1: the service account has
Viewer permission, no learner row is modified, and no score column is added.
Write-back would need an explicit decision and a permission change.

Humans select the winners. The private Top 10 is an input to that decision.
