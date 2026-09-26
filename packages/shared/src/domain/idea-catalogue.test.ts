import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../data/memory/store';
import { DEMO_COHORT_ID } from '../fixtures/demo';
import { IDEA_SEEDS } from '../fixtures/ideas';
import { AIAP_C14_IDEAS } from '../config/cohort-ideas/aiap-c14';
import {
  applyIdeaCatalogue,
  matchExistingIdea,
  planIdeaCatalogue,
  validateIdeaCatalogue,
  verifyIdeaCatalogue,
  type IdeaDefinition,
} from './idea-catalogue';
import type { CohortIdea } from '../data/types';

/**
 * Reconciling a cohort's ideas with a declared catalogue.
 *
 * The demo cohort starts with the eight C13-era seeds — the same state a
 * freshly created C14 was in. Applying the C14 catalogue must update the one
 * survivor in place, retire the other seven without deleting them, create the
 * seven new ideas approved, and then have nothing left to do.
 */

let store: MemoryDataStore;

beforeEach(() => {
  store = new MemoryDataStore();
});

const idea = (over: Partial<IdeaDefinition> = {}): IdeaDefinition => ({
  title: 'Something',
  slug: 'something',
  description: 'A description of the thing.',
  targetUser: 'People who need the thing.',
  expectedUseCase: 'Use the thing to do the thing.',
  minimumCoreFlow: ['Open it', 'Use it'],
  expectedEntities: ['Thing', 'User'],
  aiOpportunity: 'AI does a helpful thing.',
  allowedScope: 'Things.',
  unsafeInterpretations: 'No unsafe things.',
  displayOrder: 1,
  ...over,
});

describe('validating a declared catalogue', () => {
  it('accepts the C14 catalogue', () => {
    expect(validateIdeaCatalogue(AIAP_C14_IDEAS).valid).toBe(true);
  });

  it('refuses duplicate titles and slugs', () => {
    const result = validateIdeaCatalogue([
      idea({ title: 'Pet Care', slug: 'pet-care', displayOrder: 1 }),
      idea({ title: 'pet care', slug: 'pet-care-2', displayOrder: 2 }),
      idea({ title: 'Other', slug: 'pet-care', displayOrder: 3 }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/Duplicate title/);
    expect(result.problems.join(' ')).toMatch(/Duplicate slug/);
  });

  it('requires display order 1..n and non-empty definitions', () => {
    const result = validateIdeaCatalogue([
      idea({ slug: 'a', title: 'A', displayOrder: 1 }),
      idea({ slug: 'b', title: 'B', displayOrder: 3, targetUser: '', minimumCoreFlow: [] }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/displayOrder must be exactly 1..2/);
    expect(result.problems.join(' ')).toMatch(/targetUser is empty/);
    expect(result.problems.join(' ')).toMatch(/minimumCoreFlow/);
  });
});

describe('matching declared ideas to existing rows', () => {
  it('matches by slug first, then by normalised title', async () => {
    const existing = await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true });
    expect(matchExistingIdea(existing, idea({ slug: 'collaborative-notetaker', title: 'Renamed' }))?.slug).toBe(
      'collaborative-notetaker',
    );
    expect(matchExistingIdea(existing, idea({ slug: 'new-slug', title: 'collaborative  NOTETAKER' }))?.slug).toBe(
      'collaborative-notetaker',
    );
    expect(matchExistingIdea(existing, idea({ slug: 'campaign-planner', title: 'Campaign Planner' }))).toBeUndefined();
  });
});

describe('applying the C14 catalogue to a cohort seeded with the C13 ideas', () => {
  it('plans one update, seven creations and seven deactivations', async () => {
    const existing = await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true });
    const plan = planIdeaCatalogue(DEMO_COHORT_ID, existing, AIAP_C14_IDEAS);

    expect(plan.problems).toEqual([]);
    expect(plan.create.map((i) => i.slug).sort()).toEqual(
      AIAP_C14_IDEAS.filter((i) => i.slug !== 'collaborative-notetaker').map((i) => i.slug).sort(),
    );
    expect(plan.update.map((u) => u.idea.slug)).toEqual(['collaborative-notetaker']);
    expect(plan.update[0]!.changes).toEqual(
      expect.arrayContaining(['description', 'minimumCoreFlow', 'expectedEntities', 'displayOrder']),
    );
    expect(plan.deactivate.map((i) => i.slug).sort()).toEqual(
      IDEA_SEEDS.filter((i) => i.slug !== 'collaborative-notetaker').map((i) => i.slug).sort(),
    );
    expect(plan.unchanged).toEqual([]);
  });

  it('updates Collaborative Notetaker in place instead of duplicating it', async () => {
    const before = (await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true })).find(
      (i) => i.slug === 'collaborative-notetaker',
    )!;

    await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');

    const all = await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true });
    const notetakers = all.filter((i) => i.slug === 'collaborative-notetaker');
    expect(notetakers).toHaveLength(1);
    expect(notetakers[0]!.id).toBe(before.id);
    expect(notetakers[0]!.displayOrder).toBe(3);
    expect(notetakers[0]!.expectedEntities).toEqual(['Note', 'Share', 'Collaborator', 'User']);
    expect(notetakers[0]!.definitionStatus).toBe('approved');
    expect(notetakers[0]!.isActive).toBe(true);
  });

  it('deactivates the obsolete ideas rather than deleting them', async () => {
    const before = await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true });

    await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');

    const all = await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true });
    // Every original row is still there — 8 seeds + 7 created.
    for (const original of before) expect(all.find((i) => i.id === original.id)).toBeDefined();
    expect(all).toHaveLength(15);

    const inactive = all.filter((i) => !i.isActive).map((i) => i.slug).sort();
    expect(inactive).toEqual(IDEA_SEEDS.filter((i) => i.slug !== 'collaborative-notetaker').map((i) => i.slug).sort());
  });

  it('leaves exactly the eight active, approved, uniquely titled ideas in order', async () => {
    await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');

    const active = await store.cohorts.listIdeas(DEMO_COHORT_ID);
    expect(active.map((i) => i.title)).toEqual(AIAP_C14_IDEAS.map((i) => i.title));
    expect(active.map((i) => i.displayOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(active.every((i) => i.definitionStatus === 'approved')).toBe(true);
    expect(active.every((i) => i.definitionApprovedBy === 'test')).toBe(true);
    expect(new Set(active.map((i) => i.slug)).size).toBe(8);
    expect(verifyIdeaCatalogue(active, AIAP_C14_IDEAS)).toEqual({ ok: true, problems: [] });
  });

  it('is idempotent: a second run has nothing to do and changes nothing', async () => {
    await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');
    const after = JSON.stringify(await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true }));

    const existing = await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true });
    const plan = planIdeaCatalogue(DEMO_COHORT_ID, existing, AIAP_C14_IDEAS);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.approve).toEqual([]);
    expect(plan.deactivate).toEqual([]);
    expect(plan.unchanged).toHaveLength(8);

    const second = await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.deactivated).toEqual([]);
    expect(JSON.stringify(await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true }))).toBe(after);
  });

  it('re-approves after an operator edit drifts a definition', async () => {
    await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');
    const pet = (await store.cohorts.listIdeas(DEMO_COHORT_ID)).find((i) => i.slug === 'pet-care-companion')!;
    // An edit through the admin path un-approves the definition (ADR-025).
    await store.cohorts.updateIdea(pet.id, { aiOpportunity: 'Something else entirely.' });
    expect((await store.cohorts.getIdea(pet.id))!.definitionStatus).toBe('draft');

    const result = await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');
    expect(result.updated.map((i) => i.slug)).toEqual(['pet-care-companion']);
    const fixed = (await store.cohorts.getIdea(pet.id))!;
    expect(fixed.aiOpportunity).toBe(AIAP_C14_IDEAS.find((i) => i.slug === 'pet-care-companion')!.aiOpportunity);
    expect(fixed.definitionStatus).toBe('approved');
  });

  it('never touches another cohort', async () => {
    // A second cohort holding the same C13 seeds, as C13 itself does.
    const other = await store.cohorts.createCohort({
      name: 'AIAP C13',
      code: 'C13',
      description: '',
      timezone: 'Asia/Kolkata',
      day12StartAt: new Date(Date.now() - 86_400_000),
      day13DeadlineAt: new Date(Date.now() + 86_400_000),
      shortlistTarget: 10,
      submissionInstructions: '',
      rubricVersion: 'rubric-v2',
      assessmentConfig: (await store.cohorts.getCohort(DEMO_COHORT_ID))!.assessmentConfig,
      status: 'archived',
      closedAt: null,
      closureType: null,
      acceptingUntil: null,
    });
    await store.cohorts.cloneIdeas(DEMO_COHORT_ID, other.id);
    const otherBefore = JSON.stringify(await store.cohorts.listIdeas(other.id, { includeInactive: true }));
    expect(JSON.parse(otherBefore)).toHaveLength(8);

    await applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, AIAP_C14_IDEAS, 'test');

    expect(JSON.stringify(await store.cohorts.listIdeas(other.id, { includeInactive: true }))).toBe(otherBefore);
  });

  it('refuses to plan when handed rows from a different cohort', async () => {
    const existing = await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true });
    const foreign: CohortIdea[] = existing.map((i) => ({ ...i, cohortId: 'some-other-cohort' }));
    const plan = planIdeaCatalogue(DEMO_COHORT_ID, foreign, AIAP_C14_IDEAS);
    expect(plan.problems.join(' ')).toMatch(/different cohort/);
    expect(plan.create).toEqual([]);
    expect(plan.deactivate).toEqual([]);
  });

  it('refuses an invalid catalogue before writing anything', async () => {
    const before = JSON.stringify(await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true }));
    await expect(
      applyIdeaCatalogue(store.cohorts, DEMO_COHORT_ID, [idea({ slug: 'a', displayOrder: 2 })], 'test'),
    ).rejects.toThrow(/Refusing to apply/);
    expect(JSON.stringify(await store.cohorts.listIdeas(DEMO_COHORT_ID, { includeInactive: true }))).toBe(before);
  });
});
