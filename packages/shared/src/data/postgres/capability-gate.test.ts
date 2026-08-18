import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { composePostgresDataStore } from './store';
import { createInMemoryStorage } from './storage';
import { storeCapabilities } from './store';
import {
  FeatureUnavailableError,
  unavailableAssessmentStore,
  unavailableRankingStore,
} from './unavailable';
import { bootstrapProduction } from './bootstrap';
import type { AssessmentConfig } from '../types';

/**
 * The capability gate, as the admin surface actually uses it.
 *
 * This exists because of a real failure: `/admin` crashed on the first
 * production login with `FeatureUnavailableError: … called getQueueStats`. The
 * page had a guard for "no cohort" but none for "no judging", so as soon as a
 * cohort existed it walked straight into a gated repository.
 *
 * The lesson was not "add a check to that page" — it was that every surface
 * reading assessment or ranking has to decide what to show when they are
 * absent. These tests assert the contract each of those surfaces relies on.
 *
 * Judging is now implemented, so the production store declares both
 * capabilities. The gate itself still ships and still matters: it is what a
 * deployment falls back to if a repository is ever unavailable again, and every
 * call site still checks it. So the gated behaviour is tested against a store
 * composed with the unavailable repositories, and the real store is tested for
 * what it now actually does. Deleting these with the capability flip would
 * throw away the guard that the crash produced.
 */

let db: PgliteHandle;

const CREDENTIAL_KEY = randomBytes(32).toString('base64');
const CONFIG = {
  sessionSecret: 'test',
  credentialKey: CREDENTIAL_KEY,
  credentialKeyVersion: 1,
};

const ASSESSMENT_CONFIG: AssessmentConfig = {
  workerConcurrency: 4,
  browserBudgetMs: 480_000,
  maxAttempts: 3,
  retryBackoffMs: 60_000,
  gracePeriodMs: 3_600_000,
  consistencyTopN: 20,
  lowConfidenceThreshold: 0.6,
  modelVersion: 'test',
  promptVersion: 'test',
};

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
});

function productionStore() {
  return composePostgresDataStore(db, createInMemoryStorage(), CONFIG);
}

/** The same store as production, with judging gated off — the pre-Phase-B shape. */
function gatedStore() {
  return {
    ...composePostgresDataStore(db, createInMemoryStorage(), CONFIG),
    assessment: unavailableAssessmentStore(),
    ranking: unavailableRankingStore(),
    capabilities: { assessment: false, ranking: false },
  };
}

/** Bootstrap, then one open cohort — the exact state that crashed. */
async function bootstrappedWithCohort(store = productionStore()) {
  await bootstrapProduction(db, { adminUsername: 'ops', adminPassword: 'a-real-password-here' });

  const cohort = await store.cohorts.createCohort({
    name: 'PRODUCTION TEST',
    code: 'PROD1',
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: new Date(Date.now() - 86_400_000),
    day13DeadlineAt: new Date(Date.now() + 86_400_000),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: 'rubric-v1',
    assessmentConfig: ASSESSMENT_CONFIG,
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
  });
  await store.cohorts.setCohortStatus(cohort.id, 'open');
  return { store, cohort };
}

describe('a deployment with judging unavailable', () => {
  it('declares both capabilities as false', () => {
    expect(storeCapabilities(gatedStore())).toEqual({ assessment: false, ranking: false });
  });

  it('serves everything the admin overview needs WITHOUT touching judging', async () => {
    // This is the regression. With a cohort present the overview reads
    // submissions, teams and ideas — all of which must work — and must not
    // reach getQueueStats.
    const { store, cohort } = await bootstrappedWithCohort();

    await expect(store.submissions.listSubmissions(cohort.id)).resolves.toEqual([]);
    await expect(store.teams.listTeams(cohort.id)).resolves.toEqual([]);
    await expect(store.cohorts.listIdeas(cohort.id)).resolves.toEqual([]);
    await expect(store.cohorts.listCohorts()).resolves.toHaveLength(1);
    await expect(store.adminAuth.getAdminAccount()).resolves.not.toBeNull();
  });

  it('throws for every read the overview must therefore skip', async () => {
    const { store, cohort } = await bootstrappedWithCohort(gatedStore());

    // Exactly the five calls the overview used to make unconditionally.
    expect(() => store.assessment.getQueueStats(cohort.id)).toThrow(FeatureUnavailableError);
    expect(() => store.ranking.getCurrentSnapshot(cohort.id)).toThrow(FeatureUnavailableError);
    expect(() => store.assessment.listManualReviewFlags(cohort.id)).toThrow(FeatureUnavailableError);
    expect(() => store.assessment.listDisqualifications(cohort.id)).toThrow(FeatureUnavailableError);
    expect(() => store.ranking.listFinalSelections(cohort.id)).toThrow(FeatureUnavailableError);
  });

  it('names getQueueStats in the error, which is what identified the crash', async () => {
    // The digest in the browser was opaque; the server log named the method.
    const { store, cohort } = await bootstrappedWithCohort(gatedStore());
    try {
      store.assessment.getQueueStats(cohort.id);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('getQueueStats');
      expect((error as Error).message).toMatch(/stored safely/i);
    }
  });

  it('leaves the submission platform completely usable', async () => {
    // The point of shipping Phase A without Phase B: an operator can run a
    // cohort end to end and teams can submit.
    const { store, cohort } = await bootstrappedWithCohort();

    const imported = await store.teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'Lead', leadEmail: 'lead@example.invalid', leadPhone: '' },
    ]);
    expect(imported.created).toHaveLength(1);

    const codes = await store.teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
    expect(codes).toHaveLength(1);

    const verified = await store.participant.verifyTeamAccess({
      groupNumber: 1,
      code: codes[0]!.code,
      ipHash: 'ip',
    });
    expect(verified.ok).toBe(true);

    if (!verified.ok) throw new Error('unreachable');
    const session = await store.participant.createSession({
      teamId: verified.teamId,
      editorName: 'Priya',
      editorRole: null,
      ipHash: null,
    });
    const view = await store.participant.resolveSession(session.token);
    expect(view?.canEdit).toBe(true);
  });

  it('shows no rank or score on a submission, rather than failing to list it', async () => {
    // The admin submission list left-joins the assessment tables, so it works
    // with judging absent — this is why it needs no gate.
    const { store, cohort } = await bootstrappedWithCohort();
    await store.teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'Lead', leadEmail: 'l@example.invalid', leadPhone: '' },
    ]);
    const codes = await store.teams.generateAccessCodes({ cohortId: cohort.id, regenerate: false });
    const verified = await store.participant.verifyTeamAccess({
      groupNumber: 1,
      code: codes[0]!.code,
      ipHash: 'ip',
    });
    if (!verified.ok) throw new Error('unreachable');
    const session = await store.participant.createSession({
      teamId: verified.teamId,
      editorName: 'Priya',
      editorRole: null,
      ipHash: null,
    });
    const view = await store.participant.resolveSession(session.token);

    const list = await store.submissions.listSubmissions(cohort.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.totalScore).toBeNull();
    expect(list[0]?.rank).toBeNull();
    expect(list[0]?.stage).toBeNull();
    expect(list[0]?.inShortlist).toBe(false);

    const detail = await store.submissions.getSubmissionDetail(view!.submission.id);
    expect(detail).not.toBeNull();
    expect(detail?.job).toBeNull();
    expect(detail?.scores).toEqual([]);
    expect(detail?.rank).toBeNull();
  });

  it('never reports a score of zero, which would read as "assessed badly"', async () => {
    const { store, cohort } = await bootstrappedWithCohort();
    await store.teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'L', leadEmail: 'l@example.invalid', leadPhone: '' },
    ]);
    const list = await store.submissions.listSubmissions(cohort.id);
    for (const item of list) {
      expect(item.totalScore).not.toBe(0);
      expect(item.rank).not.toBe(0);
    }
  });
});

describe('the gate cannot be silently bypassed', () => {
  it('covers every assessment and ranking method', () => {
    const store = gatedStore();
    expect(Object.keys(store.assessment)).toHaveLength(35);
    expect(Object.keys(store.ranking)).toHaveLength(6);

    // A method missing from the unavailable list would be `undefined` and throw
    // a confusing TypeError instead of a clear one.
    for (const [name, value] of Object.entries(store.assessment)) {
      expect(typeof value, `assessment.${name}`).toBe('function');
    }
    for (const [name, value] of Object.entries(store.ranking)) {
      expect(typeof value, `ranking.${name}`).toBe('function');
    }
  });

  it('reports full capability for a driver that does not declare any', () => {
    // The memory driver implements all 115, so demo mode is unaffected.
    const undeclared = { driver: 'memory' } as never;
    expect(storeCapabilities(undeclared)).toEqual({ assessment: true, ranking: true });
  });
});

describe('this deployment, with judging implemented', () => {
  it('declares both capabilities as true', () => {
    expect(storeCapabilities(productionStore())).toEqual({ assessment: true, ranking: true });
  });

  it('answers the reads that used to throw', async () => {
    // The five calls the overview makes. Real answers now, not errors — and
    // not invented ones either: an empty cohort genuinely has an empty queue.
    const { store, cohort } = await bootstrappedWithCohort();

    const stats = await store.assessment.getQueueStats(cohort.id);
    expect(stats.total).toBe(0);
    expect(stats.projectedCompletionAt).toBeNull();

    await expect(store.ranking.getCurrentSnapshot(cohort.id)).resolves.toBeNull();
    await expect(store.assessment.listManualReviewFlags(cohort.id)).resolves.toEqual([]);
    await expect(store.assessment.listDisqualifications(cohort.id)).resolves.toEqual([]);
    await expect(store.ranking.listFinalSelections(cohort.id)).resolves.toEqual([]);
  });

  it('still reports no score for an unassessed submission', async () => {
    // The capability being available must not make an unjudged submission look
    // judged. Nothing has run yet, so there is nothing to show.
    const { store, cohort } = await bootstrappedWithCohort();
    await store.teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'L', leadEmail: 'l@example.invalid', leadPhone: '' },
    ]);

    const list = await store.submissions.listSubmissions(cohort.id);
    for (const item of list) {
      expect(item.totalScore).toBeNull();
      expect(item.rank).toBeNull();
    }
  });
});
