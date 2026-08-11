# Outskill Hackathon Judge — internal briefing

## 1. Hackathon Judge

Evidence-backed assessment for 300–500 hackathon submissions, in the ten hours between the deadline and the shortlist.

## 2. The problem with judging by hand

- A Google Form produces submissions nobody validated — decks that are actually Loom links, credentials pasted into URL fields, links that were never reachable.
- External mentors each open a few products, form an impression, and write freehand feedback. Coverage is uneven and standards drift between reviewers.
- Nobody actually exercises the product deeply. There is no time.
- Scores and notes are collated by hand across spreadsheets and chat.
- Ten hours between the Day 13 deadline and the Day 14 shortlist. It only works because reviewers cut depth.

## 3. What we built

A platform that takes a submission from intake to a defensible private ranking — where "evidence" means a real browser actually drove the product.

- Structured intake that makes the historical data-quality failures impossible
- Automated preflight, artifact analysis and product-specific test planning
- Deep Playwright testing of the live product
- Evidence-backed scores against a fixed 100-point rubric
- Private ranking and a private top 10
- Humans choose the final four

## 4. The participant journey

- One secure invite link per team. No account, no password, no signup.
- Six autosaving steps: team, product, live product, artifacts, learning evidence, declarations.
- The form asks for what teams already wrote in their workbook — the MoSCoW scope, the bug log, the reflection.
- A review screen shows exactly what is missing, field by field.
- Typed FINAL SUBMIT locks the submission and issues a receipt.
- Participants see the rubric and the deadline. They never see a score, a rank, or a shortlist.

## 5. The assessment pipeline

| Stage | What happens |
| --- | --- |
| preflight | 13 checks; every attempt recorded; outage told apart from absence |
| artifact_analysis | Deck text, written submission, injection screening |
| test_plan_generation | A product-specific plan, constrained to a closed action set |
| browser_testing | Real Chromium drives the live product |
| evidence_review | Evidence assembled per rubric category |
| scoring | Eight categories, each with evidence and confidence |
| consistency_review | Second pass only where it could change an outcome |
| completed | Ranked, if eligible |

> manual_review, failed and disqualified are outcomes, not errors.

## 6. Deep testing, not a screenshot

- A fresh isolated browser per submission, eight-minute budget, downloads disabled.
- Runs the team’s own declared must-have workflow — twice, because that is the stability bar they were taught.
- Proves persistence by reloading and checking the data survived.
- Captures console errors, failed requests, dead ends, an accessibility scan, and a mobile pass.
- Everything it creates is prefixed OUTSKILL-JUDGE- and cleaned up afterwards.
- Test plans are data, never code. There is no action that can execute anything.

## 7. The rubric

| Category | Points |
| --- | --- |
| Problem and target-user clarity | 15 |
| Core workflow functionality | 25 |
| Stability, data and technical completeness | 15 |
| AI usefulness and differentiation | 15 |
| Learning and execution quality | 10 |
| UX and accessibility | 10 |
| Practical or commercial potential | 5 |
| Deck and demo clarity | 5 |
| Total | 100 |

> Fixed and public. The test scripts, thresholds and tie-break rules are not.

## 8. Every score carries its evidence

- Supporting evidence — what was actually observed.
- Contradictory evidence — where the product disagreed with the claim.
- Missing evidence — what could not be checked, stated plainly.
- Confidence 0–1, about how much there was to go on, not how good the product is.
- Observed browser evidence outweighs any unsupported deck claim.
- A run that timed out says so. Unreached steps are unknown, not failed.

> A category with no evidence is flagged as unsupported rather than quietly scored.

## 9. Private top 10. Human final four.

- Eligible submissions are ranked; ties break on core workflow, then stability, then AI usefulness, then learning, then fewer unresolved risks.
- Ranking snapshots are immutable, so the ranking a decision was made against stays reconstructable.
- The top 10 is highlighted privately, for reviewers only.
- Admins review evidence, override with a reason, and the machine’s original score is preserved.
- The final four are chosen by a person, in one place, with a recorded reason each.
- No worker, no job stage and no model response can write a winner.

## 10. Privacy and safety

- Participants cannot reach judging data — the capability is absent, not merely hidden.
- Demo credentials are encrypted at rest, masked in the UI, and never sent to an AI model.
- PII is redacted before any model call; providers see an anonymised submission ID.
- The worker cannot reach private networks — resolved addresses are checked before every navigation.
- Prompt injection cannot change behaviour, because behaviour comes from validated structure, not prose.
- Disqualification is limited to eleven grounds. "Low score" is not one, and the database will not store it.

## 11. The night it matters

| Time (IST) | What happens |
| --- | --- |
| 11:59 PM Day 13 | Deadline. Cohort closed. |
| 12:00 AM | Judging queued. Worker started. |
| 12:30 AM | First checkpoint — is the projection green? |
| 2:00–5:00 AM | Monitored run. Flags triaged as they appear. |
| 6:00 AM | Assessment complete. Manual reviews cleared. |
| 7:00 AM | Ranking snapshot. Second scoring pass. |
| 7:30–9:00 AM | Humans read the evidence for the top 10. |
| 9:00–9:45 AM | Final four chosen, with reasons. |
| 10:00 AM Day 14 | Private shortlist ready. |

> Nothing is announced automatically. Announcement is a separate human act.
