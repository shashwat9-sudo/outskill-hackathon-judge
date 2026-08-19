import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildPartnerStore, type PartnerStore, type PartnerSubmissionInput } from './repositories/partner';
import { buildAssessmentStore } from './repositories/assessment';
import { buildRankingStore } from './repositories/ranking';
import { createInMemoryStorage } from './storage';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';
import type { AssessmentStore } from '../store';

/**
 * The contract between the Hackathon product and the Judge.
 *
 * The Judge is a private backend now. The Hackathon product owns the learner
 * relationship, the form and the identifiers; we accept a submission, judge the
 * product, and hand back scores.
 *
 * Two things this file is mostly about. Delivery must be safe to retry, because
 * that is what a well-behaved service does when a response is slow — and a
 * retry that judged the same work twice would produce two assessments of one
 * product. And the Judge must not accumulate learner PII it has no use for:
 * team members, emails and phone numbers stay in the Hackathon product, because
 * none of them help decide whether a product works.
 */

// 32 bytes, base64-encoded, as the credential envelope requires.
const KEY = Buffer.alloc(32, 7).toString('base64');

let db: PgliteHandle;
let partner: PartnerStore;
let assessment: AssessmentStore;
let cohortId: string;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  const { rows } = await db.query<{ id: string }>(
    `insert into rubric_versions (version, name, is_active) values ($1, 'Test', true) returning id`,
    [RUBRIC_VERSION],
  );
  const cohort = await db.query<{ id: string }>(
    `insert into cohorts (name, code, day12_start_at, day13_deadline_at, status, rubric_version_id)
     values ('Hackathon C14', 'HACK14', now() - interval '2 days', now() + interval '2 days', 'closed', $1)
     returning id`,
    [rows[0]!.id],
  );
  cohortId = cohort.rows[0]!.id;
  await db.query(
    `insert into cohort_ideas (cohort_id, slug, title, description, target_user, expected_use_case,
       minimum_core_flow, expected_entities, is_active)
     values ($1, 'meal-planner', 'Meal planner', 'd', 'u', 'c', '["step"]'::jsonb, '{"meal"}', true)`,
    [cohortId],
  );

  partner = buildPartnerStore(db, { credentialKey: KEY, credentialKeyVersion: 1 });
  assessment = buildAssessmentStore(db, createInMemoryStorage());
});

const payload = (over: Partial<PartnerSubmissionInput> = {}): PartnerSubmissionInput => ({
  externalCohortId: 'HACK14',
  externalSubmissionId: 'sub_abc123',
  groupNumber: 12,
  ideaSlug: 'meal-planner',
  productName: 'FridgeChef',
  briefDescription: 'Suggests dinners from what you already have. For busy parents.',
  mainUserAction: 'Type in the ingredients in your fridge and get a dinner suggestion you can cook tonight.',
  aiValue: 'It writes the recipe from whatever odd combination of things you have left.',
  productUrl: 'https://fridgechef.example.com',
  accessMode: 'open',
  loomUrl: 'https://loom.com/share/abc',
  deckUrl: 'https://docs.google.com/presentation/d/abc',
  submittedAt: new Date().toISOString(),
  ...over,
});

describe('accepting a submission', () => {
  it('creates an assessment the Hackathon product can refer to by its own id', async () => {
    const result = await partner.ingestSubmission(payload());

    expect(result.ok).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.submissionId).toBeDefined();

    const { rows } = await db.query<{ n: string }>(
      'select count(*) n from assessment_jobs where submission_id = $1',
      [result.submissionId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('is idempotent, because a caller that retries is behaving correctly', async () => {
    /*
     * A slow response, a deploy mid-request, an at-least-once queue — all
     * produce a second delivery of the same work. None of them should produce a
     * second assessment.
     */
    const first = await partner.ingestSubmission(payload());
    const second = await partner.ingestSubmission(payload());
    const third = await partner.ingestSubmission(payload({ productName: 'Renamed since' }));

    expect(second.submissionId).toBe(first.submissionId);
    expect(third.submissionId).toBe(first.submissionId);
    expect(second.duplicate).toBe(true);

    const { rows } = await db.query<{ n: string }>('select count(*) n from submissions');
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('refuses a cohort it does not know, rather than inventing one', async () => {
    const result = await partner.ingestSubmission(payload({ externalCohortId: 'NOPE' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no cohort/i);
  });

  it('refuses a credentialed product with no credentials', async () => {
    // Better to reject at the door than to send a browser at a login wall and
    // report the team's product as broken.
    const result = await partner.ingestSubmission(payload({ accessMode: 'credentials' }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credentials/i);
  });
});

describe('what the Judge is willing to hold', () => {
  it('needs no team member names, emails or phone numbers', async () => {
    /*
     * The contract has nowhere to put them. This asserts the whole payload can
     * be satisfied without a single piece of personal data — the input above is
     * a product, a link and two sentences about what it does.
     */
    const input = payload();
    const keys = Object.keys(input).join(' ').toLowerCase();

    for (const pii of ['email', 'phone', 'member', 'leader', 'name of', 'contact']) {
      expect(keys, pii).not.toContain(pii);
    }
    expect((await partner.ingestSubmission(input)).ok).toBe(true);
  });

  it('stores no learner name against the team it creates', async () => {
    const result = await partner.ingestSubmission(payload());
    const { rows } = await db.query<{ lead_name: string; lead_email: string | null }>(
      'select t.lead_name, t.lead_email from teams t join submissions s on s.team_id = t.id where s.id = $1',
      [result.submissionId],
    );
    expect(rows[0]!.lead_name).toBe('Group 12');
    expect(rows[0]!.lead_email).toBeNull();
  });

  it('keeps the exact payload it judged, without the credentials', async () => {
    /*
     * "What was this judged on" should be answerable from one row, not
     * reconstructed from a deploy history. The snapshot exists for that — and
     * it must never become a plaintext credential store.
     */
    const result = await partner.ingestSubmission(
      payload({
        externalSubmissionId: 'sub_creds',
        accessMode: 'credentials',
        judgeCredentials: { username: 'judge@example.invalid', password: 'hunter2-secret' },
      }),
    );
    expect(result.ok).toBe(true);

    const { rows } = await db.query<{ ingest_snapshot: Record<string, unknown> }>(
      'select ingest_snapshot from submissions where id = $1',
      [result.submissionId],
    );
    const snapshot = JSON.stringify(rows[0]!.ingest_snapshot);

    expect(snapshot).toContain('FridgeChef');
    expect(snapshot).not.toContain('hunter2-secret');
    expect(rows[0]!.ingest_snapshot.judgeCredentials).toBe('[redacted]');
  });

  it('encrypts judge credentials rather than storing them readably', async () => {
    const result = await partner.ingestSubmission(
      payload({
        externalSubmissionId: 'sub_creds2',
        accessMode: 'credentials',
        judgeCredentials: { username: 'judge@example.invalid', password: 'hunter2-secret' },
      }),
    );

    const { rows } = await db.query<{ password_ciphertext: Buffer }>(
      'select password_ciphertext from submission_credentials where submission_id = $1',
      [result.submissionId],
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.password_ciphertext.toString('utf8')).not.toContain('hunter2-secret');
  });
});

describe('the main user action', () => {
  it('is what the browser plan is built from', async () => {
    /*
     * The single question that replaced a page of technical fields. It lands in
     * the column the test-plan stage reads, so the browser tries the thing the
     * team said their product is for.
     */
    const result = await partner.ingestSubmission(payload());
    const { rows } = await db.query<{ must_have_workflow: string; why_ai_necessary: string }>(
      'select must_have_workflow, why_ai_necessary from submissions where id = $1',
      [result.submissionId],
    );

    expect(rows[0]!.must_have_workflow).toContain('ingredients in your fridge');
    expect(rows[0]!.why_ai_necessary).toContain('writes the recipe');
  });

  it('reaches judging through the worker-scoped read', async () => {
    const result = await partner.ingestSubmission(payload());
    const input = await assessment.getJudgingInput(result.submissionId!);

    expect(input!.submission.mustHaveWorkflow).toContain('ingredients in your fridge');
    expect(input!.submission.productUrl).toBe('https://fridgechef.example.com');
    // And still nothing about the ranking.
    expect(input).not.toHaveProperty('rank');
  });
});

describe('reading a result back', () => {
  it('reports queued work honestly rather than as a zero', async () => {
    await partner.ingestSubmission(payload());
    const result = await partner.getPartnerResult('sub_abc123');

    expect(result.found).toBe(true);
    expect(result.status).toBe('queued');
    expect(result.totalScore).toBeNull();
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
  });

  it('returns all eight categories with their real maximums, even before scoring', async () => {
    // A caller should not have to know which categories exist, nor handle one
    // being absent because scoring has not run yet.
    await partner.ingestSubmission(payload());
    const result = await partner.getPartnerResult('sub_abc123');

    expect(result.categories).toHaveLength(8);
    expect(result.categories!.map((c) => c.maxPoints).reduce((a, b) => a + b, 0)).toBe(100);
    expect(result.maxScore).toBe(100);
    for (const category of RUBRIC_CATEGORIES) {
      expect(result.categories!.some((c) => c.key === category.key), category.key).toBe(true);
    }
  });

  it('is 404-shaped for an id it has never seen', async () => {
    const result = await partner.getPartnerResult('sub_never');
    expect(result.found).toBe(false);
  });

  it('returns scores, reasoning and confidence once judging has run', async () => {
    const ingested = await partner.ingestSubmission(payload());
    const { rows } = await db.query<{ id: string }>(
      'select id from assessment_jobs where submission_id = $1',
      [ingested.submissionId],
    );
    const jobId = rows[0]!.id;

    await assessment.saveScores(
      jobId,
      RUBRIC_CATEGORIES.map((c) => ({
        categoryKey: c.key,
        rawScore: c.maxPoints * 0.8,
        maxPoints: c.maxPoints,
        weightedScore: c.maxPoints * 0.8,
        confidence: 0.9,
        rationale: `Observed for ${c.title}.`,
        supportingEvidence: [],
        contradictoryEvidence: [],
        missingEvidence: [],
        modelVersion: 'm',
        promptVersion: 'p',
        rubricVersion: RUBRIC_VERSION,
      })) as never,
    );
    await assessment.advanceStage(jobId, 'completed', null);

    const result = await partner.getPartnerResult('sub_abc123');
    expect(result.status).toBe('completed');
    expect(result.categories!.every((c) => c.reasoning.length > 0)).toBe(true);
    expect(result.categories!.every((c) => c.confidence === 0.9)).toBe(true);
    expect(result.categories!.find((c) => c.key === 'core_workflow')!.maxPoints).toBe(25);
  });

  it('never returns credentials, evidence paths or worker internals', async () => {
    /*
     * The Hackathon product gets scores and reasoning. Everything about how the
     * judgement was reached — traces, screenshots, prompts, logs — stays here,
     * behind an admin session.
     */
    await partner.ingestSubmission(
      payload({
        externalSubmissionId: 'sub_leak',
        accessMode: 'credentials',
        judgeCredentials: { username: 'judge@example.invalid', password: 'hunter2-secret' },
      }),
    );
    const result = await partner.getPartnerResult('sub_leak');
    const serialised = JSON.stringify(result).toLowerCase();

    for (const forbidden of ['hunter2', 'password', 'ciphertext', 'trace_path', 'screenshot', 'prompt', 'apikey']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });
});

describe('manual review and disqualification', () => {
  it('surfaces an open manual-review flag with its reason', async () => {
    const ingested = await partner.ingestSubmission(payload());
    await assessment.raiseManualReview({
      submissionId: ingested.submissionId!,
      reasonCode: 'product_unreachable',
      detail: 'The product URL did not respond during the run.',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });

    const result = await partner.getPartnerResult('sub_abc123');
    expect(result.manualReview!.flagged).toBe(true);
    expect(result.manualReview!.reasons[0]).toMatch(/did not respond/);
  });

  it('reports no disqualification for an ordinary rough product', async () => {
    // Roughness, missing polish and failed features are scoring outcomes. DQ is
    // reserved for breaking the rules of the event.
    await partner.ingestSubmission(payload());
    const result = await partner.getPartnerResult('sub_abc123');

    expect(result.disqualified!.flagged).toBe(false);
    expect(result.disqualified!.reason).toBeNull();
  });
});

describe('ranking', () => {
  it('produces a rank and a private top-ten flag from completed assessments', async () => {
    /*
     * Ranking stays in the Judge. The Hackathon product does not compute
     * scores or standings — it reads them — and no machine declares a winner
     * either way: the shortlist is an input to a human decision.
     */
    const ranking = buildRankingStore(db);

    for (let i = 0; i < 3; i += 1) {
      const ingested = await partner.ingestSubmission(
        payload({ externalSubmissionId: `sub_rank_${i}`, groupNumber: 20 + i }),
      );
      const { rows } = await db.query<{ id: string }>(
        'select id from assessment_jobs where submission_id = $1',
        [ingested.submissionId],
      );
      await assessment.saveScores(
        rows[0]!.id,
        RUBRIC_CATEGORIES.map((c) => ({
          categoryKey: c.key,
          rawScore: c.maxPoints * (0.5 + i * 0.2),
          maxPoints: c.maxPoints,
          weightedScore: c.maxPoints * (0.5 + i * 0.2),
          confidence: 0.9,
          rationale: 'r',
          supportingEvidence: [],
          contradictoryEvidence: [],
          missingEvidence: [],
          modelVersion: 'm',
          promptVersion: 'p',
          rubricVersion: RUBRIC_VERSION,
        })) as never,
      );
      await assessment.advanceStage(rows[0]!.id, 'completed', null);
    }

    await ranking.generateSnapshot(cohortId, 'partner integration');

    const best = await partner.getPartnerResult('sub_rank_2');
    const worst = await partner.getPartnerResult('sub_rank_0');

    expect(best.rank).toBe(1);
    expect(best.inTopTen).toBe(true);
    expect(worst.rank).toBeGreaterThan(best.rank!);
  });
});
