# Admin Operations

How the Outskill team runs a cohort, in the order it happens.

This is the *interface* guide — what each screen is for and what each control does. The hour-by-hour operational guide, including the Day 13 → Day 14 checklist, is in [ADMIN_PLAYBOOK.md](ADMIN_PLAYBOOK.md).

---

## 1. Navigation

A left sidebar on desktop, a drawer on mobile and tablet. Labels are written for programme operators; the underlying routes are unchanged.

| Label | Route | What it is for |
| --- | --- | --- |
| **Overview** | `/admin` | What stage, what is done, what needs attention, what to do next |
| **Cohorts** | `/admin/cohorts` | Create cohorts, change lifecycle status, reach every cohort surface |
| **Submissions** | `/admin/submissions` | Every submission in the active cohort |
| **Judging** | `/admin/assessment-queue` | Automated assessment progress and cases needing a human |
| **Shortlist** | `/admin/ranking` | The private top 10 and the full eligible ranking |
| **Finalists** | `/admin/final-selection` | Choose and record the final four |
| **Resources** | `/admin/resources` | Downloads for participants and for the team |
| **Settings** | `/admin/settings` | Access, judging configuration, retention, diagnostics |

The sidebar always shows the active cohort and its status, so no screen is ambiguous about which cohort you are looking at.

**First sign-in** shows a dismissible onboarding panel with the six-step sequence and three shortcuts: Start setup, Preview learner journey, Open admin playbook. Dismissal is remembered locally and never nags again.

---

## 2. The setup sequence

The Overview page carries a **Run this cohort** checklist. Exactly one item is marked *Do this next*; everything before it is complete and everything after is blocked.

| # | Step | Done when |
| --- | --- | --- |
| 1 | Configure cohort | Name, code, timezone and the Day 12 → Day 13 schedule exist |
| 2 | Review approved ideas | At least one idea is configured for the cohort |
| 3 | Import teams and generate invite links | At least one team is imported |
| 4 | Open submissions | The cohort has reached `open` |
| 5 | Close submissions and start judging | Assessment has begun |
| 6 | Review the top 10 | A shortlist snapshot exists |
| 7 | Select four finalists | Exactly four are recorded |

Each row has one relevant action, so there is never a question about where to go next.

### Creating a cohort

**Cohorts → Create cohort** opens a guided three-step drawer rather than a permanent form:

1. **Basics** — name, code, description, timezone
2. **Schedule** — Day 12 start, Day 13 deadline, shortlist target, submission instructions
3. **Review** — a summary, plus what the cohort inherits: approved ideas copied from the most recent cohort, rubric version frozen to this cohort, and a `draft` starting status

Nothing is saved until the final step.

### Ideas

Per cohort, never global — editing next cohort's ideas cannot change how a past cohort was judged.

The field that matters most is **minimum core flow**: one concrete, observable step per line. It is what the test planner treats as the bar a working implementation must clear, so vague steps produce vague testing. **Unsafe or prohibited interpretations** constrains what automated testing will do with the idea.

Deactivating an idea is a soft delete — submissions that already chose it keep resolving it.

### Teams and invites

Import a CSV with group number, lead name, lead email and lead phone. Column headings are matched by alias, and rows that cannot be imported are **reported with their row number** rather than silently skipped.

Then download the invite CSV and distribute it through your own channel. Only the token hash is stored, so a lost link is regenerated, never recovered. **Regenerate** issues a new link and kills the old one immediately; **Revoke** kills it with no replacement.

---

## 3. Lifecycle

Every status change states its effect on participants *before* it happens, and the consequential ones ask for confirmation.

| Action | What it means to a team |
| --- | --- |
| **Open submissions** | Teams with valid invite links can edit and submit. |
| **Pause submissions** | Learners can view their entries but cannot edit or submit. |
| **Close submissions** | No further participant changes. Judging can begin. |
| **Start judging** | Final submissions are queued for assessment. |
| **Finalise cohort** | Marks judging complete. Demo credentials are destroyed under the retention policy. |
| **Archive cohort** | Read-only forever. This cannot be undone. |

Confirmation is required for closing, starting judging, finalising and archiving. Closing is not a technical state change to the person pressing it — it is the moment several hundred teams lose the ability to edit.

---

## 4. Judging progress

`/admin/assessment-queue`, titled **Judging progress**.

> Track automated product testing, evidence review and cases that need human attention.

A visual pipeline shows how many submissions sit at each phase:

```
Submitted → Pre-flight → Artifact review → Test plan → Browser testing → Scoring → Completed
```

Four figures sit below it:

- **Currently processing** — held by a worker right now
- **Average per submission** — queued to completed, across all stages
- **Estimated finish** — projected, at the configured concurrency
- **Needs human review** — open flags plus failures

The most important line is the **Shortlist window** banner: green means judging is projected to finish before the Day 14 deadline, amber means it is not.

### Average duration vs the browser-testing limit

These measure different things, and the page says so:

- **Average per submission** covers the *whole pipeline* — pre-flight retries, artifact analysis, test planning, browser testing and scoring.
- **Maximum browser-testing time** (default 8 minutes) applies only to the *browser-testing stage*.

The average is therefore expected to exceed the limit. Both are shown with their scope stated, so the two numbers never look contradictory.

### Needs attention

Comes before any technical detail. Four kinds:

| Flag | Meaning | What to do |
| --- | --- | --- |
| **Unsupported product type** | Native app, extension, CAPTCHA-gated, needs human setup | Assess by hand. Not a worse submission — one the tool cannot judge. |
| **Low confidence** | A category fell below the threshold | Open the evidence. Usually a timed-out run or an unreadable deck. |
| **Prompt injection detected** | Instruction-like content aimed at the judge | It was treated as data and never followed. **Not a disqualification ground.** |
| **Assessment failed** | The product could not be assessed | Check the pre-flight attempts first — an outage is not a failed product. |

Usage figures — browser minutes, AI calls, token estimates, concurrency, retry limits — live in a collapsed **Usage and system details** panel. Available, not in the way. Token counts are raw numbers; pricing is applied wherever Outskill tracks cost.

---

## 5. Reviewing a submission

`/admin/submissions/[id]` has eleven tabs. Three carry a decision:

- **Preflight** — every attempt, not just the last. This is where a temporary outage is told apart from a product that was never there.
- **Browser evidence** — step by step, with console errors, failed requests, accessibility results and screenshots. A run that timed out says so, and its unreached steps show as *skipped*, meaning **unknown**, not *failed*.
- **Scores** — each category with supporting, contradictory and missing evidence, plus confidence.

**Reading confidence:** it measures how much the system had to go on, not how good the product is. A confidently-observed failure is high confidence and a low score. Low confidence means go and look yourself.

**Overriding a score** requires a reason, and preserves the machine's original value alongside yours — so the disagreement stays visible and measurable.

**Credentials** are masked until an explicit reveal, and every reveal is audit-logged. They belong to a third party; the bar for showing them is deliberately high.

---

## 6. The private shortlist

`/admin/ranking`, titled **Private shortlist** and labelled *Private — never visible to participants*.

The top entries are the working surface: rank, product, group, total score, confidence, unresolved flags, and a four-category breakdown so a rank is never just a number. Each has a **Review evidence** link.

The full eligible ranking sits below in a collapsed panel — available, visually secondary.

Two actions:

- **Generate a shortlist** — ranks every eligible submission. Snapshots are immutable; regenerating creates a new one and keeps the old, so the shortlist a decision was made against stays reconstructable.
- **Run second pass** — the consistency review, which covers only the cases where a disagreement would change an outcome: the top 20, low-confidence cases, open manual reviews, anything within two points of the cutoff, close ties and disputed scores.

There is no winner language on this page. Winners are chosen elsewhere, by a person.

Before choosing finalists: read the evidence for the top 10 rather than the scores, request source or builder-history proof from the top 20, sanity-check against `reference-materials/historical-ranking-calibration.md` (a human reference, deliberately never fed to the scoring model), override anything the evidence does not support, and regenerate.

---

## 7. Selecting the final four

`/admin/final-selection`, titled **Select the final four**.

> The automated judge provides evidence and a private shortlist. The Outskill team makes the final decision.

Four numbered slots, **empty until a person fills them**. Nothing pre-populates them. Each needs a submission and an internal note explaining why — that note is what you will rely on if the outcome is questioned. A partial selection is refused, and confirming asks first.

Below the slots, the shortlist is repeated for reference with a **View evidence** link per row.

`final_selections` has exactly one writer in the entire codebase: this page, behind an authenticated admin action. No worker, job stage or model response can reach it (ADR-018). Nothing is announced — announcement is a separate, human, out-of-band act.

---

## 8. Resources

Cards, not implementation detail. Each shows a title, a one-line purpose, file type, size, an audience label and a download or open action.

**Participant resources** — pitch-deck template, submission instructions, approved product-idea guide, product-building workbook.

**Admin resources** — admin operating playbook, internal product demo deck, deployment runbook, Day 13 → Day 14 checklist, scoring-rubric guide.

The two audiences use two different endpoints: participant resources go through `/api/resources/[id]` and require the record to be marked participant-visible; internal ones go through `/api/admin/resources/[id]` and require an admin session. There is no branch where a participant request could fall through to an internal document.

Storage bucket names and private paths are **not** here. They live under Settings → System diagnostics → Storage diagnostics.

---

## 9. Settings

Five separated areas:

1. **Admin access** — rotate the shared credential. Requires the current password, and changing it revokes every session including your own. The page states plainly that a shared account cannot attribute an action to a person.

2. **Judging configuration** — in the units an operator thinks in:

   | Control | Default |
   | --- | --- |
   | Concurrent assessments | 4 |
   | Maximum browser-testing time | 8 minutes |
   | Maximum retries | 3 |
   | Low-confidence threshold | 0.6 |
   | Top shortlist size | 10 |

   Minutes are converted to milliseconds on save, so nobody types `480000`. A warning notes that changing these mid-cohort means teams are not all judged under the same conditions.

3. **Retention and privacy** — what is kept and for how long, and that automatic deletion is disabled outside production and in demo mode.

4. **Advanced system settings** *(collapsed)* — the raw stored values, including keys like `worker.browserBudgetMs`, with a warning that editing them bypasses the friendly controls.

5. **System diagnostics** *(collapsed)* — runtime configuration, versions pinned to the cohort, and storage diagnostics showing every bucket, what it holds, and whether it is participant-reachable.

---

## 10. What the system will not do

Worth restating, because the interface is built around it:

- It will not pick winners. It ranks and shortlists; a person chooses four.
- It will not disqualify anyone. It proposes, on eleven permitted grounds only; a person confirms, and confirmation is reversible.
- It will not announce anything.
- It will not penalise a product it cannot test. Unsupported products are routed to a human.
- It will not treat an outage as a failure. Retries are recorded and classified.
- It will not act on a prompt-injection attempt, and will not penalise a team for one being detected.
