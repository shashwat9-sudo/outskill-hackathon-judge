# Phase A acceptance test — findings log

The controlled run of the real submission platform against the real Supabase
project, on the cohort **PRODUCTION TEST — DELETE LATER** (`AIAP C13`).

Findings are recorded as they are discovered and fixed afterwards, so a single
sweep uncovers everything rather than stopping at the first gap.

**Environment**

| | |
| --- | --- |
| Web app | `http://localhost:3000` (Next.js, `DEMO_MODE=0`) |
| Database | Real Supabase project, transaction pooler |
| Storage | Real Supabase Storage, 6 private buckets |
| `APP_BASE_URL` | `https://acceptance.outskill.invalid` — reserved by RFC 2606, can never resolve |
| `AI_EVALUATION_MODE` | `synthetic_only` — no judging runs during this test |

`APP_BASE_URL` is deliberately a dead domain. The localhost protection is
untouched: `assertDistributableBaseUrl` still refuses local addresses before any
code is generated. A dead domain on a leaked sheet points nowhere, which is
safer than a real domain somebody else could own.

---

## Findings

### F-1 — No admin download for an uploaded deck

**Status:** open · **Severity:** medium · **Found:** before Batch 1, by code inspection

The admin submission detail page lists artifacts, but only an `externalUrl`
(a demo video link) renders as a link. An uploaded PDF shows its
`storagePath` as plain text, and no API route serves `submission_artifacts`.

So an operator can see that a deck was uploaded and cannot open it. Judges
reviewing a flagged submission by hand have no way to read the deck.

The buckets are private and signed URLs are already implemented for admin
resource documents (`/api/admin/resources/[id]`), so the mechanism exists — it
was simply never wired to submissions.

**Not fixed yet.** Deliberately deferred so the acceptance sweep discovers every
gap in one pass rather than stopping at the first.

---

## Batch results

| Batch | Scope | Status |
| --- | --- | --- |
| 1 | Teams and access codes | **passed** |
| 2 | Learner submission and real Storage | **passed** (automated) |
| 3 | Cross-team isolation and collaboration | **passed** (automated) |
| 4 | Lifecycle and code rotation | **passed** (automated) |
| 5 | Final submit, receipt, privacy | awaiting approval — irreversible |

---

### F-2 — Reported cross-team login: NOT reproducible, and the database says it did not happen

**Status:** closed · **Severity:** reported as critical · **Found:** Batch 2, step 2.1

Reported: group 902 accepted with group 901's genuine code.

**It did not happen.** The evidence is in the database, which records a
successful verification against the code row that was used:

| Code | Successful verifications | Last verified |
| --- | --- | --- |
| Group 901 v1 | **0** | never |
| Group 902 v1 | **2** | 23:29:42 |

Group 901's code has never been accepted by anything. Group 902's own code was
accepted twice. The two failure counters that were recorded — group 901 ×1 and
group 777 ×1 — match the two deliberate wrong-code attempts exactly.

No participant session was created for 901 or 902; the only session in the table
belongs to group 999 and was already revoked. So verification stopped at step
one, as designed.

The most likely explanation is that the code from the wrong CSV row was pasted:
both codes were issued into a single two-row file.

**Reproduction was attempted rather than assumed.** `cross-team-auth.test.ts`
pins the full truth table against real Postgres — 901+A accepted, 902+B
accepted, 902+A rejected, 901+B rejected, revoked rejected, superseded rejected,
and every rejection identical. All pass on the unmodified code.

Both mutations of the binding are caught: removing the `group_number` filter
fails 8 tests, and verifying a code against any team's hash fails 5.

### F-3 — `/submit` silently signed a device in as whoever it already was

**Status:** fixed · **Severity:** medium–high · **Found:** while investigating F-2

`/submit` redirected to the portal whenever a session cookie resolved, without
rendering the form. Entering a different group number did nothing and said
nothing.

Two consequences. On a shared laptop — normal at an in-person hackathon — the
second team to sit down lands inside the first team's submission with edit
rights. And a credential test is impossible to perform, because the form cannot
be reached; this is very likely what made F-2 look real.

Fixed: the page now names the signed-in group, offers *Continue* and *Sign out
to use a different group*, and states plainly that entering a different group
number will not change who you are signed in as.

### F-4 — Verification was not scoped to a cohort

**Status:** fixed · **Severity:** high (latent) · **Found:** by the F-2 regression tests

`verifyTeamAccess` looked up `where t.group_number = $1` across **every**
cohort, with `limit 1`.

Group numbers restart at 1 for each cohort, so the moment a second cohort
exists the lookup takes whichever row Postgres returns first. A returning
learner would have their code checked against a stranger's team and be refused
entry to their own hackathon, with a message that gives them nothing to act on.
Dormant today — one cohort exists — and it would have surfaced on the first day
of the second cohort.

Fixed: the lookup prefers a cohort that is open or paused, ignores archived
ones, and **refuses** when two teams have an equal claim to the same group
number rather than choosing between them.

### F-5 — The end-to-end suite was not hermetic

**Status:** fixed · **Severity:** medium · **Found:** running the gate after F-3

Playwright starts its own server, and Next.js loads `.env.local` for it. Any
developer with real credentials on disk was running the suite against a server
holding production seeds: `ADMIN_SEED_USERNAME` was set, so the demo fallback
the tests rely on never applied and **46 admin tests failed to sign in**.

Fixed: the Playwright server now blanks every production variable explicitly —
seeds, database, Supabase, AI key — so a test run cannot reach anything real
and cannot be poisoned by a local file.

### F-6 — Blank white page on `/submit` after running the test gate

**Status:** fixed · **Severity:** medium (tooling, not product) · **Found:** Batch 2 retest

`/submit` returned HTTP 500 and a blank page. The server log showed
`__webpack_modules__[moduleId] is not a function` and a React Server Components
manifest error — bundler-level failures, not application ones.

**Root cause: two processes writing one directory.** `next build` writes
`BUILD_ID` and the client manifests into `apps/web/.next`, which was also the
directory the live `next dev` acceptance server was serving from. Running the
test gate — `npm run build`, and `npm run test:e2e`, which builds first —
replaced the running server's module graph mid-flight. `BUILD_ID` was
timestamped 00:11, from the gate run, in the dev server's own tree.

It was **not** caused by the participant-entry changes, which is what it looked
like: the page that had just been edited was the page that went blank.

**Could this affect a real learner?** Only if someone built the application on
the same machine and directory as the running server. On a normal deployment
the build happens before the server starts, in its own step. The real cost was
diagnostic: it presented as an application bug immediately after a security fix,
at exactly the moment confidence mattered.

Fixed at the boundary: `distDir` is now `process.env.NEXT_DIST_DIR ?? '.next'`,
so a long-running server can be given its own output directory. The acceptance
server runs with `NEXT_DIST_DIR=.next-acceptance`, and a full production build
plus the entire e2e suite now run while it stays up — verified, not assumed.

Also fixed alongside: `.next-*/` added to `.gitignore` and to the ESLint ignore
list, which otherwise linted 2,585 lines of generated output.

**Coverage this exposed.** The new signed-in notice reads fields off a resolved
session, and no test covered a cookie that fails to resolve. A learner
returning with a stale cookie from a previous cohort would hit that path. Now
tested against four unusable cookie values — garbage, empty, oversized and
malformed — each of which must render the plain entry form.

### F-7 — Deck uploads were never stored (only recorded)

**Status:** fixed · **Severity:** CRITICAL · **Found:** Batch 2, step 4

A 706 KB PDF was uploaded. The interface confirmed it, and the database held an
artifact row naming the bucket, the path, `byte_size = 706532` and
`mime_type = application/pdf`.

**Supabase Storage held nothing.** The `submission-decks` bucket was empty at
the root, empty in the cohort directory, and a signed URL for the exact path
returned `Object not found`.

`uploadDeckAction` validated the file properly — extension, MIME, size and PDF
magic bytes — and then called `attachArtifact`, which writes metadata only. A
comment claimed the bytes were skipped "in demo mode"; there was no demo branch,
so they were never written in any mode. `uploadCompletedAt` and
`isAccessible: true` were both recorded as facts and were both false.

**On the day, every team would have submitted successfully and no deck would
have existed.** It would have been discovered when judges opened the bucket
after the deadline, with nothing to recover.

Fixed at the data boundary. `ParticipantStore.uploadDeck` now stores the bytes
and records the artifact as one operation, bytes first — a failed upload throws
before any row is written, so the interface cannot report a success that did not
happen. The action reports storage failure to the learner in time to retry.

### F-8 — The draft payload shadowed the artifacts it described

**Status:** fixed · **Severity:** high · **Found:** same step

Step 4 showed the deck, the video URL and the confirmed duration. Review
reported all three missing.

Both records existed and disagreed. `draft_payload.artifacts` held
`{deckArtifactId: "", demoVideoUrl: "", demoUnderThreeMinutes: true}` — empty
strings written by a step-4 save that happened before the file was attached,
because uploads and links are saved by their own actions and never enter form
state. The form merged the stored payload **last**, so those empty strings
overrode the real artifact rows.

The learner could not have recovered from this. Re-uploading writes a new
artifact row and never touches the payload, so the step would have kept showing
a deck that Review kept refusing.

Fixed with `resolveArtifactsStep`, which makes the artifact rows authoritative
and leaves the draft payload only the duration declaration — a statement with no
artifact of its own. Review and the step now read one resolved state, so they
cannot disagree.

---

## Automated acceptance suite

Batches 2B, 3 and 4 are now a suite rather than a checklist:
`npm run test:acceptance` — 19 tests, real browser contexts against the running
acceptance server, backed by the real Postgres project and real Supabase
Storage. No mocks.

Two things it cannot do, and why:

**Access codes cannot be recovered.** Only an Argon2id hash is stored, so a test
that needs a signed-in browser either rotates the code or mints the session the
login flow would have minted. It does the second for group 901, because rotating
that code would invalidate the sheet already issued. Code *verification* is
tested with real codes issued for group 902, including a genuine code used
against the wrong group.

**The admin UI is not driven.** The admin password was rotated by the operator
and is not available to the suite, and `admin_account` is a singleton so a second
account cannot be created. Lifecycle changes therefore go through the production
store — the same code path the admin action calls — while the admin *controls*
themselves remain covered by the hermetic e2e suite. Recorded as F-11.

### F-9 — `byteSize` was a string wearing a number's type

**Status:** fixed · **Severity:** P1 · **Found:** first run of the automated suite

`submission_artifacts.byte_size` is a `bigint`, and `pg` returns those as strings
to avoid silent precision loss. The mapper did not convert, so `byteSize` was
`"64476"` at runtime while typed `number`.

Not cosmetic: `"9" > "10"` is true, so any size comparison — an upload ceiling, a
"largest deck" sort, a quota check — is wrong for certain pairs of values and
right for others, which is the hardest kind of bug to notice.

Fixed with `mapRowWithNumbers`, applied to artifacts and resource documents. Three
regression tests, including one that states the failure directly.

### F-10 — the acceptance suite locked itself out

**Status:** not a defect · **Severity:** none

The suite submits wrong codes on purpose, and eight wrong attempts in fifteen
minutes locks a group out. That is the rate limiter working exactly as designed;
it was the suite that needed fixing. It now clears the lockout — the same action
the admin screen offers — before any attempt that must succeed.

Worth noting as evidence the limiter engages under real conditions.

### F-11 — the admin UI is not exercised against real data

**Status:** CLOSED, 13 August 2026 · **Severity:** was P2 · **Found:** building the automated suite

Closed by the operator's manual smoke test against the real acceptance data,
using their own admin account: group 901 showed submitted/locked, the artifacts
tab listed the PDF, **View deck** opened the correct PDF in a new tab with the
submission page preserved, and **Download deck** saved the file without
navigating away.

That test also found two defects the automated suite could not — see F-11A and
F-16. Both are fixed and confirmed by the same operator.

The original gap remains a fair description of the automated coverage: no suite
drives the admin UI with a real session, because the admin password belongs to
the operator and `admin_account` is a singleton. A test-only admin credential
was deliberately not created to close it.

Lifecycle and rotation are verified through the production store and their
participant-visible effects, not by clicking the admin controls, because the
suite has no admin credentials. The controls are covered by the hermetic e2e
suite against demo data, so the gap is "admin UI + real data" specifically.

Closing it needs a dedicated acceptance admin account or a test-only credential
path — a decision for Outskill, not something to invent here.

### F-12 — a partial draft save destroyed every other step

**Status:** fixed · **Severity:** P0 (data integrity) · **Found:** Batch 5 preflight

`saveDraft` wrote the incoming payload wholesale:

```sql
set draft_payload = $3
```

So a caller sending one step replaced all six. The submission form always posts
the complete draft, which hid this entirely — until the acceptance suite made a
store-level save of a single step and five steps vanished from a real
submission.

Anything that saves a subset would have triggered it in production: a client
that persists the current step, an autosave optimised to send only what
changed, a retry posting part of the payload, or a second client written
against the same store.

**What survived and what did not.** `promoteDraftToColumns` falls back to the
existing value for every field it maps, so all 26 promoted columns were intact.
Only values with no column of their own were lost:

- `artifacts.demoUnderThreeMinutes` — the three-minute confirmation
- `declarations.*` — the final-submit declarations
- `team.*` — the Team step

Those are precisely the attestations a learner ticks.

**Fix.** A top-level per-step merge, performed by the database so it is atomic
and cannot be computed from a stale copy:

```sql
set draft_payload = coalesce(draft_payload, '{}'::jsonb) || $3::jsonb
```

Per step rather than deep: a step is saved as a unit, and a deep merge would
make clearing a field impossible.

**9 regression tests**, mutation-proved — restoring the old statement fails
**6 of 9**. They cover the three-minute confirmation, the declarations, a series
of partial saves accumulating into one draft, and a refused stale partial save
destroying nothing.

### F-13 — a stale tab reports success it did not achieve

**Status:** open · **Severity:** P1 · **Found:** recovering from F-12

The operator re-attested the lost declarations and reported them saved. The
database never changed: `draft_updated_at` and `version` were still those of a
test save 45 minutes earlier.

The tab had been open since before the acceptance suite ran, so its version
counter was far behind. Every autosave was refused as a conflict — correctly —
and nothing persisted. The form does show a conflict message and stops
autosaving, but the person had already read "Complete" on the Review screen and
took that as confirmation their work was stored.

Completeness is computed in the browser from form state, so it says nothing
about whether anything reached the server. Those two facts sit side by side and
look like one.

Worth fixing before launch: a submission that cannot save should say so where
the learner is looking, and the Review screen should not read as "saved". A team
on deadline night could believe their work is safe when none of it has been
written.

### F-14 — a model got no shape for a discriminated union

**Status:** fixed · **Severity:** P1 · **Found:** Phase 7

Test-plan generation failed schema validation three times, then refused. The
model had produced `target` as a string and omitted `label`.

`describeSchema` handled `ZodUnion` but not `ZodDiscriminatedUnion` — a separate
class — so the test-plan step schema fell through to the catch-all and rendered
as `value`. The model was being asked for a shape nobody had described, and
marked wrong for guessing.

That is the schema where a description matters most: sixteen step variants, each
with its own fields. Fixed by rendering every variant as a worked alternative.
The description went from 4 lines to 7,396 characters, and the next run produced
a valid 19-step plan first time.

### F-15 — a browser that never loaded the product was still scored

**Status:** fixed · **Severity:** P1 · **Found:** Phase 7

A navigation guard blocked every page load. Every assertion then failed because
there was no page, the console was quiet because nothing ran, and the
accessibility scan found nothing to scan.

The pipeline scored it **37/100 at 0.83 confidence with no flag raised.**

That is the exact failure the design is meant to prevent: a technical problem
becoming a judgement about a team. Preflight normally catches an unreachable
product, but it probes with a plain fetch — a site can answer that and still
refuse a headless browser, redirect elsewhere, or fail only under automation.

Fixed where the browser actually runs: if no navigation step succeeded in any
viewport, the job goes to manual review with `browser_never_reached_product`,
and the flag says plainly that this is not a finding about the team. A product
that loads and then breaks is still scored, because that *is* evidence.

---

## Phase 7 — controlled real-browser judging run

Real Playwright, real Gemini, real HTTP. The database is PGlite — a genuine
Postgres engine running the real migrations — because a judging run against the
acceptance project would write assessment rows beside group 901's final
submission and put learner content one bug away from a provider payload.

| | |
| --- | --- |
| Product under test | Local fixture app with known defects |
| Stages | queued → preflight → artifact analysis → test plan → browser → evidence → scoring → **completed** |
| Test plan | 19 steps, `valid`, 0 rejected |
| Browser steps | 31 across desktop and mobile |
| Evidence | 3 screenshots, 2 traces |
| Console errors detected | 4 desktop, 2 mobile |
| Network failures detected | 2 desktop, 1 mobile |
| Accessibility violations | 2 (1 critical, 1 serious) |
| Gemini calls | 3 (artifact analysis, test plan, scoring) |
| Rubric | **8/8 categories**, 44/100, mean confidence 0.86 |
| Bugs found | 4, severity-ranked |
| Ranking | 1 eligible, ranked, shortlisted |
| Final selections | **0** — humans choose |
| Credentials/PII in stored analysis | none |

**Detection checked against ground truth.** The fixture ships with a dead
button, a console error about an analytics module, a failing `/api/broken`
request and two accessibility violations. The judge reported the HTTP 500, the
analytics console error and the accessibility violations in its own words.

### F-11A — "Download deck" behaved exactly like "View deck"

**Status:** CLOSED — fixed and confirmed by the operator in a real browser
**Severity:** P1 · **Found:** operator's manual admin smoke test

The route redirected to a cross-origin signed Storage URL, so what happened next
was Supabase's decision, not ours. The tab navigated away to a PDF viewer, the
operator lost the submission page they were working from, and the two buttons
did the same thing. `Content-Disposition` cannot be set on somebody else's
response.

Fixed by streaming the object through the route: the signed URL is created,
used and discarded server-side and never reaches the browser, so there is also
no URL to forward. `?download=1` returns `attachment`, otherwise `inline`, and
the filename becomes `group-<n>-<name>.pdf` — every deck is stored as
`pitch-deck.pdf`, so three downloads would otherwise collide. View opens in a
new tab; Download leaves the page where it is.

### F-16 — the learner receipt download had never worked

**Status:** CLOSED — fixed and confirmed by the operator downloading the real
group 901 receipt · **Severity:** P1 · **Found:** operator's manual test on real submitted data

Pressing "Download receipt" returned *"No receipt is available for this
session"* while the receipt was visible on screen.

The participant session cookie is scoped to `path=/submit`, deliberately, so it
is never sent to routes with no business seeing it. The receipt route lived at
`/api/receipt` — outside that path — so the browser omitted the cookie, the
route found no session, and refused. Proven with a real browser before changing
anything: `/api/receipt cookie=false`, cookie `path=/submit`.

It had never worked for anybody, and would have failed for every team in a real
cohort at the moment they wanted proof of submission.

Fixed by moving the route to `/submit/receipt`, inside the cookie's scope,
rather than widening the cookie. Privacy is unchanged: the session cookie is
still the only input, so no query parameter can fetch another team's receipt.

Verified against the live server: 200, `application/pdf`, `attachment`,
`no-store`, real `%PDF-` bytes, and a click on the portal produces a downloaded
file with the portal still open. Refused without a session, with an unusable
cookie, and for a team with no final submission.

### F-17 — one acceptance test is flaky against `next dev`

**Status:** CLOSED, 17 August 2026 · **Severity:** P2 (test harness, not the product)

A browser sign-in step in the acceptance suite fails intermittently — roughly
one run in three, and not always the same test. The page reaches the
editor-name step and then does not navigate to the portal, with no error
rendered and no server error logged (`POST /submit` returns 200, the portal
answers in ~500ms).

Mitigations applied, each of which reduced but did not eliminate it: a route
warm-up before the suite, a longer navigation timeout, clearing the verification
lockout on paths that expect success, and asserting the name field has committed
its value before submitting.

**Not root-caused. Not fixed.** Recorded rather than papered over. The
underlying behaviour is proven elsewhere — `downloads.spec.ts` signs in
successfully every run, the rotation test signs in with a freshly issued code,
and the operator's manual sign-ins work — so this is most likely an interaction
between Playwright and `next dev` rather than a product defect.

**Required before launch:** re-run the acceptance suite against a production
build (`next build && next start`) rather than the dev server. If the flake
disappears there, it was compilation latency and the suite should run that way
permanently. If it survives, there is a real defect in the entry flow that has
so far only shown itself under automation, and it must be found before a cohort
depends on it.

#### Resolution — it was compilation latency

**100 consecutive sign-ins, 100 successes**, across five batches of twenty
against the deployed production build:

| Batch | Result | Median | Fastest | Slowest |
| --- | --- | --- | --- | --- |
| 1 | 20/20 | 879 ms | 766 ms | 1,660 ms |
| 2 | 20/20 | 890 ms | 780 ms | 1,582 ms |
| 3 | 20/20 | 904 ms | 788 ms | 1,857 ms |
| 4 | 20/20 | 896 ms | 741 ms | 2,181 ms |
| 5 | 20/20 | 1,514 ms | 916 ms | 15,916 ms |

Each attempt uses a fresh browser context, so no cookie, cache or storage is
shared between them. `retries: 0` in every Playwright configuration, so nothing
could have been quietly re-run.

At the observed dev-server rate of roughly one failure in three, a hundred clean
attempts is about a 1-in-10¹⁷ event. The distribution says the same thing more
directly: four batches sit in a band a few hundred milliseconds wide, which is
not what a race condition looks like. The single 15.9-second outlier in batch 5
is a serverless cold start, and it **succeeded** — a slow path, not a broken one.

**One caveat, recorded rather than glossed.** The original flake appeared in the
acceptance suite against a local `next dev` server, and that exact suite can no
longer run: it drives group 901 inside a cohort that is now archived, and
re-running it would mean reopening acceptance evidence. What was re-run is the
same entry sequence — `/submit`, code, editor name, portal — against a
production build, which is the condition the original entry named as decisive.
It is equivalent, not identical.

Reproducible with `npm run test:staging`. The measurement is kept as a permanent
test rather than a one-off, so a regression in sign-in shows up as a failing
count rather than as a memory of a bad week.


### F-18 — the cohort lifecycle was unusable from the admin UI

**Status:** fixed · **Severity:** P1 · **Found:** operator looking for Archive on a real open cohort

Three separate gaps, each hiding the next.

**There was no way to close submissions.** The lifecycle table offered
`open -> paused` and `paused -> open`, and nothing else. `open -> closed` is
permitted by the domain and was simply absent from the interface, so a cohort
that had been opened could never be closed, judged, finalised or archived from
this screen. Every lifecycle test until now drove the store directly, so nothing
caught it.

**Archive was only reachable from `finalised`.** The only route there ran
through judging — so retiring a cohort that would never be judged, a rehearsal
or a pilot or an acceptance test, meant faking a judging run first. Added
`closed -> archived`, with a confirmation that counts how many final submissions
would never be assessed.

**The Archive button did not archive.** It called `setCohortStatusAction`, which
sets the column and stops. `archiveCohort` also revokes every participant
session and records what was archived, in one transaction. The difference is
invisible on screen and complete in effect: a team would have kept editing a
retired cohort until their session expired on its own. Archive now has its own
action.

Permanent deletion is still not exposed anywhere in the interface, deliberately.
The refusal is worth more than a button.

14 tests, including one asserting that every Archive entry routes to the archive
action rather than a status change, and one asserting deletion stays unreachable.


### F-18 verified on real data

**Status:** confirmed · **Checked:** read-only, 14 August 2026

The operator closed and archived PRODUCTION TEST — DELETE LATER through the
interface. Reported UI actions are observations, so the persisted state was
checked directly, with SELECTs only:

| | |
| --- | --- |
| Cohort status | `archived` |
| Live participant sessions | **0 of 342** |
| Audit trail | `cohort.archived` at 17:11:01Z, after `cohort.status_changed` at 17:10:37Z |
| Submissions | 1 locked, 2 draft — all preserved |
| Artifacts | 2 — preserved |

The `cohort.archived` entry is the part worth noting: the button as it stood
before F-18 could only have written `cohort.status_changed`. Its presence is
proof the new action ran, and the 342 revoked sessions are proof it did the work
the old one skipped. Nothing was deleted.

---

### F-19 — the test fixture had a date in it, and the date passed

**Status:** fixed · **Severity:** P2 · **Found:** by the clock

Eighteen tests failed at midnight. Nothing had changed in the product; the same
files had passed twelve minutes earlier.

`makeCohort`, the fixture behind every Postgres participant test, hard-coded
`day13DeadlineAt: 2026-08-13T18:29:00Z` — the real deadline of the first cohort.
On 14 August that window is closed, so every participant write was correctly
refused and every test that needed an editable submission broke at once. The
product was right and the fixture was wrong, which is the worst combination to
debug under time pressure.

Both fixture cohorts now open a day ago and close a day from now, relative to
the clock. A test that wants a closed window closes it explicitly, which reads
better anyway than depending on what day it is.

---

## Learner self-service guidance

**Status:** built and verified · **Date:** 14 August 2026 · **Data:** synthetic only

Built entirely against the hermetic demo server and new fixtures. The archived
acceptance cohort and group 901 were not opened, driven or written to at any
point; the only contact with production was the read-only archive check above.

| Check | Result | How |
| --- | --- | --- |
| First-run walkthrough | PASS | Appears on first entry, seven cards, Back/Next/Skip/Start; driven in a browser and in React |
| Not shown again | PASS | Survives a reload; per cohort and group, so a shared laptop still shows the next team |
| Replay | PASS | From Need help?, and from the beginning |
| Completed example | PASS | Renders zero form controls; no copy control; declarations listed, never ticked |
| Field-level help | PASS | Question, helper, rule and example; opening an example leaves the field byte-identical |
| What's missing? | PASS | Counts match the validator; every row links to its field; no schema vocabulary anywhere |
| Zero autofill | PASS | Structural sweep of every learner file plus a browser pass over all six steps |
| Zero mutation from guidance | PASS | Import graph walked transitively; mutation-tested with a planted write |
| Stated rules match the schema | PASS | Every minimum fed `min` and `min − 1` characters |
| Mobile at 360px | PASS | Two real layout defects found and fixed; no horizontal scroll on any step |
| F-13 conflict behaviour | PASS | Unchanged; wording rewritten, protections identical |
| Cross-team isolation | PASS | Two teams in sequence; no trace of the first survives the switch |
| Final submit and receipt | PASS | Unchanged |
| Judging-data boundary | PASS | Guidance surfaces swept for score, rank, evidence, confidence, shortlist |

**1,221 unit and integration tests. 152 end-to-end. Lint, typecheck and
production build clean.**


## Responsive QA — five widths

**Date:** 14 August 2026 · **Data:** hermetic demo server, synthetic fixtures only

`e2e/responsive-qa.spec.ts` drives the whole learner journey — walkthrough, six
steps, See example, What's missing?, help menu, long answers, deck upload,
Review, declarations, Final Submit, completed example, guide, receipt — at 360,
768, 1280, 1440 and 1920, measuring the document at every surface.

| Width | Result | Widest control | Widest line |
| --- | --- | --- | --- |
| 360 (phone) | PASS | 286px | within measure |
| 768 (tablet) | PASS | 670px | within measure |
| 1280 (laptop) | PASS | 672px | within measure |
| 1440 (desktop) | PASS | 672px | within measure |
| 1920 (wide) | PASS | 672px | within measure |

Zero horizontal overflow and zero off-screen controls at every width.

Seven defects found and fixed — R-1 to R-7 in `FINAL_LAUNCH_READINESS.md`. The
one that mattered most was invisible to every earlier check: from step two
onwards on a 360px screen, "Save and continue" was clipped off the right edge by
a button row pinned at `shrink-0`. It produced no overflow, no error and no
failing test — the button was just not there.

Screenshots: `test-results/responsive-qa/` — 14 surfaces × 5 widths, with
`measure-<width>.json` beside them.
