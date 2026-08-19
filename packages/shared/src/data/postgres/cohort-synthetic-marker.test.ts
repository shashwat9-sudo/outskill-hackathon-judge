import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildCohortStore } from './repositories/admin';
import { buildTeamStore } from './repositories/teams';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import { canDispatchToProvider } from '@ohj/ai';

/**
 * The one bit that says "it is safe to send this to a third party".
 *
 * `synthetic_only` used to decide that by looking at the database driver —
 * memory meant fixtures, Postgres meant learners. Safe in the direction that
 * mattered, and useless for proving a real deployment: a fixture cohort sitting
 * in production Postgres was indistinguishable from the learner cohorts beside
 * it, so the deployed worker could not be exercised end to end without relaxing
 * the refusal for every cohort at once.
 *
 * So the fact is now recorded on the cohort. Which makes the interesting tests
 * the negative ones: this flag is the difference between a deck staying in our
 * database and a deck being posted to a provider, so most of this file is about
 * the ways it must not be possible to set it.
 */

let db: PgliteHandle;
let admin: ReturnType<typeof buildCohortStore>;

const REAL = { isDemoCohort: false, isSyntheticSubmission: false };

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v1', 'Test', true)`,
  );
  admin = buildCohortStore(db);
});

const newCohortInput = (name: string, code: string) => ({
  name,
  code,
  description: 'A cohort',
  timezone: 'Asia/Kolkata',
  day12StartAt: new Date(Date.now() - 86_400_000),
  day13DeadlineAt: new Date(Date.now() + 86_400_000),
  shortlistTarget: 10,
  submissionInstructions: '',
  rubricVersion: 'rubric-v1',
  assessmentConfig: {} as never,
  status: 'open' as const,
  closedAt: null,
  closureType: null,
  acceptingUntil: null,
});

describe('after the migration', () => {
  it('leaves every existing cohort real', async () => {
    /*
     * The property that makes this migration safe to run on production.
     *
     * A default of true, or a backfill keyed on anything, would have marked
     * live learner cohorts as safe to send externally the moment it ran.
     */
    const { cohort } = await seedCohortWithSubmissions(db, 1);
    const { rows } = await db.query<{ is_synthetic: boolean }>(
      `select is_synthetic from cohorts where id = $1`,
      [cohort.id],
    );
    expect(rows[0]!.is_synthetic).toBe(false);
  });

  it('has no third state', async () => {
    // A nullable column would be read as falsy somewhere and truthy elsewhere.
    const { rows } = await db.query<{ is_nullable: string; column_default: string }>(
      `select is_nullable, column_default from information_schema.columns
        where table_name = 'cohorts' and column_name = 'is_synthetic'`,
    );
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.column_default).toMatch(/false/);
  });
});

describe('creating and editing a cohort', () => {
  it('produces a real cohort by default', async () => {
    const cohort = await admin.createCohort(newCohortInput('Ordinary Cohort', 'ORD1'));
    expect(cohort.isSynthetic).toBe(false);
  });

  it('ignores an attempt to smuggle the flag through cohort creation', async () => {
    // The input type does not carry it, so this is what a hand-built object or
    // an unvalidated request body would do at runtime.
    const sneaky = { ...newCohortInput('Sneaky', 'SNK1'), isSynthetic: true };
    const cohort = await admin.createCohort(sneaky as never);
    expect(cohort.isSynthetic).toBe(false);
  });

  it('ignores an attempt to set it through an update', async () => {
    /*
     * The path that mattered most. `updateCohort` builds its SET clause from
     * the patch it is handed, so without an explicit strip this would have been
     * reachable from any route ending in a cohort edit — including a form post.
     */
    const cohort = await admin.createCohort(newCohortInput('Editable', 'EDT1'));
    await admin.updateCohort(cohort.id, { isSynthetic: true } as never);

    const after = await admin.getCohort(cohort.id);
    expect(after!.isSynthetic).toBe(false);
  });

  it('still allows ordinary edits, so the strip is narrow', async () => {
    const cohort = await admin.createCohort(newCohortInput('Renamable', 'RNM1'));
    const updated = await admin.updateCohort(cohort.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.isSynthetic).toBe(false);
  });
});

describe('the dispatch decision under synthetic_only', () => {
  it('refuses a real cohort, exactly as before', async () => {
    const decision = canDispatchToProvider('synthetic_only', {
      ...REAL,
      cohortName: 'AIAP Cohort 13',
      correlationId: 'anon-1',
    });
    expect(decision.allowed).toBe(false);
  });

  it('permits a cohort explicitly marked synthetic', async () => {
    const decision = canDispatchToProvider('synthetic_only', {
      isDemoCohort: true,
      isSyntheticSubmission: true,
      cohortName: 'RAILWAY SYNTHETIC PROOF — DELETE LATER',
      correlationId: 'anon-2',
    });
    expect(decision.allowed).toBe(true);
  });

  it('is not fooled by a cohort named to look synthetic', async () => {
    /*
     * The reason this is a column and not a name check.
     *
     * A team called "Synthetic Coffee", or an operator who renames a live
     * cohort to "TEST — ignore", must not thereby consent to having every
     * team's deck sent to a provider. The name is for humans; the flag decides.
     */
    for (const name of [
      'SYNTHETIC — DELETE LATER',
      'TEST COHORT',
      'demo fixtures',
      'RAILWAY SYNTHETIC PROOF — DELETE LATER',
    ]) {
      const decision = canDispatchToProvider('synthetic_only', {
        ...REAL,
        cohortName: name,
        correlationId: 'anon-3',
      });
      expect(decision.allowed, name).toBe(false);
    }
  });

  it('renaming a real cohort does not change its flag', async () => {
    const cohort = await admin.createCohort(newCohortInput('Real Cohort', 'REL1'));
    await admin.updateCohort(cohort.id, { name: 'SYNTHETIC — DELETE LATER' });

    const after = await admin.getCohort(cohort.id);
    expect(after!.isSynthetic).toBe(false);
    expect(
      canDispatchToProvider('synthetic_only', {
        isDemoCohort: after!.isSynthetic,
        isSyntheticSubmission: after!.isSynthetic,
        cohortName: after!.name,
        correlationId: 'anon-4',
      }).allowed,
    ).toBe(false);
  });

  it('still refuses when only half the pair is synthetic', async () => {
    // A synthetic submission inside a real cohort is still surrounded by real
    // ones; a real submission inside a demo cohort is a mistake worth catching.
    for (const [a, b] of [
      [true, false],
      [false, true],
    ]) {
      const decision = canDispatchToProvider('synthetic_only', {
        isDemoCohort: a!,
        isSyntheticSubmission: b!,
        cohortName: 'Mixed',
        correlationId: 'anon-5',
      });
      expect(decision.allowed).toBe(false);
    }
  });
});

describe('who may set it', () => {
  it('is not writable by the participant or worker roles', async () => {
    /*
     * Two layers. The application types cannot express it, and the database
     * refuses the write regardless of what code is running — which is what
     * makes it a boundary rather than a convention.
     */
    const cohort = await admin.createCohort(newCohortInput('Guarded', 'GRD1'));

    for (const role of ['ohj_participant', 'ohj_worker']) {
      await db.query(`set role ${role}`);
      await expect(
        db.query(`update cohorts set is_synthetic = true where id = $1`, [cohort.id]),
        role,
      ).rejects.toThrow(/permission denied/i);
      await db.query('reset role');
    }

    const after = await admin.getCohort(cohort.id);
    expect(after!.isSynthetic).toBe(false);
  });

  it('cannot be reached by importing teams into a cohort', async () => {
    // The import path writes teams and members. It has no business anywhere
    // near a flag about external dispatch.
    const cohort = await admin.createCohort(newCohortInput('Importable', 'IMP1'));
    const teams = buildTeamStore(db);
    await teams.importTeams(cohort.id, [
      { groupNumber: 1, leadName: 'A', leadEmail: 'a@example.invalid', leadPhone: '' },
    ]);

    const after = await admin.getCohort(cohort.id);
    expect(after!.isSynthetic).toBe(false);
  });
});
