# Learner Journey

Everything a participating team experiences, from receiving a link to holding a receipt.

**The rule that shapes all of it:** a learner never sees judging information. Not a score, not a rank, not evidence, not the shortlist, not feedback — in any cohort status.

---

## 1. The invite

There is no account, no password and no signup. A team's access **is** a private link:

```
https://<app>/submit/<token>
```

- 256 bits of random entropy per token.
- Only the SHA-256 hash is stored, so a database read yields nothing usable and a lost link **cannot be recovered** — it is regenerated instead.
- Comparison is constant-time.
- Unknown, revoked and expired tokens all return an identical 404, so the page cannot be used to probe whether a token exists.

Outskill imports teams by CSV, downloads an invite CSV (group number, lead email, invite URL) and distributes it through its own channel. **The platform sends no email** (ADR-024).

---

## 2. What the learner sees

### The shell

Every learner page carries: the Outskill wordmark, the cohort name, their group number, and their submission status (Draft or Submitted).

### The page

> **Submit your hackathon product**
> Complete the six steps below. Your progress is saved automatically until you make your final submission.

Then a deadline panel with three facts side by side:

| | |
| --- | --- |
| **Official deadline** | The cohort deadline in the cohort's timezone, labelled with the offset |
| **Your local time** | The same instant in the viewer's own timezone, resolved client-side after mount |
| **Time remaining** | A live-ish countdown, or a clear "The deadline has passed" |

Showing both timezones is deliberate. A team in a different zone should never have to do the arithmetic on the night.

---

## 3. The six steps

Desktop gets a persistent left-hand progress panel and a main form column; mobile gets the same stepper wrapped horizontally above a single column, with a sticky action bar. There is **one** stepper component in the DOM, responsive rather than duplicated.

Each step opens with a one-sentence explanation of what it is for.

| # | Step | Explanation shown to the learner |
| --- | --- | --- |
| 1 | **Team** | Confirm the people who actively built this submission. |
| 2 | **Product idea** | Select the approved challenge and describe the problem and product promise. |
| 3 | **Live product** | Tell the automated judge how to safely access and test your core workflow. |
| 4 | **Demo and deck** | Upload the final pitch deck and link the short product walkthrough. |
| 5 | **Learning evidence** | Show how your team scoped, tested and improved the product during the hackathon. |
| 6 | **Review and submit** | Check everything, agree to the declarations, then make your final submission. |

### Step 1 — Team

Group number, team lead name, email and phone, then a repeating row per active member with their contribution. Phone accepts any sensible format — the rule is about content (7–15 digits, no letters), not separators, because rejecting `(044) 2345-6789` just makes people retype a correct number.

### Step 2 — Product idea

The approved ideas are **selectable cards**, not a dropdown. Each card shows the title, description and typical use case; selecting one expands it to show the minimum core flow — the bar a working implementation must clear. That flow is what the judge later tests against, so showing it here is the honest thing to do.

Then: product name, primary user, exact problem, one-sentence promise, description, why AI is necessary, differentiation, the single must-have workflow, up to two should-haves, and what was deliberately excluded.

### Step 3 — Live product

Four clearly separated sections:

1. **Product URL** — HTTPS, browser-reachable. Not a Drive folder, not a video link.
2. **Login information** — a checkbox; if login is required, demo credentials become required. Password fields are masked. The panel states plainly that credentials are encrypted before storage, masked in the dashboard, and never sent to an AI model.
3. **Core test scenario** — repeating step/expected-result rows, at least two.
4. **Test data, cleanup and known limitations** — safe sample inputs, how to remove what the judge creates, and what does not work yet.

### Step 4 — Demo and deck

A drag-target upload zone for the PDF deck. Once uploaded it shows the filename, size and a **Replace file** control. Validation is on extension, MIME type, size **and magic bytes** — a client-supplied content type is a claim, not evidence.

Then the demo video link, a required ≤3-minute confirmation, and direct downloads for the pitch-deck template and the submission instructions.

### Step 5 — Learning evidence

Structured cards rather than a wall of textareas: three bugs (what broke / how it was fixed), the deliberately excluded feature, the major trade-off, Day 12 → Day 13 progress, the most important learning, the next seven-day plan, and the stack used.

This maps one-to-one onto the bug log and reflection in the workbook, so it asks for work the team has already done.

### Step 6 — Review and submit

- **Missing fields are grouped at the top**, by section, each with an **Edit section** link.
- Below that, every section is listed with its state and its outstanding issues.
- Then the seven declarations, all required.
- Then the final-submission panel, which states plainly that submitting locks the entry.
- The final CTA unlocks only when everything is complete **and** the learner types `FINAL SUBMIT` exactly.

---

## 4. Draft, autosave and locking

**Autosave** runs on a 1.2-second debounce after any change. The status line reads:

- `Your work saves automatically` — idle
- `Saving…`
- `✓ Saved just now`
- `Could not save — <reason>. Retry` — with a working retry button

**Save draft** flushes immediately. **Save and continue** flushes, then advances.

A team may edit freely while **both** the cohort is open **and** their submission is in an editable state. A reopened submission in a closed cohort stays read-only — both conditions, always.

**Final Submit** is validated again on the server, regardless of what the client believed. It stamps `submitted_at`, issues a receipt ID and locks learner editing.

---

## 5. The receipt

Once locked, the route renders a completely different page. There is no form, and no stepper in the DOM.

> **Submission received**

It shows the team, the product, the submission time in the cohort timezone, and the receipt ID (`OSK-AIAPD1-012-K3M9QX`) — readable aloud, with `I`, `L`, `O` and `U` excluded from the random tail because people misread them.

Then **what happens next**, in three plain steps, and a note that the submission is locked and that Outskill can reopen it if something is genuinely wrong.

It contains no score, no rank, no shortlist, no evidence and no confidence. An end-to-end test asserts exactly that.

---

## 6. Help and resources

Below the form: the pitch-deck template, submission instructions, the approved-idea guide and the product-building workbook — each with a one-line purpose and a file size.

Then a collapsed **How submissions are assessed** panel showing the public rubric: the eight categories, their descriptions and their weights, totalling 100. Categories and weights only — the scoring guidance, test scripts, thresholds and tie-break rules are private.

---

## 7. What a learner can and cannot see

**Can see**

- Their own submission page and draft
- Cohort name, description and instructions
- The deadline, in both the official and their local timezone
- The approved product ideas for their cohort, including minimum core flow
- The public rubric — categories, descriptions, weights
- The pitch-deck template and submission instructions
- Their own receipt after submitting
- Whether credentials are stored (never the values)

**Can never see**

- Any other team
- Internal test plans
- Browser evidence, screenshots or traces
- Category scores, total scores or confidence
- Ranking, the top 10, or shortlist membership
- Internal or participant feedback reports
- Disqualification discussion
- The final-four workspace
- AI prompts or anti-gaming rules
- Any admin navigation

### How that is enforced

Three independent layers, so no single mistake exposes anything:

1. **The capability is absent.** `ParticipantStore` has eight methods and none of them can reach an assessment table. There is nothing to call.
2. **Row-level security grants no policy.** With RLS forced and no participant policy on any assessment table, those tables return zero rows to the participant role — the policy is missing, not permissive.
3. **Tests assert it from outside.** End-to-end tests load the learner portal and the receipt and check the rendered page for score, rank, evidence, shortlist, confidence and feedback markers, and confirm that admin routes redirect to sign-in with no state in the body.

Credentials get a fourth layer: the participant view reports only `hasStoredCredentials: true`, never the values, and the client draft holds the literal string `stored` as a placeholder.
