# Full synthetic rehearsal — prepared, not started

Everything the rehearsal needs, ready for the operator to run by hand. Nothing
in here has been executed: creating the cohort and issuing the codes is the flow
being rehearsed, and doing it automatically would rehearse nothing.

---

## 1. The cohort

**File:** `~/Desktop/rehearsal-learners.csv` (regenerate with
`npx tsx scripts/make-rehearsal-csv.ts`)

| | |
| --- | --- |
| Groups | 67, numbered 101–167 |
| Learners | 241 |
| Team sizes | 1–6, median 4 |
| Emails | every one `@example.com` |
| WhatsApp links | `https://chat.example.com/rehearsal/group-<n>` — shaped like the real thing, leads nowhere |

Group numbers start at 101 so nothing here can be confused with the 8xx and 9xx
synthetic test teams, or with a real allocation's low numbers. The size
distribution is weighted rather than uniform, and includes one-person groups on
purpose — a "team" of one is where copy written for a group reads oddly.

Deterministic: the same seed produces the same cohort, so a second rehearsal can
be compared with the first.

### Doing it

1. **Admin → Cohorts → Create cohort.** Name it something that says what it is —
   `C13 REHEARSAL — DELETE LATER`. Deadline a few days out.
2. **Teams → Import learners**, with the CSV above. Expect 67 groups, 241
   learners.
3. **Issue missing codes.** The file downloads once and is the only copy. It now
   carries a **Learner Message** column — the whole message, per team, ready to
   paste.
4. **Open the cohort.** Only one cohort may face learners at a time, so anything
   else open must be closed first — the interface will say so rather than
   silently taking the slot.

---

## 2. The judging submissions

Five, not sixty-seven. Scoring, evidence, manual-review flags, ranking, the
shortlist and the finalist flow are all exercised by the *differences* between
submissions, not by their number — and sixty-seven complete entries would take
longer to fabricate than the rehearsal takes to run.

Each is a real deployed product that behaves the way its row describes.

| Group | Shape | What it should exercise |
| --- | --- | --- |
| **101** | **Normal, working.** Live URL, core flow completes, deck and demo present, honest limitations. | The happy path end to end: preflight passes, the browser completes every test step, all eight rubric categories score, confidence is high, no flag. This is the baseline every other result is read against. |
| **102** | **Weak but working.** Live, but the must-have workflow only half completes — a save that does not persist, say. Thin deck, no known limitations declared. | Low scores that are not zero, and the difference between *unfinished* and *broken*. Should rank near the bottom without being disqualified. |
| **103** | **Broken URL.** A domain that does not resolve, or a project that has been taken down. | Preflight's five-way outcome. This must come back **absent**, not "failed" — and only `absent` may support a disqualification. Nothing should be scored, and a human should be asked. |
| **104** | **Accessibility / problem signal.** Works, but with a real axe-detectable defect — unlabelled form controls, or contrast far below AA. | The accessibility pass, and a manual-review flag raised for something that is not a failure. Should still score. |
| **105** | **Second normal product**, different approved idea, comparable quality to 101. | Ranking and tie-breaks with two genuinely close submissions, and a shortlist that has to choose. Without a second good one, ranking has nothing to do. |

### What each needs

A deployed URL, a PDF deck, a demo video link, and the six form steps filled in.
Groups 103 aside, they must actually work — a judged submission is judged by a
browser driving the real thing.

**Suggestion:** build 101 and 105 from two different approved ideas in the
catalogue, then derive 102 and 104 from copies of 101 with something removed or
broken. That is four deployments, not five, and the derived ones differ from the
baseline in exactly one way — which is what makes the scores readable.

---

## 3. What must stay true during the rehearsal

- **`AI_EVALUATION_MODE=synthetic_only`.** The rehearsal cohort is synthetic, so
  judging it is allowed. Nothing about the rehearsal changes that setting.
- **No real cohort is touched.** `AIAP C13 Demo` holds 640 real learners and is
  archived. It gets no codes, and nothing is judged in it.
- **The worker must be deployed** before any judging happens — see
  `docs/WORKER_DEPLOYMENT.md`. Until then the queue accepts jobs and nothing
  leases them.

---

## 4. Order

1. Create the cohort, import, issue codes, open. *(Phase 5 above — manual.)*
2. Sign in as two or three groups, fill in and final-submit the five judging
   submissions.
3. Close the cohort.
4. Start judging. Watch the queue: preflight, then browser runs, then scores.
5. Read the evidence for 103 and 104 specifically — those are the two whose
   handling is hardest to get right and easiest to get wrong quietly.
6. Ranking → private shortlist → final four.

Nothing in steps 4–6 has been rehearsed yet against real infrastructure.
