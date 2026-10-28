import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from '../data/postgres/testing/pglite';
import { composePostgresDataStore } from '../data/postgres/store';
import { createInMemoryStorage } from '../data/postgres/storage';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../rubric/index';
import { SHEET_HEADERS } from './sheet-rows';
import { syncSheet, type SheetSource, type SyncReport } from './sheet-sync';
import { buildSubmissionsAuditCsv } from '../domain/submission-audit';
import { buildResultsFeedbackCsv } from '../domain/results-export';
import type { DataStore } from '../data/store';
import type { CategoryScore, Cohort } from '../data/types';

/**
 * Two cohorts, two tabs, one spreadsheet, one worker (0016 / ADR-035).
 *
 * AIAP C15 IST and AIAP C15 EST both hold a Group 12. Each must import only
 * from its own tab into its own cohort, be judged only when its own operator
 * says so, and rank, review, export and crown winners without the other ever
 * appearing. The scenarios are the ones the brief names, A to L, against real
 * tables: this is the isolation the Judge promises, not the UI around it.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SPREADSHEET = 'sheet-hackathon-group-allocator-0001';
const IST = { external: 'AIAP-C15-IST', tab: 'Submissions - AIAP C15 IST', name: 'AIAP C15 IST', code: 'C15IST', zone: 'Asia/Kolkata' };
const EST = { external: 'AIAP-C15-EST', tab: 'Submissions - AIAP C15 EST', name: 'AIAP C15 EST', code: 'C15EST', zone: 'America/New_York' };

let db: PgliteHandle;
let store: DataStore;
let ist: Cohort;
let est: Cohort;

const cell: Record<string, string> = {
  Timestamp: '2026-10-30 09:30:00',
  'Group Number': '12',
  Category: 'Expense Tracker',
  'Product Name': 'SpendWise',
  'Team Leader': 'Priya Sharma',
  'Team Members': 'Priya Sharma, Rahul Nair',
  'Primary Contact': 'priya@example.invalid',
  'MVP/Product Link': 'https://spendwise.example.com',
  Access: 'Open Access',
  'Login Email': '',
  'Login Password': '',
  'Brief Description': 'Shows where your money goes.',
  'Main User Action': 'Add expenses and see where most of the money went.',
  'How AI Helps': 'It categorises each expense automatically.',
  'What We Got Working': 'Adding expenses and the monthly chart.',
  'Loom Video Link': 'https://loom.com/share/abc',
  'Final Deck Link': 'https://docs.google.com/presentation/d/abc',
};
const rows = (overrides: Record<string, string>[]) => [
  [...SHEET_HEADERS],
  ...overrides.map((o) => SHEET_HEADERS.map((h) => ({ ...cell, ...o })[h] ?? '')),
];
const tabSource = (tab: string, data: string[][]): SheetSource => ({
  read: async () => data,
  describe: () => ({ kind: 'google_sheets', spreadsheetId: SPREADSHEET, tabName: tab }),
});

const istRows = rows([
  { 'Group Number': '12', 'Product Name': 'SpendWise IST', 'MVP/Product Link': 'https://ist-12.example.com' },
  { 'Group Number': '13', 'Product Name': 'Budgeteer IST', 'MVP/Product Link': 'https://ist-13.example.com' },
]);
const estRows = rows([
  { 'Group Number': '12', 'Product Name': 'SpendWise EST', 'MVP/Product Link': 'https://est-12.example.com', Timestamp: '2026-10-30 19:30:00' },
]);

async function makeCohort(spec: typeof IST): Promise<Cohort> {
  const created = await store.cohorts.createCohort({
    name: spec.name,
    code: spec.code,
    description: '',
    timezone: spec.zone,
    day12StartAt: new Date('2026-10-28T00:00:00Z'),
    day13DeadlineAt: new Date('2026-10-30T04:30:00Z'),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: RUBRIC_VERSION,
    assessmentConfig: {
      workerConcurrency: 1,
      browserBudgetMs: 480_000,
      maxAttempts: 3,
      retryBackoffMs: 60_000,
      gracePeriodMs: 3_600_000,
      consistencyTopN: 20,
      lowConfidenceThreshold: 0.6,
      modelVersion: 'test',
      promptVersion: 'test',
    },
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
    finalSelectionTarget: 3,
    intakeMode: 'sheet',
  });
  const bound = await store.cohorts.updateCohortIntake(created.id, {
    intakeMode: 'sheet',
    externalCohortId: spec.external,
    intakeTabName: spec.tab,
    intakeTimezone: spec.zone,
  });
  await db.query(
    `insert into cohort_ideas (cohort_id, slug, title, description, target_user, expected_use_case,
       minimum_core_flow, expected_entities, is_active, definition_status)
     values ($1, 'expense-tracker', 'Expense Tracker', 'd', 'u', 'c', '["s"]'::jsonb, '{"e"}', true, 'approved')`,
    [bound.id],
  );
  return bound;
}

const sync = (cohort: Cohort, source: SheetSource, dryRun: boolean, expectedFingerprint?: string) =>
  syncSheet({
    store,
    source,
    cohortId: cohort.id,
    externalCohortId: cohort.externalCohortId!,
    cohortName: cohort.name,
    sourceTimezone: cohort.intakeTimezone ?? cohort.timezone,
    dryRun,
    ...(expectedFingerprint ? { expectedFingerprint } : {}),
  });

async function importBoth(): Promise<{ istReport: SyncReport; estReport: SyncReport }> {
  const istDry = await sync(ist, tabSource(IST.tab, istRows), true);
  const istReport = await sync(ist, tabSource(IST.tab, istRows), false, istDry.fingerprint);
  const estDry = await sync(est, tabSource(EST.tab, estRows), true);
  const estReport = await sync(est, tabSource(EST.tab, estRows), false, estDry.fingerprint);
  return { istReport, estReport };
}

async function submissionsOf(cohortId: string) {
  return (
    await db.query<{ id: string; group_number: number; product_name: string; cohort_id: string }>(
      `select s.id, t.group_number, s.product_name, s.cohort_id from submissions s join teams t on t.id = s.team_id
        where s.cohort_id = $1 order by t.group_number`,
      [cohortId],
    )
  ).rows;
}

async function score(submissionId: string, total: number) {
  const job = await store.assessment.getJobBySubmission(submissionId);
  if (!job) throw new Error('no job');
  const share = total / 100;
  await store.assessment.saveScores(
    job.id,
    RUBRIC_CATEGORIES.map((category) => ({
      categoryKey: category.key,
      rawScore: category.maxPoints * share,
      maxPoints: category.maxPoints,
      weightedScore: category.maxPoints * share,
      confidence: 0.8,
      rationale: 'Observed.',
      supportingEvidence: ['step 1'],
      contradictoryEvidence: [],
      missingEvidence: [],
      isOverridden: false,
      overrideReason: null,
      overriddenBy: null,
      overriddenAt: null,
      originalRawScore: null,
      modelVersion: 'test',
      promptVersion: 'test',
      rubricVersion: RUBRIC_VERSION,
    })) as Omit<CategoryScore, 'id' | 'jobId' | 'createdAt' | 'updatedAt'>[],
  );
  await store.assessment.saveSummary({
    jobId: job.id,
    totalScore: total,
    meanConfidence: 0.8,
    minConfidence: 0.8,
    lowConfidence: false,
    risks: [],
    strengths: [],
    weaknesses: [],
    internalNotes: null,
    bugsFound: [],
    modelVersion: 'test',
    promptVersion: 'test',
    completedAt: new Date(),
  });
  await db.query(`update assessment_jobs set stage = 'completed', claimed_by = null, lease_expires_at = null where id = $1`, [job.id]);
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(`insert into rubric_versions (version, name, is_active) values ($1, 'Test', true)`, [RUBRIC_VERSION]);
  store = composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: 's'.repeat(48),
    credentialKey: KEY,
    credentialKeyVersion: 1,
  });
  ist = await makeCohort(IST);
  est = await makeCohort(EST);
});

describe('intake isolation', () => {
  it('A: Group 12 exists in both tabs and imports into both cohorts as different teams', async () => {
    const { istReport, estReport } = await importBoth();
    expect(istReport.fatalError).toBeUndefined();
    expect(estReport.fatalError).toBeUndefined();
    expect(istReport.judgeCohortId).toBe(ist.id);
    expect(estReport.judgeCohortId).toBe(est.id);
    expect(istReport.newSubmissions).toBe(2);
    expect(estReport.newSubmissions).toBe(1);

    const istSubs = await submissionsOf(ist.id);
    const estSubs = await submissionsOf(est.id);
    expect(istSubs.map((s) => `${s.group_number}:${s.product_name}`)).toEqual(['12:SpendWise IST', '13:Budgeteer IST']);
    expect(estSubs.map((s) => `${s.group_number}:${s.product_name}`)).toEqual(['12:SpendWise EST']);
    expect(new Set([...istSubs, ...estSubs].map((s) => s.id)).size).toBe(3);

    const teams = await db.query<{ cohort_id: string; group_number: number }>(`select cohort_id, group_number from teams where group_number = 12`);
    expect(teams.rows.map((t) => t.cohort_id).sort()).toEqual([ist.id, est.id].sort());
    const jobs = await db.query<{ cohort_id: string; n: string }>(`select cohort_id, count(*)::text as n from assessment_jobs group by 1`);
    expect(Object.fromEntries(jobs.rows.map((j) => [j.cohort_id, j.n]))).toEqual({ [ist.id]: '2', [est.id]: '1' });
    expect((await db.query(`select count(*)::int as n from cohorts`)).rows[0]).toEqual({ n: 2 });
  });

  it('B: a dry run of IST reads only the IST tab and writes nothing', async () => {
    const report = await sync(ist, tabSource(IST.tab, istRows), true);
    expect(report.dryRun).toBe(true);
    expect(report.tabName).toBe(IST.tab);
    expect(report.externalCohortId).toBe(IST.external);
    expect(report.rowsRead).toBe(2);
    expect(report.groups.map((g) => g.groupNumber)).toEqual([12, 13]);
    expect((await db.query(`select count(*)::int as n from submissions`)).rows[0]).toEqual({ n: 0 });
    expect((await db.query(`select count(*)::int as n from assessment_jobs`)).rows[0]).toEqual({ n: 0 });
  });

  it('C: an IST fingerprint never authorises an EST import, even for identical rows', async () => {
    const same = rows([{ 'Group Number': '12' }]);
    const istDry = await sync(ist, tabSource(IST.tab, same), true);
    const estDry = await sync(est, tabSource(EST.tab, same), true);
    expect(istDry.fingerprint).not.toBe(estDry.fingerprint);

    const refused = await sync(est, tabSource(EST.tab, same), false, istDry.fingerprint);
    expect(refused.fatalError).toMatch(/changed since the last Dry Run/i);
    expect((await db.query(`select count(*)::int as n from submissions`)).rows[0]).toEqual({ n: 0 });

    // The same tab with edited rows is refused too.
    const edited = rows([{ 'Group Number': '12', 'MVP/Product Link': 'https://moved.example.com' }]);
    expect((await sync(est, tabSource(EST.tab, edited), false, estDry.fingerprint)).fatalError).toMatch(/changed since/i);
    // The right fingerprint for the right cohort and tab imports.
    expect((await sync(est, tabSource(EST.tab, same), false, estDry.fingerprint)).newSubmissions).toBe(1);
  });

  it('refuses a selected cohort whose external id maps elsewhere, and never creates a cohort', async () => {
    const wrong = await syncSheet({
      store,
      source: tabSource(EST.tab, estRows),
      cohortId: ist.id,
      externalCohortId: EST.external,
      cohortName: 'whatever',
      dryRun: true,
    });
    expect(wrong.fatalError).toMatch(/mapped to cohort "AIAP C15 EST", not to the selected cohort "AIAP C15 IST"/);

    const unmapped = await syncSheet({
      store,
      source: tabSource('Submissions - AIAP C16 IST', estRows),
      cohortId: ist.id,
      externalCohortId: 'AIAP-C16-IST',
      cohortName: 'whatever',
      dryRun: false,
    });
    expect(unmapped.fatalError).toMatch(/No cohort is mapped to external cohort ID "AIAP-C16-IST"/);
    expect((await db.query(`select count(*)::int as n from cohorts`)).rows[0]).toEqual({ n: 2 });
  });

  it('refuses to import into a cohort with no approved ideas, but still checks', async () => {
    await db.query(`update cohort_ideas set definition_status = 'draft' where cohort_id = $1`, [est.id]);
    const dry = await sync(est, tabSource(EST.tab, estRows), true);
    expect(dry.fatalError).toBeUndefined();
    const imported = await sync(est, tabSource(EST.tab, estRows), false, dry.fingerprint);
    expect(imported.fatalError).toMatch(/no approved ideas/);
    expect((await db.query(`select count(*)::int as n from submissions`)).rows[0]).toEqual({ n: 0 });
  });

  it('reads each tab\'s timestamps in that cohort\'s configured zone', async () => {
    await importBoth();
    const at = await db.query<{ name: string; submitted_at: string }>(
      `select s.product_name as name, s.submitted_at from submissions s order by s.product_name`,
    );
    const by = Object.fromEntries(at.rows.map((r) => [r.name, new Date(r.submitted_at).toISOString()]));
    expect(by['SpendWise IST']).toBe('2026-10-30T04:00:00.000Z'); // 09:30 IST
    expect(by['SpendWise EST']).toBe('2026-10-30T23:30:00.000Z'); // 19:30 EDT
  });
});

describe('manual judging control', () => {
  it('D: after importing both, starting only IST lets the worker claim IST and nothing else', async () => {
    await importBoth();
    await store.cohorts.setCohortStatus(ist.id, 'closed');
    await store.cohorts.setCohortStatus(est.id, 'closed');
    expect(await store.assessment.claimJobs({ workerId: 'w1', limit: 10, leaseSeconds: 60 })).toHaveLength(0);

    await store.cohorts.setCohortStatus(ist.id, 'judging');
    const claimed = await store.assessment.claimJobs({ workerId: 'w1', limit: 10, leaseSeconds: 60 });
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((j) => j.cohortId))).toEqual(new Set([ist.id]));
    // EST's job is untouched: unclaimed, still queued.
    const estJob = (await db.query<{ stage: string; claimed_by: string | null }>(`select stage::text, claimed_by from assessment_jobs where cohort_id = $1`, [est.id])).rows[0]!;
    expect(estJob).toEqual({ stage: 'queued', claimed_by: null });
  });

  it('E: starting EST while IST is judging makes EST eligible without touching IST', async () => {
    await importBoth();
    await store.cohorts.setCohortStatus(ist.id, 'closed');
    await store.cohorts.setCohortStatus(est.id, 'closed');
    await store.cohorts.setCohortStatus(ist.id, 'judging');
    const istClaimed = await store.assessment.claimJobs({ workerId: 'w1', limit: 10, leaseSeconds: 60 });
    expect(istClaimed).toHaveLength(2);
    const istBefore = (await db.query(`select id, stage::text, claimed_by, attempt_count from assessment_jobs where cohort_id = $1 order by id`, [ist.id])).rows;

    await store.cohorts.setCohortStatus(est.id, 'judging');
    const estClaimed = await store.assessment.claimJobs({ workerId: 'w2', limit: 10, leaseSeconds: 60 });
    expect(estClaimed.map((j) => j.cohortId)).toEqual([est.id]);

    const istAfter = (await db.query(`select id, stage::text, claimed_by, attempt_count from assessment_jobs where cohort_id = $1 order by id`, [ist.id])).rows;
    expect(istAfter).toEqual(istBefore);
  });

  it('a deadline that has passed does not start judging, and judging is per cohort', async () => {
    await importBoth();
    // Both deadlines are in the past relative to the fixture rows; neither
    // cohort was started, so neither is claimable.
    expect(await store.assessment.claimJobs({ workerId: 'w', limit: 10, leaseSeconds: 60 })).toHaveLength(0);
  });
});

describe('results isolation', () => {
  async function judgeBoth() {
    await importBoth();
    await store.cohorts.setCohortStatus(ist.id, 'closed');
    await store.cohorts.setCohortStatus(est.id, 'closed');
    await store.cohorts.setCohortStatus(ist.id, 'judging');
    await store.cohorts.setCohortStatus(est.id, 'judging');
    const istSubs = await submissionsOf(ist.id);
    const estSubs = await submissionsOf(est.id);
    await score(istSubs[0]!.id, 80);
    await score(istSubs[1]!.id, 70);
    await score(estSubs[0]!.id, 90);
    return { istSubs, estSubs };
  }

  it('F and G: each ranking holds only its own cohort\'s scores', async () => {
    const { istSubs, estSubs } = await judgeBoth();
    const istSnap = await store.ranking.generateSnapshot(ist.id, 'ist');
    const estSnap = await store.ranking.generateSnapshot(est.id, 'est');
    expect(istSnap.eligibleCount).toBe(2);
    expect(estSnap.eligibleCount).toBe(1);
    const istCurrent = await store.ranking.getCurrentSnapshot(ist.id);
    const estCurrent = await store.ranking.getCurrentSnapshot(est.id);
    expect(istCurrent!.entries.map((e) => e.submissionId).sort()).toEqual(istSubs.map((s) => s.id).sort());
    expect(estCurrent!.entries.map((e) => e.submissionId)).toEqual([estSubs[0]!.id]);
    // The EST 90 never outranks anything in IST.
    expect(istCurrent!.entries.map((e) => e.entry.totalScore)).toEqual([80, 70]);
  });

  it('H: IST exports contain no EST submission, and vice versa', async () => {
    const { istSubs, estSubs } = await judgeBoth();
    await store.ranking.generateSnapshot(ist.id, 'ist');
    await store.ranking.generateSnapshot(est.id, 'est');
    const istRanked = await store.ranking.listRankedResults(ist.id);
    const istAudit = await store.ranking.listSubmissionAudit(ist.id);
    const estRanked = await store.ranking.listRankedResults(est.id);
    expect(istRanked.map((r) => r.submissionId).sort()).toEqual(istSubs.map((s) => s.id).sort());
    expect(istAudit.map((r) => r.submissionId).sort()).toEqual(istSubs.map((s) => s.id).sort());
    expect(estRanked.map((r) => r.submissionId)).toEqual([estSubs[0]!.id]);
    const istCsv = buildResultsFeedbackCsv(istRanked) + buildSubmissionsAuditCsv(istAudit);
    expect(istCsv).toContain('AIAP C15 IST');
    expect(istCsv).not.toContain('AIAP C15 EST');
    expect(istCsv).not.toContain('SpendWise EST');
    expect(istCsv).not.toContain(estSubs[0]!.id);
    // Group 12 appears in each file exactly once, as a different product.
    expect(buildSubmissionsAuditCsv(istAudit)).toContain('SpendWise IST');
    expect(buildSubmissionsAuditCsv(await store.ranking.listSubmissionAudit(est.id))).toContain('SpendWise EST');
    // Feedback coverage is per cohort too.
    expect((await store.assessment.getFeedbackCoverage(ist.id)).completed).toBe(2);
    expect((await store.assessment.getFeedbackCoverage(est.id)).completed).toBe(1);
  });

  it('I: an IST Top 3 changes no EST final selection', async () => {
    const { istSubs } = await judgeBoth();
    await store.ranking.generateSnapshot(ist.id, 'ist');
    await store.ranking.generateSnapshot(est.id, 'est');
    await store.cohorts.updateCohort(ist.id, { finalSelectionTarget: 2 });
    await store.ranking.setFinalSelection(
      ist.id,
      istSubs.map((s, i) => ({ submissionId: s.id, position: i + 1, reason: `Winner ${i + 1}` })),
      'shared-admin',
    );
    expect(await store.ranking.listFinalSelections(ist.id)).toHaveLength(2);
    expect(await store.ranking.listFinalSelections(est.id)).toHaveLength(0);
    // And an EST selection cannot name an IST submission.
    await store.cohorts.updateCohort(est.id, { finalSelectionTarget: 1 });
    await expect(
      store.ranking.setFinalSelection(est.id, [{ submissionId: istSubs[0]!.id, position: 1, reason: 'wrong cohort' }], 'shared-admin'),
    ).rejects.toThrow();
    expect(await store.ranking.listFinalSelections(est.id)).toHaveLength(0);
  });

  it('K: review flags and retries stay inside their cohort', async () => {
    const { istSubs, estSubs } = await judgeBoth();
    await store.assessment.raiseManualReview({
      submissionId: istSubs[0]!.id,
      reasonCode: 'low_confidence_scores',
      detail: 'thin evidence',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });
    expect((await store.assessment.listManualReviewFlags(ist.id)).map((f) => f.submissionId)).toEqual([istSubs[0]!.id]);
    expect(await store.assessment.listManualReviewFlags(est.id)).toEqual([]);
    // Re-queueing an IST product creates no EST work.
    await store.assessment.enqueueSubmission(istSubs[1]!.id);
    const estJobs = (await db.query<{ stage: string }>(`select stage::text from assessment_jobs where cohort_id = $1`, [est.id])).rows;
    expect(estJobs).toEqual([{ stage: 'completed' }]);
    expect(await store.assessment.getJobBySubmission(estSubs[0]!.id)).toMatchObject({ stage: 'completed' });
  });

  it('L: a cohort mapped the pre-0016 way (partner sync, no selected cohort) still imports and ranks', async () => {
    const legacy = await store.partner!.syncCohort({ externalCohortId: 'AIAP-C14', name: 'AIAP C14' });
    expect(legacy.ok).toBe(true);
    await db.query(
      `insert into cohort_ideas (cohort_id, slug, title, description, target_user, expected_use_case,
         minimum_core_flow, expected_entities, is_active, definition_status)
       values ($1, 'expense-tracker', 'Expense Tracker', 'd', 'u', 'c', '["s"]'::jsonb, '{"e"}', true, 'approved')`,
      [legacy.cohortId],
    );
    const c14 = await store.cohorts.getCohort(legacy.cohortId!);
    expect(c14?.intakeMode).toBe('sheet');
    const dry = await syncSheet({ store, source: tabSource('Submissions - AIAP C14', istRows), externalCohortId: 'AIAP-C14', cohortName: 'AIAP C14', dryRun: true });
    const done = await syncSheet({ store, source: tabSource('Submissions - AIAP C14', istRows), externalCohortId: 'AIAP-C14', cohortName: 'AIAP C14', dryRun: false, expectedFingerprint: dry.fingerprint });
    expect(done.fatalError).toBeUndefined();
    expect(done.newSubmissions).toBe(2);
    expect((await submissionsOf(legacy.cohortId!)).map((s) => s.group_number)).toEqual([12, 13]);
    // The IST and EST cohorts are untouched by it.
    expect(await submissionsOf(ist.id)).toEqual([]);
    expect(await submissionsOf(est.id)).toEqual([]);
  });
});
