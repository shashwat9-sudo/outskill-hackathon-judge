# Admin Operating Playbook

For the Outskill internal team. Everything here happens at `/admin` behind the shared account.

**The one rule that shapes everything else:** participants never see judging information. Not scores, not evidence, not ranking, not the shortlist, not feedback — in any cohort status. The platform enforces this structurally, but screenshots and forwarded emails are not something software can stop.

---

## 1. What this platform is for

It replaces three manual processes: the Google Form, external mentor review, and hand-collated scores and shortlists.

It takes a submission, checks it is complete and compliant, analyses the written material and the deck, generates a product-specific test plan, drives the live product in a real browser, scores it against a fixed 100-point rubric with evidence for every number, ranks the eligible submissions, and privately highlights a top 10.

**It does not pick winners.** You do. There is no code path that writes a winner without an admin action.

---

## 2. Creating a cohort

`/admin/cohorts` → *Create a cohort*.

| Field | Notes |
| --- | --- |
| Name | Shown to participants |
| Code | Short and uppercase; appears in every receipt ID (`OSK-AIAP7-042-K3M9QX`) |
| Day 12 start | When the hackathon opens |
| Day 13 deadline | 11:59 PM in the cohort timezone. Server-side and authoritative — a participant's clock is never an input. |
| Timezone | `Asia/Kolkata` by default |
| Shortlist target | 10 by default |
| Submission instructions | Shown on every participant's page |

Approved ideas are copied from your most recent cohort automatically, so a new cohort is usable straight away.

A new cohort starts in **draft**. Participants cannot reach it until you open it.

---

## 3. Configuring ideas

`/admin/cohorts/[id]/ideas`

Ideas belong to the cohort, not the system — editing next cohort's ideas cannot change how a past cohort was judged.

**The field that matters most is *minimum core flow*.** It is what the test planner treats as the bar a working implementation must clear, so vague steps produce vague testing. Write one concrete, observable step per line:

```
Create a trip with a destination and dates
Add an activity to a specific day
Edit or delete an activity
View the full day-wise itinerary
See the itinerary persist after a page reload
```

*Unsafe or prohibited interpretations* constrains what automated testing will do. For the scraper idea, for instance, it is what keeps the judge away from authenticated and private targets.

Deactivating an idea is a soft delete — submissions that already chose it keep resolving it.

---

## 4. Importing teams

`/admin/cohorts/[id]/teams` → *Import teams*.

Upload or paste a CSV with group number, lead name, lead email and lead phone. Column headings are matched flexibly (`Group Number`, `Group`, `group_number` all work).

Rows that cannot be imported are **reported with their row number**, never silently skipped. The two most common causes are a duplicate group number and an email in the group-number column; the message says which.

---

## 5. Distributing invites

Each team gets one invite link. Only the token's hash is stored, so **a link cannot be recovered from the database** — if it is lost, regenerate it.

1. *Download invite CSV* — group number, lead email, invite URL.
2. Send it through your existing channel. **The platform sends no email** (ADR-024), which also removes a whole class of accidental disclosure.
3. Treat that CSV as sensitive. Anyone holding a link can edit that team's submission while the cohort is open.

**Regenerate** issues a new link and kills the old one immediately. **Revoke** kills the link with no replacement.

---

## 6. Opening, pausing and closing

`/admin/cohorts` → *Change status*.

| Status | Participants can | Notes |
| --- | --- | --- |
| draft | nothing | Not yet reachable |
| **open** | view and edit | The only status that accepts changes |
| paused | view only | Temporary hold; drafts are safe |
| closed | view only | Intake is over; judging can start |
| judging | view only | Assessment running |
| finalised | view only | Winners chosen |
| archived | view only | Terminal |

Reopening a closed cohort is allowed and logged. A reopened submission in a closed cohort is still read-only — **both** the cohort and the submission must permit editing.

---

## 7. Starting judging

`/admin/cohorts` → *Start judging*, or `/admin/assessment-queue` → *Queue submissions*.

Queues every finally-submitted entry. Drafts are skipped. **Safe to run more than once** — nothing is duplicated.

Then start the worker:

```bash
npm run worker
```

Scale with `WORKER_CONCURRENCY`. At 500 submissions and an eight-minute budget, concurrency 8 finishes a full cohort in roughly nine hours of browser time — check the projection rather than assuming.

---

## 8. Monitoring the queue

`/admin/assessment-queue`

The number to watch is **Shortlist window**: green means judging is projected to finish before 10:00 AM IST on Day 14; amber means it is not.

If you are behind:
- raise `WORKER_CONCURRENCY` and restart the worker (jobs are leased, so restarting is safe);
- lower the per-submission browser budget in `/admin/settings` — this trades depth for coverage, and shortens evidence rather than skipping submissions;
- start a second worker process. Each claims different jobs; `FOR UPDATE SKIP LOCKED` makes double-processing impossible.

A crashed worker is not a problem. Its leases expire and another worker picks the jobs up.

---

## 9. Reviewing evidence

`/admin/submissions/[id]` — eleven tabs.

The three that carry a decision:

- **Preflight** — every attempt, not just the last. This is where you tell a temporary outage apart from a product that was never there.
- **Browser evidence** — step by step, with console errors, failed requests, accessibility results and screenshots. A run that timed out says so, and its unreached steps show as *skipped*, meaning **unknown**, not *failed*.
- **Scores** — every category with supporting, contradictory and missing evidence, plus a confidence value.

Reading a score: **confidence is about how much the system had to go on, not how good the product is.** A confidently-observed failure is high confidence and a low score. Low confidence means go and look yourself.

---

## 10. Reviewing low-confidence and flagged cases

`/admin/assessment-queue` lists everything needing a human. Four kinds:

| Flag | What it means | What to do |
| --- | --- | --- |
| **unsupported product type** | Native app, extension, CAPTCHA-gated, needs human setup | Assess manually. This is not a worse submission — it is one the tool cannot judge. |
| **low confidence** | A category fell below the threshold | Open the evidence. Usually a timed-out run or an unreadable deck. |
| **prompt injection detected** | Instruction-like content aimed at the judge | It was treated as data and never followed. Decide whether it was deliberate. **Not a disqualification ground on its own.** |
| **proposed disqualification** | An objective requirement appears unmet | Verify it yourself before confirming. |

Record what you concluded. The note is what makes the decision defensible later.

---

## 11. Reviewing the top 10

`/admin/ranking` → *Generate snapshot*.

Snapshots are immutable. Regenerating creates a new one and keeps the old, so the ranking you made a decision against stays reconstructable.

Then **run a second scoring pass** — it covers the top 20, low-confidence cases, open manual reviews, anything within two points of the cutoff, close ties, and disputed scores. Precisely the cases where a disagreement would change an outcome.

Before choosing winners:

1. Open every top-10 submission and read the evidence, not just the score.
2. Request source or builder-history proof from the top 20.
3. Check `reference-materials/historical-ranking-calibration.md` as a sanity check — does this ranking look defensible against what human reviewers have historically valued? It is a **reference for you**, deliberately never fed to the scoring model, so nothing earns points for resembling a past winner.
4. Override anything the evidence does not support. An override needs a reason and preserves the machine's original score, so the disagreement stays visible.
5. Regenerate the snapshot after overriding.

---

## 12. Selecting the final four

`/admin/final-selection`

Choose four submissions, order them, and give each a reason. Every position needs one — that reason is what you will rely on if the outcome is questioned.

The system will not do this for you. `final_selections` has exactly one writer: this page, behind an authenticated admin action.

Nothing is announced. Announcement is a separate, human, out-of-band act.

---

## 13. Exporting reports

- **Invite CSV** — `/admin/cohorts/[id]/teams`
- **Shortlist CSV** — `/admin/ranking`: rank, group, product, score, confidence, flags

Both are internal. The shortlist export in particular must not reach a participant.

---

## 14. Disqualification and restoration

Permitted **only** for: late submission with no exception, an idea outside the approved list, a missing product URL, a missing PDF deck, a missing demo link, an artifact still unreachable after retries and grace, login required with no working credentials, malicious or prohibited content, interference with judging, a confirmed false declaration, or a confirmed serious rule violation.

**Never** for: weak UI, a low score, a secondary feature failing, a missing optional feature, low commercial potential, ordinary bugs, a temporary external outage, or AI suspicion without human confirmation. The database will not store these as reasons — the constraint exists so the rule cannot be bent under time pressure.

Flow: the system **proposes**, you **confirm**, and confirmation is **reversible**. Every step is logged.

Reversing needs a reason. Regenerate the ranking afterwards to bring the team back in.

---

## 15. Rotating the shared password

`/admin/settings`

Requires the current password. Changing the password **revokes every session, including yours** — that is the point.

Rotate when: someone leaves the team, the credential may have been shared, or on a routine schedule between cohorts.

---

## 16. Security and privacy

**What the platform guarantees**
- Participants cannot reach judging data. The participant data layer has no method that can read it, and RLS grants no policy on those tables.
- Demo credentials are AES-256-GCM encrypted, masked in the UI, revealed only by an audited action, and **never sent to an AI provider**.
- PII is redacted before any model call; submissions are identified to a provider by an anonymised ID only.
- The worker cannot reach private networks: URLs are validated against resolved addresses, re-checked immediately before each navigation.
- Prompt injection cannot alter behaviour, because behaviour is driven by schema-validated structure and a closed action set, not by prose.

**What it does not**
- **Shared admin cannot identify who did something.** The log proves *what* and *when*, never *who*. If two people hold the credential, both are `shared-admin`. Rotation on team change is the compensating control.
- It does not defend against a malicious admin. Shared admin is fully trusted.
- It does not verify work was built during the hackathon. Source proof is evidence for your judgement, not proof.

**Your responsibilities**
- Treat invite CSVs and shortlist exports as sensitive.
- Do not screenshot ranking or scores into a shared channel.
- Reveal credentials only when you need them; every reveal is logged.
- Rotate the password on team change.

---

## 17. Day 13 midnight → Day 14 10:00 AM

The ten hours that matter. Times are IST.

### 11:59 PM — deadline
- [ ] Confirm the deadline has passed on the cohort record, not on a wall clock.
- [ ] Set the cohort to **closed**. Intake stops.
- [ ] Note any teams that contacted you about a genuine problem — decide on late exceptions now, not at 6 AM.

### 12:00 AM — start judging
- [ ] `/admin/cohorts` → **Start judging**.
- [ ] Start the worker. Confirm jobs are moving out of `queued` within two minutes.
- [ ] Check the **Shortlist window** panel. If it is already amber, raise concurrency now — the cost of doing it later compounds.

### 12:30 AM — first checkpoint
- [ ] Are jobs completing, or piling up at one stage?
- [ ] Spot-check one completed submission end to end. Does the evidence look like a real run?
- [ ] Sanity-check the projected finish time.

### 2:00 AM – 5:00 AM — monitored run
- [ ] Check the queue hourly.
- [ ] Triage manual-review flags as they appear rather than in one batch at the end.
- [ ] Grant or refuse late exceptions; each needs a recorded reason.

### 6:00 AM — assessment should be complete
- [ ] Confirm nothing is stuck. Reclaim leases if a worker died.
- [ ] Re-queue anything that failed for a transient reason.
- [ ] Clear every open manual-review flag.
- [ ] Review proposed disqualifications. Confirm or dismiss each, with evidence.

### 7:00 AM — ranking
- [ ] Generate a ranking snapshot.
- [ ] Run the second scoring pass.
- [ ] Regenerate the snapshot once the second pass completes.

### 7:30 AM – 9:00 AM — human review
- [ ] Read the evidence for all top 10 — the evidence, not the scores.
- [ ] Request source proof from the top 20.
- [ ] Override anything the evidence does not support, with reasons.
- [ ] Regenerate the snapshot after overrides.
- [ ] Sanity-check against the historical calibration file.

### 9:00 AM – 9:45 AM — final four
- [ ] Choose four, order them, give each a reason.
- [ ] Export the shortlist CSV.
- [ ] Set the cohort to **finalised**.

### 10:00 AM — shortlist due
- [ ] Private top 10 ready. ✅
- [ ] Final four recorded with reasons. ✅
- [ ] Nothing announced. Announcement is separate and human.

### After
- [ ] Confirm no participant-facing surface changed. It should not have.
- [ ] Credentials are destroyed at finalisation — verify.
- [ ] Note what was slow or wrong for the next cohort.

---

## 18. When something goes wrong

| Symptom | Likely cause | Do this |
| --- | --- | --- |
| Jobs stuck in one stage | Worker crashed mid-stage | Leases expire and jobs are reclaimed. Check worker logs; restart it. |
| Everything failing preflight | Network egress blocked, or DNS broken | Check the worker host can reach the public internet. |
| A team says their link does not work | Revoked or regenerated | Regenerate and resend. |
| A team says they cannot edit | Cohort not open, or submission locked | Check both. Reopen the submission if warranted. |
| Ranking looks wrong | Snapshot predates your overrides | Regenerate the snapshot. |
| Product was up but preflight says down | Outage during the window | Check preflight attempts; re-queue. Never disqualify for this. |
| A score has no evidence | Scoring degraded | Re-run assessment for that submission, then review by hand. |
