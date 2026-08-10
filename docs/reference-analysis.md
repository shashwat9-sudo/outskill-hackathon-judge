# Reference Source Analysis (Sanitised)

**Status:** Phase 0 output
**Sources:** three files supplied by Outskill in `reference-materials/` (git-ignored, never committed, never served over HTTP)
**Sanitisation:** this document contains structural and instructional findings only. It contains no participant names, emails, phone numbers, credentials, private links, or verbatim bulk copies of the source documents. Placeholder names that ship inside the blank deck template are described generically rather than reproduced.

---

## 1. How the sources were discovered and read

Files were located by extension and fuzzy name match, not exact filename:

| Matched pattern | Type | Size | Extraction method |
| --- | --- | --- | --- |
| `*Pitch Deck Template*.pptx` | PPTX | ~8.3 MB | OOXML unzip, ordered `<a:t>` run extraction per slide |
| `*Product Ideas*.pdf` | PDF, 3 pages | ~63 KB | `pdfjs-dist` text-layer extraction |
| `*Playbook*.pdf` | PDF, 32 pages | ~690 KB | `pdfjs-dist` text-layer extraction |

The same two extraction routines are productised later in the build: PDF text extraction becomes the deck-analysis path in `packages/ai` (Phase 3), and the fuzzy-discovery approach informs `scripts/find-reference-materials.ts`.

---

## 2. Pitch deck template (PPTX)

### Structure

Eight slides:

1. Title / cover (visual only, no text runs)
2. Group number + project / MVP title
3. Team members grid (four placeholder cards: display name, 3–5 word summary, job profile)
4. Duplicate team-members layout (alternate variant)
5. Problem statement: one-line problem + three supporting points
6. Product demo: screenshot + Loom video placeholder
7. Product demo: Loom link placeholder
8. Closing slide

### Design and branding findings

- The deck inherits the **stock Google Slides theme** (`accent1 = #4285F4`, dark `#000000`, light `#FFFFFF`). There is **no Outskill green encoded in the file**.
- Consequence: the "black, white and Outskill green" requirement for our internal demo deck cannot be sourced from this artifact. We define the brand green as a **configurable token** (see `docs/DECISIONS.md`, ADR-014) rather than guessing at a brand asset we do not have.
- File weight (~8.3 MB) is almost entirely embedded imagery. Serving it to participants must go through a private bucket + signed URL, not the public app bundle.

### What this tells the judge

The template tells us what a *compliant* deck contains, which is directly usable as deck-clarity scoring signal:

| Expected deck element | Rubric use |
| --- | --- |
| Group number and product title present | Deck & demo clarity (5) — identification |
| Team slide filled in (not left as placeholder) | Deck & demo clarity — effort signal |
| One-line problem + three supporting points | Problem & target-user clarity (15) — corroborates the written submission |
| Product screenshot | Deck & demo clarity — corroborates the live product |
| Loom link present | Preflight requirement; demo clarity |

**Anti-signal to detect:** a deck still containing the template's placeholder strings ("Brief about what you do in 3-5 words", "Write: Your job profile", "Write one line Problem Statement", "ADD SCREENSHOT…"). Unedited placeholder text is evidence of an incomplete deck and is recorded as *contradictory evidence* in the deck category. It is **not** grounds for disqualification.

---

## 3. Product ideas (PDF)

Three pages. Page 3 is blank. Eight ideas, matching the authoritative list in the brief exactly:

1. Recipe Sharing App
2. Fitness Goal Tracker
3. Book Recommendation App
4. Movie Watchlist
5. Budget Tracker
6. Collaborative Notetaker
7. Website Content Scraper
8. Travel Itinerary Planner

### Shape of each entry

Every idea in the source has exactly two parts: a one-or-two-sentence **description**, and a **"How to Build"** line naming a suggested stack (a front-end builder, a hosted Postgres backend, and an LLM API; the scraper idea additionally names a scraping API).

### Gap identified

The source descriptions are far too thin to drive automated testing. "An app where users can search for movies and add them to a personal watchlist, with a simple rating system" does not tell a test planner what the minimum core flow is, which entities must persist, or what would be out of scope.

The seeded `cohort_ideas` records therefore **extend** each source idea with the fields the brief requires — target user, expected basic use case, minimum core flow, expected entities, possible AI opportunity, allowed scope, unsafe/prohibited interpretations. These extensions are our own product design, derived from the source description; they are stored in the database and are **admin-editable per cohort**, so future cohorts are not bound to our interpretation.

### Notable per-idea risk flags carried into the seed

- **Website Content Scraper** is the only idea whose natural implementation makes outbound requests to arbitrary third-party URLs. Its seeded `unsafe_interpretations` explicitly prohibits scraping authenticated, paywalled, private, or internal-network targets, and its test plan uses a fixed, safe, public URL rather than anything the product suggests.
- **Collaborative Notetaker** implies real-time multi-session behaviour. Its test plan includes a second-context persistence check rather than assuming single-session correctness.
- Ideas that naturally imply account ownership (Fitness, Budget, Watchlist, Notetaker) are the ones most likely to require login, so demo credentials matter most there. Login is judged against the use case and is never penalised on its own.

The suggested stack in the source is guidance to learners, **not** a scoring criterion. Teams are not rewarded or penalised for stack choice; the submission captures the stack purely as declared context.

---

## 4. Product building playbook (PDF)

Thirty-two pages, titled as a hackathon workbook. Two halves: a blank workbook (pages 1–18) and a fully worked example (pages 19–32) using a travel-itinerary product.

### Structure

| Phase | Steps | Content |
| --- | --- | --- |
| Phase 1 — Ideation | 1–4 | Product one-liner ("For X, I am building Y so they can Z"), primary user + context + top-3 pains, 5-Whys deepening, competitor scan, MoSCoW prioritisation |
| Phase 2 — Building | 5–8 | Architecture (screens / backend / data store / external APIs), PRD generation, platform-specific starting prompt, day-by-day build execution. Optional GitHub-for-backup section. |
| Phase 3 — Backend & demo | 9–12 | Data design, CRUD checklist per entity, automations and one "wow" AI feature, scenario testing + bug log, demo script and reflection |

Closing sections: resource links, and submission instructions for the **previous** portal.

### This is the single most important source for the judge

The playbook is what teams were actually taught. It defines the vocabulary and the artifacts they will have on hand. Three sections map almost one-to-one onto our system:

**(a) MoSCoW → submission Step 2.**
The playbook has teams commit to "a single Must-have flow", "up to 2 Should-haves", and features "parked deliberately". Our Step 2 fields (`must_have_workflow`, `should_have_features` max 2, `excluded_features`) are deliberately the same three fields. This means the submission form asks for something the team already wrote down, and it gives the test planner an explicit, team-authored definition of what the core flow *is*.

**(b) Stability checklist (Step 11.3) → browser test assertions.**
The playbook's own stability bar is: the must-have flow works start to finish **twice in a row**; no dead buttons or dead-end screens; CRUD works for main entities; key automations fire. Our Playwright suite tests exactly these, which makes the "Stability, data and technical completeness" category defensible — we are testing teams against the standard they were given, not one we invented.

**(c) Bug log (Step 11.2) and reflection (Step 12.2) → submission Step 5.**
The playbook's bug log has three rows and the reflection asks for top-3 issues and a next-7-day plan. Our Step 5 asks for exactly three important bugs fixed and a next-seven-day plan. Again: already-written material, not new homework.

Also inherited: the demo-script structure (user & problem → what you built → live walkthrough of the must-have flow → next steps) is what the "Deck and demo clarity" category checks for, and "must-have flow runs live **without hidden setup**" becomes a preflight expectation (teams that need hidden setup must declare it, or the product is routed to manual review).

### Conflicts with the authoritative brief

The playbook is an older document. Where it disagrees with the brief, **the brief wins**. Recorded conflicts:

| # | Playbook says | Authoritative rule | Resolution |
| --- | --- | --- | --- |
| C1 | "Build a working MVP in **3 days**"; Day 1 / Day 2 / Day 3 execution structure | 14-day accelerator; hackathon on **Days 12–13**; deadline 11:59 PM IST Day 13 | System uses Day 12 start / Day 13 deadline throughout. Submission Step 5 asks "what changed from Day 12 to Day 13". No three-day language anywhere in the product. |
| C2 | Demo script "3–5 mins"; submission section says "2–3 minute Loom" (internally inconsistent) | Demo must be **no longer than three minutes** | Portal requires an explicit ≤3-minute confirmation checkbox. Over-length is a clarity deduction, never a disqualification. |
| C3 | Submit by logging in to a portal and opening a "Submit Project" tab | One secure invite link per team | No participant accounts. Access is a single-use-issued, revocable, hashed invite token at `/submit/[token]`. |
| C4 | GitHub backup is optional | Source or builder-history proof is required for the top 20, suspicious cases, disputed originality, and admin-selected cases | Source proof is a post-hoc admin request flow, not a submission requirement for everyone. |
| C5 | Playbook is silent on judging | Deep automated assessment, private ranking, private top 10, human final four | Entirely new; no participant-visible judging surface exists. |

These are re-stated in `docs/DECISIONS.md` (ADR-001) so the resolution is traceable.

---

## 5. Derived historical calibration files

Three privacy-safe Markdown files were generated into `reference-materials/` from the calibration pack in the build brief:

- `historical-ranking-calibration.md` — anonymised top-10 patterns from a prior cohort
- `historical-feedback-patterns.md` — twelve recurring mentor-feedback themes plus feedback-quality rules
- `historical-submission-quality-notes.md` — prior form structure, eighteen observed data-quality failures, and their design implications

These are **derived calibration references, not copies of raw historical records**. They contain no names, emails, phone numbers, links, or credentials, and none were invented to fill gaps.

### How they are used

| File | Consumed by | Consumed how |
| --- | --- | --- |
| Ranking calibration | Human reviewers, during calibration review | Read by admins as a sanity check on whether the rubric produces defensible outcomes. **Never fed to the scoring model**, so a submission cannot earn points by resembling a past winner. |
| Feedback patterns | Feedback-report generation | Distilled into feedback *quality rules* (cite evidence, separate bug from enhancement, strengths first, top-three priorities, no automatic integration recommendations). The themes shape *how* feedback is written, not *what* it says. |
| Submission quality notes | Portal form design + preflight | The eighteen historical failures are converted into concrete validations. |

### The eighteen historical failures, as implemented validations

| Historical failure | Where it is now prevented |
| --- | --- |
| Group number in wrong format; email typed into the group-number field | Typed, pattern-validated `group_number`; email fields are separate and format-checked |
| Duplicate submissions; multiple versions of the same product | One submission row per (cohort, team), DB-unique; Final Submit locks |
| Missing demo video; "video not generated" typed as a URL | Demo link is URL-validated, not free text; preflight fetches it |
| Product URL pointing at a Drive folder | HTTPS + browser-application URL validation; known document-host domains are flagged at preflight |
| Deck field containing the Loom URL | Deck is a **PDF file upload**, not a text field — the field cannot hold a URL |
| Credentials pasted into the product-link field | Dedicated conditional credential fields, AES-256-GCM encrypted, masked in UI, never sent to AI |
| Private / inaccessible Drive documents | Preflight accessibility check with retries and recorded attempts |
| Inconsistent team-member and phone formatting | Structured repeating member rows; normalised phone input |
| Descriptions containing pasted chat transcripts | Length caps + prompt-injection screening on free text |
| Links that later expired; API-backed products that stopped working | Declaration that URLs stay available through judging; retries; outage distinguished from failure and never auto-disqualifying |
| Links needing undisclosed manual setup | Required "known limitations" and reset/cleanup fields; undisclosed setup routes to manual review |
| Late submissions needing manual interpretation | Server-side deadline evaluation in cohort timezone, with an explicit admin exception path |
| Real personal information in free text | PII redaction before any AI call; anonymised submission IDs |

---

## 6. What is deliberately **not** carried forward

- No raw historical records are imported, and no import path exists in Version 1.
- No historical participant identity, real or invented, appears in fixtures, docs, tests, or screenshots. All demo data is synthetic and obviously so.
- Old product URLs are never fetched. Historical calibration is text-only and does not depend on any old site still being online.
- The prior portal's account-based submission model is not reproduced.
- The playbook's suggested stack is not a scoring input.

---

## 7. Follow-ups for the Outskill team

Not blocking; recorded so they are not lost.

1. **Brand green.** No Outskill green exists in the supplied assets. We ship a documented placeholder token; supply the real hex and it is a one-line change (ADR-014).
2. **Deck template weight.** The 8.3 MB template is served through a signed URL. A compressed variant would improve the participant experience on slow connections.
3. **Playbook revision.** The playbook still describes a three-day hackathon and the old submission portal, and is internally inconsistent on demo length (3–5 min vs 2–3 min). Learners will read it. Recommend a revision aligned to Days 12–13 and the ≤3-minute rule before the next cohort.
4. **Idea depth.** Our extended idea definitions are an interpretation of two-sentence source descriptions. Worth a review pass by whoever owns the curriculum, via `/admin/cohorts/[id]/ideas`.
