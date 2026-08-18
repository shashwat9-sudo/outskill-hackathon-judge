# Deadline and closure

When submissions are accepted, who decides, and what happens when that changes.

---

## 1. The rule everything else follows

**Whether a write is accepted is decided on the server, on every write, from the
server clock.**

Not by a scheduled job. Not by the browser. Not by a status column that someone
remembered to update.

`computeSubmissionWindow` (`packages/shared/src/domain/submission-window.ts`)
takes the cohort and a timestamp and returns the *effective* state. Every draft
save, upload, artifact removal and final submit runs through it.

This matters because of one specific failure: a cohort left `open` past its
deadline. The stored status says open; the clock says otherwise. The clock wins.
A reconciliation job that never runs changes nothing about what the system
accepts — it only changes what the status column says.

The reverse case is equally deliberate. A team's browser clock being wrong, or
their timezone being misread, cannot buy them extra minutes or cost them any.

---

## 2. The states

| Effective state | Can edit | Can submit | Can view | Cause |
| --- | --- | --- | --- | --- |
| `not_yet_open` | no | no | yes | Cohort is `draft`, or Day 12 has not started |
| `open` | yes | yes | yes | Inside the window |
| `paused` | no | no | yes | An operator paused it |
| `closed_by_deadline` | no | no | yes | The clock passed the effective deadline |
| `closed_by_admin` | no | no | yes | An operator closed it |
| `judging` | no | no | yes | Assessment is running |
| `finalised` | no | no | yes | Judging complete |
| `archived` | no | no | yes | Read-only forever |

A team can always *view* their submission. Nothing here ever takes that away —
losing sight of what you submitted is worse than being unable to change it.

The effective deadline is `accepting_until` when set, otherwise
`day13_deadline_at`.

---

## 3. Automatic closing

Nothing needs to be done. At the deadline instant, writes stop being accepted.

The deadline instant itself is still open; one millisecond past it is not.

`reconcileDeadlines` exists to move the stored status to `closed` so the admin
UI and reporting agree with reality. It is a convenience. If it never runs:

- learners are still refused, with the correct message;
- the cohorts list shows a warning that the deadline has passed while the status
  still reads open, so the operator can see the drift rather than being misled
  by it.

---

## 4. Pausing

**Admin → Cohorts → Lifecycle → Pause submissions.**

Use when something is wrong on Outskill's side and teams should stop working
rather than keep pushing into a broken system.

- Teams can view but not edit or submit.
- The deadline keeps running. Pausing does not buy anyone time.
- Learners are told it is a pause, not a closure: *"Submissions are paused. You
  can view your entry, but cannot edit or submit it until Outskill resumes
  submissions."*

That wording is load-bearing. A team told "closed" during a temporary pause
stops working and goes to bed.

**Resume submissions** puts it back. If the deadline passed while paused, the
window is closed on resume — resuming does not extend anything. Use reopen with
an extension for that.

---

## 5. Closing by hand

**Admin → Cohorts → Submission window → Close submissions now.**

Ends the window immediately, before the deadline. Every team loses the ability
to edit or submit at that instant.

It requires typing `CLOSE SUBMISSIONS` exactly. Not a dialog — a dialog is one
stray Enter key away from being confirmed, and this is the single most damaging
button in the admin surface.

Closing supersedes any acceptance extension.

---

## 6. Reopening

**Admin → Cohorts → Submission window → Reopen submissions.**

Available when a cohort is closed or paused. Requires a reason, which is
recorded in the audit log.

### Reopening before the deadline

A reason is enough. The window runs to the existing deadline.

### Reopening after the deadline

An acceptance time is **required**. The server refuses a reopen without one.

Without it, the cohort would show as open while rejecting every save — the worst
possible state to present to a team that has just been told they may resubmit.
They would try, fail, try again, and conclude the platform was broken.

The acceptance time is stored as `cohorts.accepting_until` and becomes the
effective deadline. A database constraint requires it to be later than the
official deadline; the validator requires it to be in the future.

Learners see it labelled **Extended deadline**, not "Official deadline", so
nobody mistakes an exception for the real thing.

### Reopening one team rather than the cohort

Reopening a whole cohort to fix one submission is usually the wrong instrument.
**Admin → Submissions → [team] → Reopen submission** unlocks a single locked
entry with a reason the team sees. The cohort window still applies: a reopened
submission in a closed cohort is still not editable.

---

## 7. What a learner sees

Before typing anything, on `/submit`:

- **Open** — when submissions close, in the cohort timezone, and how long is
  left.
- **Paused** — that it is paused, and that they can still sign in to see what
  they submitted.
- **Closed** — that it is closed, and the same.

Inside the portal, the deadline is shown three ways side by side: the official
time in the cohort timezone, the same instant in the reader's own timezone, and
the time remaining. A team in a different timezone should never have to do the
arithmetic themselves at midnight.

When the window is not open, the form is read-only and says why.

---

## 8. Sessions and closing

A session outlives the window by a day, so a team can still reach their receipt
after submissions close. It is capped at fourteen days and floored at one hour.

Closing the window does not sign anyone out. They stay signed in and can read
everything they submitted; they simply cannot change it.

---

## 9. Failure modes worth knowing

| Situation | What happens |
| --- | --- |
| Reconciliation job never runs | Writes still refused. Only the status column drifts. |
| Server clock is wrong | The window is wrong. This is the one dependency; check NTP. |
| Learner's clock is wrong | No effect. Their clock is never an input. |
| Cohort reopened with no acceptance time, after the deadline | Refused, with an explanation. |
| Two operators close at the same time | Idempotent. Second close is a no-op on an already-closed cohort. |
| Team mid-save when the deadline passes | That save is refused with the closure message. Nothing already saved is lost. |

---

## 10. Where this lives

| Concern | File |
| --- | --- |
| Window computation, permissions, reopen validation | `packages/shared/src/domain/submission-window.ts` |
| Close, reopen, reconcile | `CohortStore` in `packages/shared/src/data/store.ts` |
| Admin controls | `apps/web/src/app/admin/cohorts/closure-controls.tsx` |
| Admin actions | `closeSubmissionsAction`, `reopenSubmissionsAction` in `apps/web/src/server/admin-actions.ts` |
| Learner notice | `apps/web/src/app/submit/page.tsx` |
| Schema | `supabase/migrations/0004_production_entry.sql` |
