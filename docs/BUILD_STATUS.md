# Build Status

Progress record. Updated at the end of every phase.

## Current position

**Phase 0 — Analysis: complete.** Moving into Phase 1.

| Phase | State |
| --- | --- |
| 0 — Analysis | ✅ complete |
| 1 — Local demo | ⏳ in progress |
| 2 — Supabase | ⬜ not started |
| 3 — Preflight and AI | ⬜ not started |
| 4 — Playwright worker | ⬜ not started |
| 5 — Scoring and ranking | ⬜ not started |
| 6 — Hardening | ⬜ not started |

---

## Phase 0 — Analysis ✅

**Privacy first.** `.gitignore` was written before the first commit, excluding `reference-materials/`. Verified with `git check-ignore`: the supplied files are untracked and cannot be committed accidentally.

**Derived historical files created** (privacy-safe, no PII, nothing invented):
- `reference-materials/historical-ranking-calibration.md`
- `reference-materials/historical-feedback-patterns.md`
- `reference-materials/historical-submission-quality-notes.md`

**Sources inspected** by fuzzy match on extension, not exact filename:

| Source | Result |
| --- | --- |
| Pitch deck template (PPTX, 8 slides) | Structure mapped. Uses the **stock Google Slides theme** — no Outskill green exists in the asset (→ ADR-014). Placeholder strings identified as an incomplete-deck anti-signal. |
| Product ideas (PDF, 3 pages) | Eight ideas confirmed, matching the brief exactly. Source descriptions are too thin to drive testing, so seeded ideas extend them with the required fields (→ `reference-analysis.md` §3). |
| Product building playbook (PDF, 32 pages) | The most valuable source. Its MoSCoW output, stability checklist, and bug log map almost one-to-one onto submission Steps 2 and 5 and onto the browser test assertions. Five conflicts with the brief recorded and resolved in favour of the brief (→ ADR-001). |

**Documentation written and self-reviewed:** `reference-analysis.md`, `PRD.md`, `ARCHITECTURE.md`, `THREAT_MODEL.md`, `DATABASE_ERD.md`, `BUILD_PLAN.md`, `DECISIONS.md`, `BUILD_STATUS.md`.

**Notable Phase 0 findings that changed the design**

1. The playbook's stability checklist ("must-have flow works twice in a row, no dead buttons or dead-end screens, CRUD works, automations fire") became the browser-test assertion set. Teams are now measured against the standard they were taught, which is what makes the stability category defensible.
2. The playbook's MoSCoW output is already written by every team, so submission Step 2 asks for exactly those three fields rather than new work — and it gives the test planner a team-authored definition of the core flow.
3. The eighteen historical data-quality failures were each converted into a specific validation or preflight check, tabulated in `reference-analysis.md` §5.
4. No Outskill green exists in any supplied asset, so the brand green is a documented, configurable token rather than a guess.

**Gate:** no lint/typecheck/test/build gate applies — no code yet. Privacy gate passed.

---

## Open items for Outskill

None blocking. Full detail in `reference-analysis.md` §7.

1. Real Outskill brand green (placeholder in use).
2. The 8.3 MB deck template would benefit from a compressed variant.
3. The playbook still describes a three-day hackathon and the old portal, and is internally inconsistent on demo length. Recommend revision before the next cohort.
4. Our extended product-idea definitions are an interpretation of two-sentence sources and deserve a curriculum review.

---

## Acceptance criteria tracker

| # | Criterion | State |
| --- | --- | --- |
| 1 | Demo cohort works end to end | ⬜ |
| 2 | Participant submits via secure invite | ⬜ |
| 3 | Participant sees no judging information | ⬜ |
| 4 | Admin manages cohort and ideas | ⬜ |
| 5 | Shared admin password can be rotated | ⬜ |
| 6 | PDF upload is private | ⬜ |
| 7 | Demo credentials are encrypted | ⬜ |
| 8 | Submission can be queued | ⬜ |
| 9 | Demo assessment produces preflight, test, evidence, score, feedback | ⬜ |
| 10 | Worker tests a controlled sample app | ⬜ |
| 11 | Rubric totals exactly 100 | ⬜ |
| 12 | Every score has evidence | ⬜ |
| 13 | Low confidence is flagged | ⬜ |
| 14 | Eligible submissions are ranked | ⬜ |
| 15 | Top 10 remains private | ⬜ |
| 16 | Admin selects exactly four | ⬜ |
| 17 | Participant report remains private | ⬜ |
| 18 | Historical calibration does not depend on old websites | ✅ text-only calibration, no URLs fetched |
| 19 | No PII or private source file is committed | ✅ verified via `.gitignore` + `git check-ignore` |
| 20 | Lint, typecheck, tests and build pass | ⬜ |
