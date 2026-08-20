import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { bootstrapProduction } from './bootstrap';
import { RUBRIC_CATEGORIES, RUBRIC_VERSION } from '../../rubric/index';

/**
 * What `npm run db:bootstrap` is allowed to do.
 *
 * The honest way to use a bootstrap is to run it on every deploy and stop
 * thinking about it, which only works if running it twice is indistinguishable
 * from running it once.
 *
 * The other half matters more. Adding rubric-v2 must leave rubric-v1 exactly
 * where it was, still referenced by everything judged under it. A score means
 * nothing without the rubric it was produced under, so re-pointing an old
 * cohort at a new rubric would silently reinterpret marks that were never given
 * under it.
 */

let db: PgliteHandle;
const input = { adminUsername: 'ops', adminPassword: 'Bootstrap-Test-Passphrase-9412' };

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
});

const rubrics = async () => {
  const { rows } = await db.query<{ version: string; cats: string; total: string }>(
    `select rv.version,
            (select count(*) from rubric_categories rc where rc.rubric_version_id = rv.id)::text cats,
            (select coalesce(sum(rc.max_points),0) from rubric_categories rc where rc.rubric_version_id = rv.id)::text total
       from rubric_versions rv order by rv.created_at`,
  );
  return rows;
};

describe('bootstrapping an empty database', () => {
  it('creates the rubric the constants describe', async () => {
    const report = await bootstrapProduction(db, input);

    expect(report.rubricCreated).toBe(true);
    expect(report.rubricCategories).toBe(RUBRIC_CATEGORIES.length);

    const [rubric] = await rubrics();
    expect(rubric!.version).toBe(RUBRIC_VERSION);
    expect(Number(rubric!.cats)).toBe(8);
    expect(Number(rubric!.total)).toBe(100);
  });

  it('produces exactly the agreed weights', async () => {
    await bootstrapProduction(db, input);
    const { rows } = await db.query<{ key: string; max_points: number }>(
      `select rc.key, rc.max_points from rubric_categories rc
         join rubric_versions rv on rv.id = rc.rubric_version_id
        where rv.version = $1`,
      [RUBRIC_VERSION],
    );

    expect(Object.fromEntries(rows.map((r) => [r.key, Number(r.max_points)]))).toEqual({
      problem_clarity: 15,
      solution_usefulness: 15,
      core_workflow: 25,
      ease_of_use: 10,
      ai_usefulness: 15,
      two_day_execution: 10,
      deck_demo: 5,
      practical_potential: 5,
    });
  });
});

describe('running it again', () => {
  it('changes nothing the second time', async () => {
    await bootstrapProduction(db, input);
    const second = await bootstrapProduction(db, input);

    expect(second.rubricCreated).toBe(false);
    expect(second.rubricCategories).toBe(0);
    expect(second.adminCreated).toBe(false);
  });

  it('creates no duplicate versions or categories, however many times it runs', async () => {
    for (let i = 0; i < 3; i += 1) await bootstrapProduction(db, input);

    const all = await rubrics();
    expect(all).toHaveLength(1);
    expect(Number(all[0]!.cats)).toBe(8);
    expect(Number(all[0]!.total)).toBe(100);
  });
});

describe('a database that already holds an older rubric', () => {
  /**
   * The production case: rubric-v1 exists, cohorts are frozen to it, and we are
   * adding rubric-v2 for the cohorts that come next.
   */
  const seedV1 = async () => {
    /*
     * All eight inserts in one transaction: the `rubric_totals_100` trigger is
     * deferred to commit, so a rubric is only ever checked as a complete set.
     * That is also why the real bootstrap writes its categories transactionally.
     */
    const rubricId = await db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into rubric_versions (version, name, is_active) values ('rubric-v1', 'Old', true) returning id`,
      );
      const id = rows[0]!.id;
      // The old shape: eight categories totalling 100, different keys.
      const old = [
        ['problem_clarity', 15], ['core_workflow', 25], ['stability', 15], ['ai_usefulness', 15],
        ['learning_execution', 10], ['ux_accessibility', 10], ['practical_potential', 5], ['deck_demo', 5],
      ] as const;
      let order = 1;
      for (const [key, points] of old) {
        await tx.query(
          `insert into rubric_categories (rubric_version_id, key, title, description, max_points, display_order)
           values ($1,$2,$3,'d',$4,$5)`,
          [id, key, key, points, order++],
        );
      }
      return id;
    });

    const cohort = await db.query<{ id: string }>(
      `insert into cohorts (name, code, day12_start_at, day13_deadline_at, rubric_version_id, status)
       values ('Historic C13','C13', now() - interval '2 days', now() - interval '1 day', $1, 'archived') returning id`,
      [rubricId],
    );
    return { rubricId, cohortId: cohort.rows[0]!.id };
  };

  it('adds the new rubric without disturbing the old one', async () => {
    const { rubricId } = await seedV1();
    await bootstrapProduction(db, input);

    const all = await rubrics();
    expect(all.map((r) => r.version).sort()).toEqual(['rubric-v1', RUBRIC_VERSION].sort());

    const v1 = all.find((r) => r.version === 'rubric-v1')!;
    expect(Number(v1.cats)).toBe(8);
    expect(Number(v1.total)).toBe(100);

    // And the old rubric row is untouched, not deactivated or rewritten.
    const { rows } = await db.query<{ is_active: boolean; name: string }>(
      'select is_active, name from rubric_versions where id = $1',
      [rubricId],
    );
    expect(rows[0]!.name).toBe('Old');
  });

  it('leaves a historical cohort frozen on the rubric it was created with', async () => {
    /*
     * The non-negotiable one. A mark of 20/25 under rubric-v1 does not mean
     * 20/25 under rubric-v2 — the category it was given for has a different
     * definition and, in one case, a different meaning entirely.
     */
    const { rubricId, cohortId } = await seedV1();
    await bootstrapProduction(db, input);

    const { rows } = await db.query<{ rubric_version_id: string }>(
      'select rubric_version_id from cohorts where id = $1',
      [cohortId],
    );
    expect(rows[0]!.rubric_version_id).toBe(rubricId);
  });

  it('touches no historical scores, rankings or submissions', async () => {
    await seedV1();
    const before = await db.query<{ blob: string }>(
      `select (select count(*) from category_scores)::text || '/' ||
              (select count(*) from ranking_entries)::text || '/' ||
              (select count(*) from submissions)::text blob`,
    );

    await bootstrapProduction(db, input);

    const after = await db.query<{ blob: string }>(
      `select (select count(*) from category_scores)::text || '/' ||
              (select count(*) from ranking_entries)::text || '/' ||
              (select count(*) from submissions)::text blob`,
    );
    expect(after.rows[0]!.blob).toBe(before.rows[0]!.blob);
  });

  it('lets a new cohort be created against the new rubric', async () => {
    // The failure that started this: creating a cohort threw because the code
    // asked for a rubric version the database did not have.
    await seedV1();
    await bootstrapProduction(db, input);

    const { rows } = await db.query<{ id: string }>(
      'select id from rubric_versions where version = $1',
      [RUBRIC_VERSION],
    );
    expect(rows).toHaveLength(1);

    await expect(
      db.query(
        `insert into cohorts (name, code, day12_start_at, day13_deadline_at, rubric_version_id, status)
         values ('New C14','C14', now(), now() + interval '2 days', $1, 'draft')`,
        [rows[0]!.id],
      ),
    ).resolves.toBeDefined();
  });
});
