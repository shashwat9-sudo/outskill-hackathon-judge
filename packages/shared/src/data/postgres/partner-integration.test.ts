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
  partner = buildPartnerStore(db, { credentialKey: KEY, credentialKeyVersion: 1 });

  // The internal product declares its cohort before sending any work.
  const synced = await partner.syncCohort({ externalCohortId: 'AIAP-C14', name: 'Hackathon C14' });
  cohortId = synced.cohortId!;
  void rows;
  await db.query(
    `insert into cohort_ideas (cohort_id, slug, title, description, target_user, expected_use_case,
       minimum_core_flow, expected_entities, is_active)
     values ($1, 'meal-planner', 'Meal planner', 'd', 'u', 'c', '["step"]'::jsonb, '{"meal"}', true)`,
    [cohortId],
  );

  assessment = buildAssessmentStore(db, createInMemoryStorage());
});

const payload = (over: Partial<PartnerSubmissionInput> = {}): PartnerSubmissionInput => ({
  externalCohortId: 'AIAP-C14',
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
    expect(result.unknownCohort).toBe(true);
    expect(result.error).toMatch(/sync it first/i);
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
    const result = await partner.getPartnerResult('AIAP-C14', 'sub_abc123');

    expect(result.found).toBe(true);
    expect(result.status).toBe('queued');
    expect(result.totalScore).toBeNull();
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
  });

  it('returns all eight categories with their real maximums, even before scoring', async () => {
    // A caller should not have to know which categories exist, nor handle one
    // being absent because scoring has not run yet.
    await partner.ingestSubmission(payload());
    const result = await partner.getPartnerResult('AIAP-C14', 'sub_abc123');

    expect(result.categories).toHaveLength(8);
    expect(result.categories!.map((c) => c.maxPoints).reduce((a, b) => a + b, 0)).toBe(100);
    expect(result.maxScore).toBe(100);
    for (const category of RUBRIC_CATEGORIES) {
      expect(result.categories!.some((c) => c.key === category.key), category.key).toBe(true);
    }
  });

  it('is 404-shaped for an id it has never seen', async () => {
    const result = await partner.getPartnerResult('AIAP-C14', 'sub_never');
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

    const result = await partner.getPartnerResult('AIAP-C14', 'sub_abc123');
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
    const result = await partner.getPartnerResult('AIAP-C14', 'sub_leak');
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

    const result = await partner.getPartnerResult('AIAP-C14', 'sub_abc123');
    expect(result.manualReview!.flagged).toBe(true);
    expect(result.manualReview!.reasons[0]).toMatch(/did not respond/);
  });

  it('reports no disqualification for an ordinary rough product', async () => {
    // Roughness, missing polish and failed features are scoring outcomes. DQ is
    // reserved for breaking the rules of the event.
    await partner.ingestSubmission(payload());
    const result = await partner.getPartnerResult('AIAP-C14', 'sub_abc123');

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

    const best = await partner.getPartnerResult('AIAP-C14', 'sub_rank_2');
    const worst = await partner.getPartnerResult('AIAP-C14', 'sub_rank_0');

    expect(best.rank).toBe(1);
    expect(best.inTopTen).toBe(true);
    expect(worst.rank).toBeGreaterThan(best.rank!);
  });
});

describe('unassessed versus assessed zero', () => {
  it('reports an unassessed category as null, not as a zero', async () => {
    /*
     * Zero is a real mark: "we looked, and it earned nothing". Using it for
     * "not looked at yet" makes a queued submission indistinguishable from one
     * that failed everything — and the team reading it cannot tell which
     * happened to them.
     */
    await partner.ingestSubmission(payload());
    const result = await partner.getPartnerResult('AIAP-C14', 'sub_abc123');

    expect(result.status).toBe('queued');
    expect(result.totalScore).toBeNull();
    expect(result.confidence).toBeNull();
    for (const category of result.categories!) {
      expect(category.score, category.key).toBeNull();
      expect(category.confidence, category.key).toBeNull();
      // The maximum is still stated, so a caller can render the shape.
      expect(category.maxPoints).toBeGreaterThan(0);
    }
  });

  it('keeps a genuinely assessed zero as zero', async () => {
    // The other half. A team whose AI category earned nothing must see 0, and
    // it must be distinguishable from the null above.
    const ingested = await partner.ingestSubmission(payload());
    const { rows } = await db.query<{ id: string }>(
      'select id from assessment_jobs where submission_id = $1',
      [ingested.submissionId],
    );

    await assessment.saveScores(
      rows[0]!.id,
      RUBRIC_CATEGORIES.map((c) => ({
        categoryKey: c.key,
        rawScore: c.key === 'ai_usefulness' ? 0 : c.maxPoints,
        maxPoints: c.maxPoints,
        weightedScore: c.key === 'ai_usefulness' ? 0 : c.maxPoints,
        confidence: 0.9,
        rationale: c.key === 'ai_usefulness' ? 'No AI was present in the product.' : 'Observed.',
        supportingEvidence: [],
        contradictoryEvidence: [],
        missingEvidence: [],
        modelVersion: 'm',
        promptVersion: 'p',
        rubricVersion: RUBRIC_VERSION,
      })) as never,
    );

    const result = await partner.getPartnerResult('AIAP-C14', 'sub_abc123');
    const ai = result.categories!.find((c) => c.key === 'ai_usefulness')!;

    expect(ai.score).toBe(0);
    expect(ai.score).not.toBeNull();
    expect(ai.reasoning).toMatch(/no ai/i);
    expect(result.categories!.find((c) => c.key === 'core_workflow')!.score).toBe(25);
  });
});

describe('two cohorts running side by side', () => {
  const OTHER = 'AIAP-C13';

  beforeEach(async () => {
    await partner.syncCohort({ externalCohortId: OTHER, name: 'Hackathon C13' });
  });

  it('maps each external cohort to its own Judge cohort, permanently', async () => {
    const first = await partner.syncCohort({ externalCohortId: OTHER, name: 'Hackathon C13' });
    const again = await partner.syncCohort({ externalCohortId: OTHER, name: 'Renamed C13' });

    expect(again.cohortId).toBe(first.cohortId);
    expect(again.created).toBe(false);
    expect(first.cohortId).not.toBe(cohortId);
  });

  it('keeps group 42 in C13 separate from group 42 in C14', async () => {
    /*
     * Group numbers are only meaningful inside a cohort. Two cohorts running at
     * once each have a group 42, and they are different teams.
     */
    const a = await partner.ingestSubmission(
      payload({ externalSubmissionId: 'sub_a', groupNumber: 42 }),
    );
    const b = await partner.ingestSubmission(
      payload({ externalCohortId: OTHER, externalSubmissionId: 'sub_b', groupNumber: 42 }),
    );

    expect(a.ok && b.ok).toBe(true);
    expect(a.submissionId).not.toBe(b.submissionId);

    const { rows } = await db.query<{ n: string }>(
      'select count(distinct team_id) n from submissions where id in ($1, $2)',
      [a.submissionId, b.submissionId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('treats the same submission id in two cohorts as two submissions', async () => {
    /*
     * The reason identity is (source, cohort, submission) rather than the
     * submission id alone. If C14 ever reuses an identifier C13 issued, the
     * second must not be silently merged into the first's assessment.
     */
    const a = await partner.ingestSubmission(payload({ externalSubmissionId: 'sub_shared' }));
    const b = await partner.ingestSubmission(
      payload({ externalCohortId: OTHER, externalSubmissionId: 'sub_shared', groupNumber: 7 }),
    );

    expect(a.submissionId).not.toBe(b.submissionId);
    expect(b.duplicate).toBe(false);

    // And each reads back its own.
    const inC14 = await partner.getPartnerResult('AIAP-C14', 'sub_shared');
    const inC13 = await partner.getPartnerResult(OTHER, 'sub_shared');
    expect(inC14.found && inC13.found).toBe(true);
  });

  it('still refuses a true duplicate within one cohort', async () => {
    const first = await partner.ingestSubmission(payload({ externalSubmissionId: 'sub_dup' }));
    const second = await partner.ingestSubmission(payload({ externalSubmissionId: 'sub_dup' }));
    expect(second.submissionId).toBe(first.submissionId);
    expect(second.duplicate).toBe(true);
  });

  it('never lets a result from one cohort answer for the other', async () => {
    await partner.ingestSubmission(payload({ externalSubmissionId: 'sub_only_c14' }));

    const wrongCohort = await partner.getPartnerResult(OTHER, 'sub_only_c14');
    expect(wrongCohort.found).toBe(false);
  });

  it('ranks each cohort on its own, and keeps the Top 10 inside it', async () => {
    /*
     * The isolation that matters most. A team competes against its own cohort;
     * a C13 submission must never appear in C14's ranking or its private
     * shortlist, whatever the scores happen to be.
     */
    const ranking = buildRankingStore(db);
    const score = async (external: string, id: string, group: number, fraction: number) => {
      const ingested = await partner.ingestSubmission(
        payload({ externalCohortId: external, externalSubmissionId: id, groupNumber: group }),
      );
      const { rows } = await db.query<{ id: string }>(
        'select id from assessment_jobs where submission_id = $1',
        [ingested.submissionId],
      );
      await assessment.saveScores(
        rows[0]!.id,
        RUBRIC_CATEGORIES.map((c) => ({
          categoryKey: c.key,
          rawScore: c.maxPoints * fraction,
          maxPoints: c.maxPoints,
          weightedScore: c.maxPoints * fraction,
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
      return ingested.submissionId!;
    };

    // C13 scores higher across the board than anything in C14.
    await score(OTHER, 'c13_top', 1, 1.0);
    await score(OTHER, 'c13_low', 2, 0.9);
    await score('AIAP-C14', 'c14_top', 3, 0.5);
    await score('AIAP-C14', 'c14_low', 4, 0.4);

    const c13 = await partner.syncCohort({ externalCohortId: OTHER, name: 'Hackathon C13' });
    await ranking.generateSnapshot(c13.cohortId!, 'c13');
    await ranking.generateSnapshot(cohortId, 'c14');

    // Each cohort has its own rank 1, despite the score gap between them.
    expect((await partner.getPartnerResult(OTHER, 'c13_top')).rank).toBe(1);
    expect((await partner.getPartnerResult('AIAP-C14', 'c14_top')).rank).toBe(1);

    // And no snapshot contains a submission from the other cohort.
    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from ranking_entries e
         join ranking_snapshots s on s.id = e.snapshot_id
         join submissions sub on sub.id = e.submission_id
        where sub.cohort_id <> s.cohort_id`,
    );
    expect(Number(rows[0]!.n)).toBe(0);

    // Top 10 membership is likewise scoped.
    expect((await partner.getPartnerResult('AIAP-C14', 'c14_top')).inTopTen).toBe(true);
    expect((await partner.getPartnerResult(OTHER, 'c13_top')).inTopTen).toBe(true);
  });

  it('re-judges inside the cohort it belongs to', async () => {
    const ingested = await partner.ingestSubmission(payload({ externalSubmissionId: 'sub_rej' }));
    const { rows } = await db.query<{ cohort_id: string }>(
      'select cohort_id from assessment_jobs where submission_id = $1',
      [ingested.submissionId],
    );
    expect(rows[0]!.cohort_id).toBe(cohortId);
  });
});

describe('who may create a cohort', () => {
  it('is refused without a name, so a bare identifier cannot conjure one', async () => {
    const result = await partner.syncCohort({ externalCohortId: 'AIAP-C99', name: '' });
    expect(result.ok).toBe(false);
  });

  it('does not happen as a side effect of submitting work', async () => {
    /*
     * A mistyped cohort id in the caller's configuration would otherwise open a
     * second, empty competition and quietly put a team in it alone. It fails
     * loudly instead, naming the endpoint that would fix it.
     */
    const before = await db.query<{ n: string }>('select count(*) n from cohorts');
    const result = await partner.ingestSubmission(payload({ externalCohortId: 'AIAP-TYPO' }));
    const after = await db.query<{ n: string }>('select count(*) n from cohorts');

    expect(result.ok).toBe(false);
    expect(result.unknownCohort).toBe(true);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
