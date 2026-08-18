# Synthetic test-data cleanup manifest

**Nothing has been deleted.** This is a read-only account of what the acceptance
run created, what the existing Danger Zone would do with it, and what it would
refuse. Regenerate with `npx tsx scripts/cleanup-manifest.ts` — that script has
no delete path in it.

Final removal needs separate explicit approval.

---

## What exists

One cohort: **PRODUCTION TEST — DELETE LATER** `[AIAP C13]`, status `open`.

| Holds | Count |
| --- | --- |
| Teams | 3 (groups 901, 902, 999) |
| Team members | 5 |
| Submissions | 3 — one **final-submitted and locked** (901), two drafts |
| Uploaded artifacts | 2 (one deck, one demo-video link) |
| Access-code records | 28 |
| Participant sessions | 159 |
| Audit entries | 18 |
| **Storage objects** | **1** — the group 901 pitch deck |

All of it is synthetic. Group 901's content is invented, its "learners" use the
reserved `.test` TLD, and the deck is a document supplied for the acceptance run.
No real learner has ever used this cohort.

## What the Danger Zone would do

**It refuses.** Verdict: `ARCHIVE_INSTEAD`, for four reasons:

- 1 final submission — completed work
- 3 submissions including drafts — work in progress, not scratch data
- 2 uploaded files
- 159 participant sessions — a team has signed in

This is the intended behaviour and it is correct: the check cannot tell
"synthetic acceptance data" from "a real cohort someone is about to delete by
mistake", and it is designed to assume the second. **Archive** works today and
preserves everything.

If deletion were forced past those blockers it would remove teams, members,
access codes, submissions, artifact rows and sessions, and would **preserve** the
18 audit entries — deliberately, since `audit_logs.cohort_id` is not a foreign
key (migration 0005).

## What no database delete touches

**The Storage object.** The group 901 deck lives in the private
`submission-decks` bucket. Deleting the artifact row removes the *record* of it
and leaves the file. Nothing in the current codebase removes bucket objects when
a cohort is deleted.

That is worth knowing before any purge: a database-only cleanup leaves a real
PDF in Storage with nothing pointing at it, which is harder to find later than
it is to remove now.

## Is a dedicated purge tool needed?

**Yes, if you want this cohort gone rather than archived.** Three things the
current path cannot do:

1. Get past the blockers, which exist to stop exactly this operation
2. Remove the Storage object alongside the rows
3. Prove in advance what it would touch

Requirements if it is built:

- **Dry-run by default.** Printing the manifest must be the default action and
  deleting must be the explicit one.
- **Refuses a real cohort.** It must require the cohort to be named exactly, and
  should refuse any cohort not explicitly marked synthetic — a flag that does
  not exist today and would need a migration.
- **Removes Storage objects** in the same operation, and reports each one.
- **Keeps the audit trail.** A purge is itself an event worth recording.
- **Never touches another cohort**, and says so by listing what it skipped.

## Could real learner data be affected?

**No.** There is one cohort in this project and it has never been used by a real
learner. There is no production cohort to confuse it with.

That will not be true after the first real cohort runs, which is the strongest
argument for building the purge tool with an explicit synthetic marker *before*
then, rather than relying on someone typing the right name at the right moment.

## Recommendation

**Archive now, decide on deletion later.** Archiving is available today, removes
the cohort from operational views, keeps every record, and is reversible. The
acceptance evidence — including a real final submission and a real receipt —
stays available while the product is still being reviewed.

Deleting it needs a tool that does not exist yet. Building that tool is a
reasonable next step; doing it by hand with raw SQL is not.
