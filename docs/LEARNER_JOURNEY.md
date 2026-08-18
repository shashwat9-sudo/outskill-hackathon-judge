# Learner Journey

Everything a participating team experiences, from finding the URL to holding a receipt.

**The rule that shapes all of it:** a learner never sees judging information. Not a score, not a rank, not evidence, not the shortlist, not feedback — in any cohort status.

---

## 1. Getting in

There is no account, no password and no signup. Every team uses the **same URL**:

```
https://<app>/submit
```

Outskill pastes that one address into Circle by hand. There is no Circle integration, no iframe and no API — nothing in this system knows Circle exists, and nothing about submitting depends on another product being up (ADR-026). A per-team URL was rejected deliberately: the first team to forward or screenshot theirs hands its submission to everyone reading (ADR-027).

A team identifies itself with two things Outskill gave it:

- its **group number**;
- its **team access code** — twelve characters, shown as `ABCD-EFGH-JKMN`.

The alphabet leaves out `O`, `0`, `I`, `1`, `L` and `U`, because those are the characters people misread when a code is read aloud across a room. Upper case, lower case, with dashes, without dashes, with stray spaces — all accepted. A character outside the alphabet is dropped rather than guessed at, so a misread simply fails the length check and the team retypes.

Outskill issues both, and distributes them through its own channels. **The platform sends no email** (ADR-024).

### Two steps, because they are two different questions

**Step one — which team is this?** Group number and code, typed once. The code field is deliberately *not* a password field: a shared code gets read aloud, and hiding it causes far more mistyping than it prevents shoulder-surfing.

Every failure says the same thing, whatever the cause:

> We could not verify those team access details. Check the group number and access code, then try again.

That is not vagueness for its own sake. An unknown group, a wrong code and a revoked code are indistinguishable from outside, so nobody can use the form to work out which group numbers exist.

**Step two — who is editing?** A name, and optionally what they work on. The screen says exactly what it is for:

> Your team shares one submission. Adding your name means everyone can see who changed what — it is not a login, and it does not restrict anyone.

That is the whole truth of it. The name is an activity label, it is never verified, and nothing about access depends on it (ADR-029).

Between the two steps the verified team is carried in an HttpOnly cookie holding a signed ten-minute assertion. The access code is posted once and never travels again: not in the URL, not in browser history, not in local storage, not into the portal.

### When it goes wrong

| What happened | What the team sees | What to do |
| --- | --- | --- |
| Wrong code eight times in fifteen minutes | The same generic message, plus how long to wait | Wait fifteen minutes, or ask Outskill to clear it — an admin can, immediately |
| Took too long over the name step | "That took a little too long. Enter your group number and access code again." | Start again; the code is still valid |
| Lost the code | Nothing on screen can help | Outskill issues a new one. Codes are stored as Argon2id hashes, so **nobody** can look one up, including Outskill |
| Session ended | "Your session has ended. Enter your group number and access code again." | Sign in again; the draft is untouched |

The per-team invite route still exists for demo fixtures and for links issued before the common entry did. It skips only the code step — the name step is the same one, so a session is never opened without a name attached.

---

## 2. What the learner sees

### Before signing in

The entry page states the deadline and how long is left **before** anyone types a code, so a team arriving after closing learns that immediately rather than after filling in a form. Below the form: what to have ready, and a link to the two-day guide.

### The shell

Every signed-in page carries: the Outskill wordmark, the cohort name, their group number, their submission status (Draft or Submitted), who they are editing as, and a sign-out control. Signing out ends that browser's session only — teammates keep theirs.

### The page

> **Submit your hackathon product**
> There are 6 simple steps. Your work saves as you go, and you can come back before the deadline.

Then a deadline panel with three facts side by side:

| | |
| --- | --- |
| **Official deadline** | The cohort deadline in the cohort's timezone, labelled with the offset |
| **Your local time** | The same instant in the viewer's own timezone, resolved client-side after mount |
| **Time remaining** | A live-ish countdown, or a clear "The deadline has passed" |

Showing both timezones is deliberate. A team in a different zone should never have to do the arithmetic on the night.

---

## 3. The six steps

Desktop gets a persistent left-hand progress panel and a main form column; mobile gets the same stepper, folded behind a "Step 3 of 6 · Live product / All steps" line, above a single column with the action bar fixed to the bottom of the screen. There is **one** stepper component in the DOM, responsive rather than duplicated.

Each step shows one of four states, and the distinction between the last two is the point: **✓ complete**, **● you are here**, **⚠ needs attention** (started and unfinished), **○ not started**. "Not complete" covers two situations that call for different actions, and a single empty circle hides the one that matters.

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

## 4. Draft, autosave, editing together, and locking

**Autosave** runs on a 1.2-second debounce after any change. The status line reads:

- `Your work saves automatically` — idle
- `Saving…`
- `✓ Saved just now`
- `Could not save — <reason>. Retry` — with a working retry button

**Save draft** flushes immediately. **Save and continue** flushes, then advances.

### Everyone edits the same entry

Any member with the code can open the submission, and they all edit the same one. On Day 13 that is the normal case, not the exception — so a save is never last-write-wins. Every save states the version it started from, and a save that is behind is refused with:

> Another team member updated this submission. We loaded the latest version. Review your changes before saving again.

The team is told, the newer version is loaded, and nothing is overwritten silently (ADR-030). Refusing the write is worse for one person's next thirty seconds and much better than losing a teammate's half hour.

### What your team has been doing

The portal shows a short activity list — *someone opened the submission*, *saved a section*, *uploaded the pitch deck*, *saved the demo link*, *opened the final review*, *made the final submission* — each with the editor's name and how long ago. That is the complete set of six; there is no seventh, and nothing from the internal audit log appears here.

It exists because somebody opening the portal at 9pm needs to know whether a teammate is already halfway through it.

### The window

A team may edit while **both** the cohort's window is open **and** their submission is in an editable state. Both conditions, always — a reopened submission in a closed cohort stays read-only.

The window is decided by the **server clock on every save**, not by the browser and not by a scheduled job (ADR-031). If the deadline passes while a team is typing, the next save is refused and says so. If Outskill pauses submissions, the team can still read everything and is told why. If Outskill reopens with extra time, the deadline panel shows the extended time instead of the official one.

**Final Submit** is validated again on the server, regardless of what the client believed. It stamps `submitted_at`, issues a receipt ID and locks learner editing.

---

## 5. The receipt

Once locked, the route renders a completely different page. There is no form, and no stepper in the DOM.

> **Submission received**

It shows the team, the product, who pressed submit, the submission time in the cohort timezone, and the receipt ID (`OSK-AIAPD1-012-K3M9QX`) — readable aloud, with `I`, `L`, `O` and `U` excluded from the random tail because people misread them.

There is also a **downloadable PDF**, generated in-process — no external or paid service sees a participant's details. It carries the same facts and nothing else: no access code, no login, no internal identifier. That is asserted before the bytes are produced, so a receipt containing something it should not is a build-time failure rather than a leak.

Then **what happens next**, in three plain steps, and a note that the submission is locked and that Outskill can reopen it if something is genuinely wrong. The receipt ID is the one identifier a team can quote in a support message, and an admin can look up a submission by it.

It contains no score, no rank, no shortlist, no evidence and no confidence. An end-to-end test asserts exactly that.

---

## 5a. Explaining the form once, so nobody has to explain it again

Everything in this section exists to answer one question: could a learner who has never seen this form finish it without asking an Outskill employee what a field means?

The escalation is deliberate, in this order — **better wording → a short helper → a simple example → contextual help**. Guidance that is always on screen stops being read.

### The wording is the first fix

Questions are asked, not named. "Primary user" became *Who is this product mainly for?*; "Known limitations" became *What doesn't work perfectly yet?*; "Major trade-off" became *What did you choose not to build so you could focus on something more important?* The stored data is unchanged — only what the learner is asked.

Every question, helper line, rule, worked answer and to-do phrasing lives in **one module** (`packages/shared/src/content/learner-guidance.ts`), read by the form, the worked example, the "what's missing" list and the written guide. There is one copy of each sentence, so the four surfaces cannot drift.

### The rule is visible before anyone types

Under each box: *Write at least 30 characters — usually 1–2 sentences.* / *Add at least 2 test steps.* / *Upload one PDF deck.* Nobody discovers a minimum by failing it. The stated number is checked against the schema's actual minimum by a test that feeds it `min` and `min − 1` characters, so the sentence and the rule cannot disagree.

### A worked example, on request only

**See example** appears on the questions that are genuinely open to misreading, and nowhere else — an example on every field is an example on none. It expands in place under the question rather than opening a dialog, because on a phone a modal hides the question it is explaining and closes the keyboard.

Every example describes the same invented project, a fitness goal tracker, so a learner reading three fields in a row is watching one team think. **There is no button that copies an example into the form, and there will not be.** Examples explain the question; they never answer it.

### The first-run walkthrough

On the first entry for a team in a browser: seven cards, one sentence each — welcome, then the six steps, ending on *Final Submit locks your submission, so only use it when you're done.* Back / Next / Skip tour / Start my submission. Under two minutes.

Shown once, then not again. Replayable from **Need help? → Replay submission tour**, because the person who most needs it is the one who skipped it at 9am and is back at 11pm. The "seen" flag lives in browser storage keyed by cohort and group — never in the submission, which a guidance feature must not touch.

### What's missing?

Every step carries a collapsed **What's missing?** with a count — *2 things left* — and, on request, the list: *Tell us why AI is useful*, *Add one known limitation*. Each row states the rule under it and puts the cursor in the box that fixes it.

Nothing a learner reads comes from the validator's own vocabulary. Every required question carries its own to-do phrasing; anything without one falls back to a sentence written for a learner, never to `Required` or `Expected string, received null`.

### A completed example

`/submit/example` — one finished submission for the same invented project, laid out like the real form and clearly marked **Example only**. Public, like the guide.

It renders **no form control at all**. Not a disabled input — no input, no textarea, no checkbox, no form. A disabled attribute is one careless refactor from being removed; an element that does not exist is not. The declarations are listed rather than ticked, with the line *You tick these yourself, in your own submission. Nothing is ever ticked for you.*

### One help menu

A **Need help?** button, reachable at every scroll position, holding exactly five things: how to fill this step, see a completed example, replay submission tour, submission checklist, resources. Not a help centre — a learner mid-form will not read a knowledge base, they will message someone at Outskill.

### Review reads as a checklist

Six rows, each either *✓ Complete* or *⚠ 4 things missing* with the missing items listed and clickable. Long rows show four and summarise the rest, so the checklist does not become the form again. Above Final Submit: *Before you submit — You can edit your answers until you use Final Submit. After that, your submission is locked.*

### Nothing here can change a submission

The guidance modules import no server action and hold no submission state; they cannot save, upload, or change a version, because they have nothing to call. That is proved rather than asserted: a test walks the import graph of every guidance file and fails if any write path appears anywhere in it, and it is mutation-tested by planting a write and confirming the guard catches it.

There is no "Generate answer", no "Write this with AI", no "Improve my answer". This feature teaches learners what the form means. It does not write their submission.

---

## 6. Help and resources

**The two-day submission guide** — `/submit/guide`, with a PDF at `/api/guide` — covers what the two days look like, the live product, the deck, the demo video, the learning evidence, submitting, and what to do when something goes wrong. It is readable **without signing in**: a team looking it up at 2am should not have to find their access code first, and there is nothing in it worth protecting. Page and PDF are built from one source, so the two cannot drift.

The guide now opens with **The six steps** — what each one asks for, what to have ready, and a worked answer for the three teams most often misread — and closes with **Mistakes that cost teams marks**. Both are generated from the same guidance module the form reads, so the guide cannot describe a form that no longer exists.

The downloads — pitch-deck template, submission instructions, approved-idea guide, product-building workbook — moved into the **Need help? → Resources** panel. Help scattered across a page is help nobody can find twice.

Then a collapsed **How submissions are assessed** panel showing the public rubric: the eight categories, their descriptions and their weights, totalling 100. Categories and weights only — the scoring guidance, test scripts, thresholds and tie-break rules are private, and so is the admin playbook.

---

## 7. What a learner can and cannot see

**Can see**

- Their own submission page and draft
- Cohort name, description and instructions
- The deadline, in both the official and their local timezone
- The approved product ideas for their cohort, including minimum core flow
- The public rubric — categories, descriptions, weights
- The pitch-deck template, submission instructions and the two-day guide
- What their own teammates have done to the submission, and when
- Their own receipt after submitting, on screen and as a PDF
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
- AI prompts, anti-gaming rules or the admin playbook
- Any admin navigation
- Any other team's group number — including whether it exists

### How that is enforced

Three independent layers, so no single mistake exposes anything:

1. **The capability is absent.** Every method on `ParticipantStore` takes the session token and derives the team from it, and not one of them can reach an assessment table. There is nothing to call.
2. **Row-level security grants no policy.** With RLS forced and no participant policy on any assessment table, those tables return zero rows to the participant role — the policy is missing, not permissive. The same applies to `team_access_codes`, `participant_sessions` and `verification_attempts`; the one participant policy on the new tables is SELECT on `team_activity`, for their own team.
3. **Tests assert it from outside.** End-to-end tests load the learner portal and the receipt and check the rendered page for score, rank, evidence, shortlist, confidence and feedback markers, and confirm that admin routes redirect to sign-in with no state in the body.

Credentials get a fourth layer: the participant view reports only `hasStoredCredentials: true`, never the values, and the client draft holds the literal string `stored` as a placeholder.
