# Outskill Hackathon Judge

Internal platform for hackathon submission intake, evidence-backed automated assessment, and private shortlisting.

It replaces a Google Form, repetitive external mentor review, and hand-collated scores — for 300–500 submissions, in the ten hours between the Day 13 deadline and the Day 14 shortlist.

**It does not pick winners.** It produces an evidence-backed private ranking and a private top 10. Humans choose four.

---

## Run it locally

No database, no AI key, no deployed worker required.

```bash
npm install
DEMO_MODE=1 npm run dev
```

Then open <http://localhost:3000>. The home page lists six synthetic teams with working invite links, one for each scenario an operator needs to recognise: complete, incomplete, unreachable, login-required, manual-review, and low-confidence.

Admin dashboard: <http://localhost:3000/admin> — `outskill-admin` / `demo-admin-password`.

All demo data is synthetic. No historical identity appears anywhere.

---

## Verify it

```bash
npm run verify      # lint, typecheck, 229 unit + integration tests, build
npm run test:e2e    # 26 Playwright tests: participant journey, admin journey, isolation
```

The worker tests drive a real browser against a fixture app that ships with a known dead button, console error, failing request and accessibility violation — so detection is proven against ground truth rather than assumed.

---

## Layout

```
apps/web         Next.js — participant portal, admin dashboard, server actions
apps/worker      Playwright assessment worker + fixture app
packages/shared  Rubric, schemas, status machines, test DSL, security, data layer
packages/ai      Provider-independent AI adapter, prompts, redaction, injection defence
supabase/        Migrations, RLS, storage buckets
e2e/             Playwright end-to-end tests
docs/            PRD, architecture, threat model, ERD, playbook, runbook, decisions
```

---

## How it works

```
Admin ──CSV──▶ teams + hashed invites ──URL──▶ Participant ──▶ /submit/[token]
                                                                     │ Final Submit
                                                                     ▼
  preflight → artifact analysis → test plan → browser testing → scoring
                                                                     │
                                            ranking snapshot ──▶ private top 10
                                                                     │
                                                        admin selects exactly 4
```

- **Preflight** records every attempt and classifies failures, so a temporary outage is never mistaken for a missing product.
- **Test plans are data, never code** — a closed union of sixteen actions with no way to express code execution.
- **Every score carries evidence**: supporting, contradictory, and what could not be checked, plus a confidence value.
- **Observed browser evidence outweighs unsupported deck claims.**
- **Ranking snapshots are immutable**, so the ranking a decision was made against stays reconstructable.

---

## The rule that shapes everything

Participants never see judging information — no scores, evidence, ranking, shortlist or feedback, in any cohort status.

This is structural, not cosmetic: the participant data layer exposes no method that can reach an assessment table, and row-level security grants participants no policy on those tables at all. Six end-to-end tests assert the boundary from outside the process.

---

## Documentation

| Document | What it covers |
| --- | --- |
| [PRD](docs/PRD.md) | Problem, goals, scope, non-goals |
| [Architecture](docs/ARCHITECTURE.md) | Shape, data flow, the test DSL, containment |
| [Threat model](docs/THREAT_MODEL.md) | Ten threats, their controls, and the explicit non-controls |
| [Database ERD](docs/DATABASE_ERD.md) | 34 tables and the rules held in constraints |
| [Admin playbook](docs/ADMIN_PLAYBOOK.md) | Operating guide, including the Day 13 → Day 14 checklist |
| [Deployment runbook](docs/DEPLOYMENT_RUNBOOK.md) | What deployment would involve. Nothing has been deployed. |
| [Decisions](docs/DECISIONS.md) | 24 ADRs, each with its cost |
| [Reference analysis](docs/reference-analysis.md) | Sanitised findings from the supplied source material |
| [Build status](docs/BUILD_STATUS.md) | Acceptance criteria and security review results |
| [Internal briefing](docs/deck/internal-briefing.md) | 11-slide deck (`npm run gen:deck` regenerates it) |

---

## Privacy

`reference-materials/` is git-ignored, has no web route, and is never bundled. Participant credentials are AES-256-GCM encrypted, masked in the UI, revealed only by an audited action, and never sent to an AI provider. PII is redacted before any model call, and providers see an anonymised submission ID only.
