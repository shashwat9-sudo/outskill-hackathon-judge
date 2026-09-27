import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { bootstrapProduction, seedIdeaCatalogue } from './bootstrap';
import { composePostgresDataStore } from './store';
import { createInMemoryStorage } from './storage';
import {
  FeatureUnavailableError,
  unavailableAssessmentStore,
  unavailableRankingStore,
} from './unavailable';
import { verifyPassword } from '../../security/password';

/**
 * Production bootstrap and store composition.
 *
 * Bootstrap runs on every start, so the assertions are mostly about running it
 * twice: a restart mid-hackathon must not reset the admin password, duplicate
 * the rubric, or undo an operator's setting.
 */

let db: PgliteHandle;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
});

const INPUT = { adminUsername: 'ops', adminPassword: 'a-real-production-password' };

describe('bootstrap', () => {
  it('creates the admin, rubric and settings on a fresh database', async () => {
    const report = await bootstrapProduction(db, INPUT);

    expect(report.adminCreated).toBe(true);
    expect(report.rubricCreated).toBe(true);
    expect(report.rubricCategories).toBeGreaterThan(0);
    expect(report.settingsCreated).toBe(3);
    expect(report.alreadyBootstrapped).toBe(false);
  });

  it('stores the admin password as an Argon2id hash that verifies', async () => {
    await bootstrapProduction(db, INPUT);
    const { rows } = await db.query<{ password_hash: string; username: string }>(
      'select username, password_hash from admin_account',
    );

    expect(rows[0]?.username).toBe('ops');
    expect(rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(rows[0]?.password_hash).not.toContain('a-real-production-password');
    expect(await verifyPassword('a-real-production-password', rows[0]!.password_hash)).toBe(true);
  });

  it('is idempotent — a second run changes nothing', async () => {
    await bootstrapProduction(db, INPUT);
    const second = await bootstrapProduction(db, INPUT);

    expect(second.adminCreated).toBe(false);
    expect(second.rubricCreated).toBe(false);
    expect(second.rubricCategories).toBe(0);
    expect(second.settingsCreated).toBe(0);
    expect(second.alreadyBootstrapped).toBe(true);
  });

  it('never resets a password that is already in use', async () => {
    // The failure this prevents: a redeploy silently changing the credential
    // the team is signed in with, mid-hackathon.
    await bootstrapProduction(db, INPUT);
    await bootstrapProduction(db, { adminUsername: 'someone-else', adminPassword: 'different' });

    const { rows } = await db.query<{ username: string; password_hash: string }>(
      'select username, password_hash from admin_account',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('ops');
    expect(await verifyPassword('a-real-production-password', rows[0]!.password_hash)).toBe(true);
  });

  it('does not duplicate rubric categories on a second run', async () => {
    await bootstrapProduction(db, INPUT);
    await bootstrapProduction(db, INPUT);

    const { rows } = await db.query<{ n: number; total: number }>(
      'select count(*)::int as n, sum(max_points)::int as total from rubric_categories',
    );
    expect(rows[0]?.total).toBe(100);
  });

  it('stores only the public rubric description, never the private guidance', async () => {
    // Scoring guidance stays in the code. A table it reached is a table an
    // export could reach (ADR-011).
    await bootstrapProduction(db, INPUT);
    const { rows } = await db.query<{ description: string }>(
      'select description from rubric_categories',
    );
    for (const row of rows) {
      expect(row.description.toLowerCase()).not.toContain('reward');
      expect(row.description.toLowerCase()).not.toContain('caps this category');
    }
  });

  it('does not overwrite a setting an operator has changed', async () => {
    await bootstrapProduction(db, INPUT);
    await db.query(`update system_settings set value = 'true'::jsonb where key = 'judging.enabled'`);
    await bootstrapProduction(db, INPUT);

    const { rows } = await db.query<{ value: unknown }>(
      `select value from system_settings where key = 'judging.enabled'`,
    );
    expect(rows[0]?.value).toBe(true);
  });

  it('leaves judging disabled by default', async () => {
    await bootstrapProduction(db, INPUT);
    const { rows } = await db.query<{ value: unknown }>(
      `select value from system_settings where key = 'judging.enabled'`,
    );
    expect(rows[0]?.value).toBe(false);
  });

  it('creates no cohort, team, submission, score or ranking', async () => {
    // The whole point: synthetic rows on a production database eventually get
    // mistaken for genuine ones.
    await bootstrapProduction(db, INPUT);

    for (const table of [
      'cohorts',
      'teams',
      'team_members',
      'submissions',
      'assessment_jobs',
      'category_scores',
      'ranking_snapshots',
      'ranking_entries',
      'final_selections',
      'team_access_codes',
    ]) {
      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      expect(rows[0]?.n, `${table} should be empty`).toBe(0);
    }
  });
});

describe('the idea catalogue', () => {
  async function cohort() {
    await bootstrapProduction(db, INPUT);
    const { rows } = await db.query<{ id: string }>(
      `insert into cohorts
         (name, code, timezone, day12_start_at, day13_deadline_at, shortlist_target,
          rubric_version_id, assessment_config)
       values ('C', 'C1', 'Asia/Kolkata', now(), now() + interval '1 day', 10,
               (select id from rubric_versions limit 1), '{}'::jsonb)
       returning id`,
    );
    return rows[0]!.id;
  }

  it('seeds every approved idea as a draft definition', async () => {
    const cohortId = await cohort();
    const created = await seedIdeaCatalogue(db, cohortId);
    expect(created).toBeGreaterThan(0);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from cohort_ideas
        where cohort_id = $1 and definition_status = 'draft'`,
      [cohortId],
    );
    expect(rows[0]?.n).toBe(created);
  });

  it('does not duplicate on a second run', async () => {
    const cohortId = await cohort();
    const first = await seedIdeaCatalogue(db, cohortId);
    expect(await seedIdeaCatalogue(db, cohortId)).toBe(0);

    const { rows } = await db.query<{ n: number }>(
      'select count(*)::int as n from cohort_ideas where cohort_id = $1',
      [cohortId],
    );
    expect(rows[0]?.n).toBe(first);
  });
});

describe('store composition', () => {
  const config = {
    sessionSecret: 'test',
    credentialKey: randomBytes(32).toString('base64'),
    credentialKeyVersion: 1,
  };

  it('reports itself as the postgres driver', () => {
    const store = composePostgresDataStore(db, createInMemoryStorage(), config);
    expect(store.driver).toBe('postgres');
  });

  it('declares what it can do, which now includes judging', () => {
    // Was { assessment: false, ranking: false } while Phase B was unwritten.
    // The flag is verified against the repositories themselves in
    // assessment-coverage.test.ts, so it cannot drift back into a claim.
    const store = composePostgresDataStore(db, createInMemoryStorage(), config);
    expect(store.capabilities).toEqual({ assessment: true, ranking: true });
  });

  it('serves the whole submission platform regardless', async () => {
    const store = composePostgresDataStore(db, createInMemoryStorage(), config);
    await bootstrapProduction(db, INPUT);

    // These are the surfaces a learner and an operator actually use.
    expect(await store.cohorts.listCohorts()).toEqual([]);
    expect(await store.adminAuth.getAdminAccount()).not.toBeNull();
    expect(await store.settings.getAll()).toHaveLength(3);
    expect(await store.audit.list({})).toEqual([]);
    expect(await store.resources.listResources(null)).toEqual([]);
  });

  it('throws a named error for a repository that is genuinely unavailable', async () => {
    // An empty queue and a zero score both LOOK like real answers. A throw
    // cannot be mistaken for one. Judging is implemented now, so this checks
    // the mechanism itself rather than the composed store — it is what a future
    // partial deployment would fall back to.
    const assessment = unavailableAssessmentStore();
    const ranking = unavailableRankingStore();

    expect(() => assessment.getQueueStats('x')).toThrow(FeatureUnavailableError);
    expect(() => assessment.listJobs('x')).toThrow(/not available/i);
    expect(() => ranking.getCurrentSnapshot('x')).toThrow(FeatureUnavailableError);
    expect(() => ranking.listFinalSelections('x')).toThrow(/not available/i);
  });

  it('names the feature and the method in the error, so a log says what happened', () => {
    // The /admin crash was diagnosed from this message alone: the browser
    // digest was opaque and the server log named getQueueStats.
    const assessment = unavailableAssessmentStore();
    try {
      assessment.claimJobs({ workerId: 'w', limit: 1, leaseSeconds: 60 });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as FeatureUnavailableError).feature).toBe('Automated judging');
      expect((error as Error).message).toContain('claimJobs');
      expect((error as Error).message).toMatch(/stored safely/i);
    }
  });

  it('covers every assessment and ranking method', () => {
    // A method missing from the unavailable list would be `undefined` and throw
    // a confusing TypeError instead of a clear one.
    const store = {
      assessment: unavailableAssessmentStore(),
      ranking: unavailableRankingStore(),
    };
    for (const name of Object.keys(store.assessment)) {
      expect(typeof (store.assessment as unknown as Record<string, unknown>)[name], name).toBe('function');
    }
    // Every method the interfaces declare, including the feedback bookkeeping
    // (status, missing, pending, coverage) and the results export read.
    expect(Object.keys(store.assessment)).toHaveLength(40);
    expect(Object.keys(store.ranking)).toHaveLength(8);
  });
});
