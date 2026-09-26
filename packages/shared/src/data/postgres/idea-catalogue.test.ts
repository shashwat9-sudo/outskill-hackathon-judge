import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { makeCohort } from './testing/assessment-fixtures';
import { buildCohortStore } from './repositories/admin';
import { seedIdeaCatalogue } from './bootstrap';
import { applyIdeaCatalogue, planIdeaCatalogue, verifyIdeaCatalogue } from '../../domain/idea-catalogue';
import { AIAP_C14_IDEAS } from '../../config/cohort-ideas/aiap-c14';
import { IDEA_SEEDS } from '../../fixtures/ideas';
import { parseSheetRows, SHEET_HEADERS } from '../../intake/sheet-rows';
import type { Cohort, CohortIdea } from '../types';

/**
 * The C14 catalogue against the real schema.
 *
 * Two cohorts, both seeded with the C13 ideas exactly as production was.
 * Applying C14's catalogue to one must leave the other byte-for-byte as it
 * was, keep every original row, and satisfy the `(cohort_id, slug)` unique
 * index the whole way through.
 */

let db: PgliteHandle;
let c14: Cohort;
let c13: Cohort;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Test rubric', true)`,
  );
  c13 = await makeCohort(db, 'C13');
  c14 = await makeCohort(db, 'C14');
  await seedIdeaCatalogue(db, c13.id);
  await seedIdeaCatalogue(db, c14.id);
});

const rowsOf = async (cohortId: string) =>
  (await db.query<Record<string, unknown>>(
    'select * from cohort_ideas where cohort_id = $1 order by slug',
    [cohortId],
  )).rows;

describe('applying the C14 catalogue in Postgres', () => {
  it('starts from the C13 seeds, unapproved, as a fresh cohort does', async () => {
    const ideas = await buildCohortStore(db).listIdeas(c14.id, { includeInactive: true });
    expect(ideas.map((i) => i.slug).sort()).toEqual(IDEA_SEEDS.map((i) => i.slug).sort());
    expect(ideas.every((i) => i.definitionStatus === 'draft')).toBe(true);
  });

  it('updates the survivor in place, retires the rest, creates the new ones approved', async () => {
    const cohorts = buildCohortStore(db);
    const notetakerBefore = (await cohorts.listIdeas(c14.id)).find((i) => i.slug === 'collaborative-notetaker')!;

    const result = await applyIdeaCatalogue(cohorts, c14.id, AIAP_C14_IDEAS, 'ops');

    expect(result.created).toHaveLength(7);
    expect(result.updated.map((i) => i.slug)).toEqual(['collaborative-notetaker']);
    expect(result.deactivated).toHaveLength(7);

    const all = await cohorts.listIdeas(c14.id, { includeInactive: true });
    expect(all).toHaveLength(15);
    const notetaker = all.find((i) => i.slug === 'collaborative-notetaker')!;
    expect(notetaker.id).toBe(notetakerBefore.id);
    expect(notetaker.definitionStatus).toBe('approved');
    expect(notetaker.definitionApprovedBy).toBe('ops');
    expect(notetaker.definitionApprovedAt).not.toBeNull();

    const active = await cohorts.listIdeas(c14.id);
    expect(active.map((i) => i.title)).toEqual(AIAP_C14_IDEAS.map((i) => i.title));
    expect(active.every((i) => i.definitionStatus === 'approved')).toBe(true);
    expect(verifyIdeaCatalogue(active, AIAP_C14_IDEAS).ok).toBe(true);

    // Nothing deleted: the count of rows for the cohort only grew.
    const { rows } = await db.query<{ n: string }>('select count(*) as n from cohort_ideas where cohort_id = $1', [c14.id]);
    expect(Number(rows[0]!.n)).toBe(15);
  });

  it('leaves the other cohort exactly as it was', async () => {
    const before = JSON.stringify(await rowsOf(c13.id));
    await applyIdeaCatalogue(buildCohortStore(db), c14.id, AIAP_C14_IDEAS, 'ops');
    expect(JSON.stringify(await rowsOf(c13.id))).toBe(before);
    const c13Ideas = await buildCohortStore(db).listIdeas(c13.id);
    expect(c13Ideas.map((i) => i.slug).sort()).toEqual(IDEA_SEEDS.map((i) => i.slug).sort());
    expect(c13Ideas.every((i) => i.definitionStatus === 'draft')).toBe(true);
  });

  it('is idempotent against the real unique index', async () => {
    const cohorts = buildCohortStore(db);
    await applyIdeaCatalogue(cohorts, c14.id, AIAP_C14_IDEAS, 'ops');
    const snapshot = JSON.stringify(await rowsOf(c14.id));

    const plan = planIdeaCatalogue(c14.id, await cohorts.listIdeas(c14.id, { includeInactive: true }), AIAP_C14_IDEAS);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.deactivate).toEqual([]);
    expect(plan.unchanged).toHaveLength(8);

    const again = await applyIdeaCatalogue(cohorts, c14.id, AIAP_C14_IDEAS, 'ops');
    expect(again.created).toEqual([]);
    expect(JSON.stringify(await rowsOf(c14.id))).toBe(snapshot);
  });

  it('makes every canonical sheet category resolve to the cohort catalogue intake reads', async () => {
    const cohorts = buildCohortStore(db);
    await applyIdeaCatalogue(cohorts, c14.id, AIAP_C14_IDEAS, 'ops');

    // What `syncSheet` reads: the mapped cohort's active ideas.
    const approvedCategories = (await cohorts.listIdeas(c14.id)).map((i: CohortIdea) => ({ slug: i.slug, title: i.title }));
    const headers = [...SHEET_HEADERS];
    const row = (category: string, group: number) =>
      headers.map((h) =>
        h === 'Group Number' ? String(group)
          : h === 'Category' ? category
          : h === 'Product Name' ? 'P'
          : h === 'MVP/Product Link' ? 'https://p.example.com'
          : h === 'Access' ? 'Open Access'
          : ['Brief Description', 'Main User Action', 'How AI Helps', 'What We Got Working'].includes(h) ? 'x'
          : '',
      );
    const parsed = parseSheetRows(
      [headers, ...AIAP_C14_IDEAS.map((i, index) => row(i.title, index + 1)), row('Recipe Sharing App', 99)],
      { approvedCategories },
    );
    expect(parsed.valid.map((r) => r.input.ideaSlug)).toEqual(AIAP_C14_IDEAS.map((i) => i.slug));
    expect(parsed.invalid).toEqual([
      expect.objectContaining({ groupNumber: 99, field: 'Category' }),
    ]);
  });
});
