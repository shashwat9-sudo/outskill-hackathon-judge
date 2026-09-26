/**
 * Reconciling a cohort's idea catalogue with a declared one.
 *
 * Ideas belong to a cohort (ADR-013), and a new cohort inherits whatever the
 * previous one had — which is how AIAP C14 came to hold C13's eight ideas. The
 * upstream submission product writes a fixed set of Category strings, and a
 * row whose Category is not an active idea of the mapped cohort is blocked at
 * intake. So the catalogue has to be right before the sheet is read, and it
 * has to be right in a way that can be checked, repeated and explained.
 *
 * This module is the pure part: given what the cohort holds and what it should
 * hold, produce a plan (create / update / approve / deactivate / unchanged),
 * and apply that plan through the same `CohortStore` methods the admin UI
 * uses. It never issues SQL, never deletes, never touches another cohort, and
 * running it twice produces an empty plan the second time.
 *
 * Ideas are matched to existing rows by slug, then by normalised title. That
 * is what lets "Collaborative Notetaker" — an idea that survives from C13 to
 * C14 with a new definition — be updated in place rather than duplicated.
 */

import type { CohortIdea } from '../data/types';

/**
 * The five store methods this module writes through — the same ones the admin
 * screens call. Declared structurally rather than imported from the store
 * interface so this pure module (reachable from intake, and through it from
 * learner-facing code) never names the store itself.
 */
export interface IdeaCatalogueStore {
  listIdeas(cohortId: string, options?: { includeInactive?: boolean }): Promise<CohortIdea[]>;
  createIdea(input: Omit<CohortIdea, 'id' | 'createdAt' | 'updatedAt'>): Promise<CohortIdea>;
  updateIdea(id: string, patch: Partial<CohortIdea>): Promise<CohortIdea>;
  approveIdeaDefinition(ideaId: string, actor: string): Promise<CohortIdea>;
  deleteIdea(id: string): Promise<void>;
}

/** One idea as the programme declares it. Everything a `cohort_ideas` row needs. */
export interface IdeaDefinition {
  title: string;
  slug: string;
  description: string;
  targetUser: string;
  expectedUseCase: string;
  minimumCoreFlow: readonly string[];
  expectedEntities: readonly string[];
  aiOpportunity: string;
  allowedScope: string;
  unsafeInterpretations: string;
  displayOrder: number;
}

/** A declared catalogue, bound to exactly one external cohort identity. */
export interface IdeaCatalogue {
  /** The internal product's own cohort identifier, e.g. "AIAP-C14". */
  externalCohortId: string;
  /** The display name the operator expects to see, as a guard against the wrong cohort. */
  expectedCohortNameIncludes: string;
  ideas: readonly IdeaDefinition[];
  /** Cohort-level settings the catalogue is designed for. Applied only when asked. */
  settings: {
    shortlistTarget: number;
    finalSelectionTarget: number;
  };
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lowercase, punctuation to spaces, collapsed — the same shape intake compares. */
export function normaliseIdeaTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The slug intake derives from a Category cell, so a config can be checked against it. */
export function slugFromTitle(title: string): string {
  return normaliseIdeaTitle(title).replace(/ /g, '-');
}

/**
 * Is a declared catalogue internally sound?
 *
 * Checked before any plan is made: a duplicate slug would make the plan
 * ambiguous, and an empty minimum core flow would judge every team against
 * nothing. `displayOrder` must be 1..n with no gaps so the operator's list
 * reads in the order the programme announced.
 */
export function validateIdeaCatalogue(ideas: readonly IdeaDefinition[]): {
  valid: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  if (ideas.length === 0) problems.push('The catalogue declares no ideas.');

  const titles = new Map<string, string>();
  const slugs = new Map<string, string>();
  for (const idea of ideas) {
    const label = idea.title || idea.slug || '(untitled)';

    for (const field of [
      'title',
      'slug',
      'description',
      'targetUser',
      'expectedUseCase',
      'aiOpportunity',
      'allowedScope',
      'unsafeInterpretations',
    ] as const) {
      if (!idea[field] || !idea[field].trim()) problems.push(`"${label}": ${field} is empty.`);
    }
    if (idea.minimumCoreFlow.length === 0 || idea.minimumCoreFlow.some((s) => !s.trim())) {
      problems.push(`"${label}": minimumCoreFlow must list at least one non-empty step.`);
    }
    if (idea.expectedEntities.length === 0 || idea.expectedEntities.some((s) => !s.trim())) {
      problems.push(`"${label}": expectedEntities must list at least one non-empty entity.`);
    }
    if (!SLUG_PATTERN.test(idea.slug)) {
      problems.push(`"${label}": slug "${idea.slug}" must be lowercase words joined by hyphens.`);
    }

    const titleKey = normaliseIdeaTitle(idea.title);
    const titleClash = titles.get(titleKey);
    if (titleClash) problems.push(`Duplicate title: "${idea.title}" and "${titleClash}".`);
    else titles.set(titleKey, idea.title);

    const slugClash = slugs.get(idea.slug);
    if (slugClash) problems.push(`Duplicate slug: "${idea.slug}" used by "${idea.title}" and "${slugClash}".`);
    else slugs.set(idea.slug, idea.title);
  }

  const orders = ideas.map((i) => i.displayOrder).sort((a, b) => a - b);
  const expected = ideas.map((_, index) => index + 1);
  if (orders.join(',') !== expected.join(',')) {
    problems.push(`displayOrder must be exactly 1..${ideas.length} with no gaps or repeats; got ${orders.join(', ')}.`);
  }

  return { valid: problems.length === 0, problems };
}

/**
 * The existing row a definition corresponds to, if any.
 *
 * Slug first, because it is the identity intake uses. Title second, because an
 * operator may have typed a slug differently on a cohort where the title is
 * what the programme announced. Inactive rows count: reactivating the row a
 * past submission already points at is better than creating a second one.
 */
export function matchExistingIdea(
  existing: readonly CohortIdea[],
  definition: IdeaDefinition,
): CohortIdea | undefined {
  const bySlug = existing.find((idea) => idea.slug === definition.slug);
  if (bySlug) return bySlug;
  const wanted = normaliseIdeaTitle(definition.title);
  return existing.find((idea) => normaliseIdeaTitle(idea.title) === wanted);
}

/** The fields a definition governs, compared one by one so a plan can name what changed. */
const COMPARED_FIELDS = [
  'title',
  'slug',
  'description',
  'targetUser',
  'expectedUseCase',
  'minimumCoreFlow',
  'expectedEntities',
  'aiOpportunity',
  'allowedScope',
  'unsafeInterpretations',
  'displayOrder',
] as const;

type ComparedField = (typeof COMPARED_FIELDS)[number];

function fieldDiffers(idea: CohortIdea, definition: IdeaDefinition, field: ComparedField): boolean {
  return JSON.stringify(idea[field]) !== JSON.stringify(definition[field]);
}

export interface IdeaUpdate {
  idea: CohortIdea;
  definition: IdeaDefinition;
  /** Field names that differ, plus `isActive` when a row is being reactivated. */
  changes: string[];
}

export interface IdeaCataloguePlan {
  cohortId: string;
  create: IdeaDefinition[];
  update: IdeaUpdate[];
  /** Rows that already match and merely lack approval. */
  approve: CohortIdea[];
  /** Active rows the catalogue does not declare. Deactivated, never deleted. */
  deactivate: CohortIdea[];
  /** Rows that match, are active and approved: nothing to do. */
  unchanged: CohortIdea[];
  problems: string[];
}

/**
 * Decide what has to change. Pure: reads two lists, writes nothing.
 *
 * `existing` must be every idea of the cohort including inactive ones, so a
 * previously deactivated row can be brought back rather than duplicated.
 */
export function planIdeaCatalogue(
  cohortId: string,
  existing: readonly CohortIdea[],
  ideas: readonly IdeaDefinition[],
): IdeaCataloguePlan {
  const plan: IdeaCataloguePlan = {
    cohortId,
    create: [],
    update: [],
    approve: [],
    deactivate: [],
    unchanged: [],
    problems: [],
  };

  const validation = validateIdeaCatalogue(ideas);
  plan.problems.push(...validation.problems);

  const foreign = existing.filter((idea) => idea.cohortId !== cohortId);
  if (foreign.length > 0) {
    plan.problems.push(
      `${foreign.length} idea(s) belong to a different cohort than ${cohortId}; refusing to plan across cohorts.`,
    );
  }
  if (plan.problems.length > 0) return plan;

  const claimed = new Set<string>();
  for (const definition of ideas) {
    const match = matchExistingIdea(existing, definition);
    if (match && claimed.has(match.id)) {
      plan.problems.push(
        `Two declared ideas resolve to the same existing row "${match.title}" (${match.slug}).`,
      );
      continue;
    }
    if (!match) {
      plan.create.push(definition);
      continue;
    }
    claimed.add(match.id);

    const changes = COMPARED_FIELDS.filter((field) => fieldDiffers(match, definition, field)).map(String);
    if (!match.isActive) changes.push('isActive');

    if (changes.length > 0) plan.update.push({ idea: match, definition, changes });
    else if (match.definitionStatus !== 'approved') plan.approve.push(match);
    else plan.unchanged.push(match);
  }

  for (const idea of existing) {
    if (idea.isActive && !claimed.has(idea.id)) plan.deactivate.push(idea);
  }

  return plan;
}

export interface IdeaCatalogueApplyResult {
  plan: IdeaCataloguePlan;
  created: CohortIdea[];
  updated: CohortIdea[];
  approved: CohortIdea[];
  deactivated: CohortIdea[];
  /** The cohort's active ideas after the change, verified against the catalogue. */
  active: CohortIdea[];
}

/**
 * Apply a catalogue to one cohort through the store.
 *
 * Every write goes through `CohortStore` — the same `createIdea`,
 * `updateIdea`, `approveIdeaDefinition` and `deleteIdea` (a soft
 * deactivation) the admin screens call — so nothing here can do something the
 * UI cannot. Ids come from `listIdeas(cohortId)`, so a write cannot reach a
 * row of another cohort. Nothing is ever deleted.
 *
 * `updateIdea` un-approves a definition whose expanded fields changed
 * (ADR-025); the declared catalogue is the reviewed text, so each changed or
 * created idea is approved immediately afterwards, on the actor's authority.
 *
 * Idempotent: a second run finds nothing to create, update or deactivate.
 */
export async function applyIdeaCatalogue(
  cohorts: IdeaCatalogueStore,
  cohortId: string,
  ideas: readonly IdeaDefinition[],
  actor: string,
): Promise<IdeaCatalogueApplyResult> {
  const existing = await cohorts.listIdeas(cohortId, { includeInactive: true });
  const plan = planIdeaCatalogue(cohortId, existing, ideas);
  if (plan.problems.length > 0) {
    throw new Error(`Refusing to apply the idea catalogue: ${plan.problems.join(' ')}`);
  }

  const result: IdeaCatalogueApplyResult = {
    plan,
    created: [],
    updated: [],
    approved: [],
    deactivated: [],
    active: [],
  };

  // Deactivate first, so a title or slug freed by an obsolete idea cannot
  // collide with one being created or renamed below.
  for (const idea of plan.deactivate) {
    assertBelongsTo(idea, cohortId);
    await cohorts.deleteIdea(idea.id);
    result.deactivated.push({ ...idea, isActive: false });
  }

  for (const { idea, definition, changes } of plan.update) {
    assertBelongsTo(idea, cohortId);
    // Only what differs: an unchanged expanded field must not reset approval.
    const patch: Partial<CohortIdea> = {};
    for (const field of COMPARED_FIELDS) {
      if (changes.includes(field)) {
        (patch as Record<string, unknown>)[field] = clone(definition[field]);
      }
    }
    if (changes.includes('isActive')) patch.isActive = true;

    let updated = await cohorts.updateIdea(idea.id, patch);
    if (updated.definitionStatus !== 'approved') {
      updated = await cohorts.approveIdeaDefinition(idea.id, actor);
      result.approved.push(updated);
    }
    result.updated.push(updated);
  }

  for (const idea of plan.approve) {
    assertBelongsTo(idea, cohortId);
    result.approved.push(await cohorts.approveIdeaDefinition(idea.id, actor));
  }

  for (const definition of plan.create) {
    const created = await cohorts.createIdea({
      cohortId,
      title: definition.title,
      slug: definition.slug,
      description: definition.description,
      targetUser: definition.targetUser,
      expectedUseCase: definition.expectedUseCase,
      minimumCoreFlow: [...definition.minimumCoreFlow],
      expectedEntities: [...definition.expectedEntities],
      aiOpportunity: definition.aiOpportunity,
      allowedScope: definition.allowedScope,
      unsafeInterpretations: definition.unsafeInterpretations,
      displayOrder: definition.displayOrder,
      isActive: true,
      definitionStatus: 'draft',
      definitionApprovedAt: null,
      definitionApprovedBy: null,
    });
    const approved = await cohorts.approveIdeaDefinition(created.id, actor);
    result.created.push(approved);
    result.approved.push(approved);
  }

  result.active = await cohorts.listIdeas(cohortId);
  const verification = verifyIdeaCatalogue(result.active, ideas);
  if (!verification.ok) {
    throw new Error(`The catalogue was applied but does not verify: ${verification.problems.join(' ')}`);
  }

  return result;
}

/**
 * Does a cohort's active catalogue equal the declared one, approved and unique?
 *
 * Run after applying, and usable on its own as a readiness check.
 */
export function verifyIdeaCatalogue(
  active: readonly CohortIdea[],
  ideas: readonly IdeaDefinition[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  const activeOnly = active.filter((idea) => idea.isActive);
  const wantedSlugs = new Set(ideas.map((i) => i.slug));
  const activeSlugs = activeOnly.map((i) => i.slug);

  for (const slug of wantedSlugs) {
    if (!activeSlugs.includes(slug)) problems.push(`Declared idea "${slug}" is not active.`);
  }
  for (const idea of activeOnly) {
    if (!wantedSlugs.has(idea.slug)) problems.push(`Active idea "${idea.slug}" is not in the catalogue.`);
    if (idea.definitionStatus !== 'approved') problems.push(`"${idea.title}" is not approved.`);
  }

  const seenSlugs = new Set<string>();
  const seenTitles = new Set<string>();
  for (const idea of activeOnly) {
    if (seenSlugs.has(idea.slug)) problems.push(`Duplicate active slug "${idea.slug}".`);
    seenSlugs.add(idea.slug);
    const title = normaliseIdeaTitle(idea.title);
    if (seenTitles.has(title)) problems.push(`Duplicate active title "${idea.title}".`);
    seenTitles.add(title);
  }

  for (const definition of ideas) {
    const row = activeOnly.find((i) => i.slug === definition.slug);
    if (row && row.displayOrder !== definition.displayOrder) {
      problems.push(`"${definition.title}" has display order ${row.displayOrder}, expected ${definition.displayOrder}.`);
    }
    if (row && row.title !== definition.title) {
      problems.push(`"${definition.slug}" is titled "${row.title}", expected "${definition.title}".`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Intake's view of a catalogue: what a sheet Category is matched against. */
export function catalogueCategories(ideas: readonly IdeaDefinition[]): { slug: string; title: string }[] {
  return ideas.map((idea) => ({ slug: idea.slug, title: idea.title }));
}

function assertBelongsTo(idea: CohortIdea, cohortId: string): void {
  if (idea.cohortId !== cohortId) {
    throw new Error(`Idea ${idea.id} belongs to cohort ${idea.cohortId}, not ${cohortId}. Refusing.`);
  }
}

function clone<T>(value: T): T {
  return Array.isArray(value) ? ([...value] as T) : value;
}
