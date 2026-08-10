/**
 * The official 100-point rubric.
 *
 * The category set and weights are fixed by the event rules. Both the public
 * participant-facing view and the private scoring pipeline read from this one
 * definition, so they cannot drift apart.
 *
 * `publicDescription` is shown to participants. `privateGuidance` never leaves
 * the server and never appears in a participant response.
 */

export const RUBRIC_VERSION = 'rubric-v1' as const;

export const RUBRIC_CATEGORY_KEYS = [
  'problem_clarity',
  'core_workflow',
  'stability',
  'ai_usefulness',
  'learning_execution',
  'ux_accessibility',
  'practical_potential',
  'deck_demo',
] as const;

export type RubricCategoryKey = (typeof RUBRIC_CATEGORY_KEYS)[number];

export interface RubricCategory {
  key: RubricCategoryKey;
  title: string;
  maxPoints: number;
  displayOrder: number;
  /** Shown to participants. Safe to render publicly. */
  publicDescription: string;
  /** Internal scoring guidance. Never sent to a participant route. */
  privateGuidance: string;
  /**
   * Evidence types that can substantiate this category. A category scored
   * with none of these present is flagged as unsupported.
   */
  evidenceSources: readonly EvidenceSource[];
}

export type EvidenceSource =
  | 'browser_step'
  | 'screenshot'
  | 'console'
  | 'network'
  | 'a11y'
  | 'deck'
  | 'written'
  | 'video'
  | 'preflight';

export const RUBRIC_CATEGORIES: readonly RubricCategory[] = [
  {
    key: 'problem_clarity',
    title: 'Problem and target-user clarity',
    maxPoints: 15,
    displayOrder: 1,
    publicDescription:
      'How clearly the submission identifies a specific target user, the exact recurring problem they face, and a single understandable product promise.',
    privateGuidance:
      'Reward a named, specific user and a concrete recurring pain. A generic audience ("everyone", "users") caps this category. The one-sentence promise should be checkable against what the product actually does — a promise contradicted by the live product is contradictory evidence, not a clarity failure.',
    evidenceSources: ['written', 'deck', 'browser_step', 'screenshot'],
  },
  {
    key: 'core_workflow',
    title: 'Core workflow functionality',
    maxPoints: 25,
    displayOrder: 2,
    publicDescription:
      'Whether the single must-have workflow the team committed to actually works end to end in the live product.',
    privateGuidance:
      'The heaviest category, and the one most driven by observed browser evidence. Score against the team-declared must-have workflow, not against an idealised version of the product. A workflow that completes end to end at least twice scores in the top band. Partial completion, dead ends, or a flow that only works on the exact declared happy path scores in the middle bands. Deck claims never substitute for an observed run.',
    evidenceSources: ['browser_step', 'screenshot', 'network', 'preflight'],
  },
  {
    key: 'stability',
    title: 'Stability, data and technical completeness',
    maxPoints: 15,
    displayOrder: 3,
    publicDescription:
      'Whether the product is stable, stores data correctly, and behaves consistently across reloads and sessions.',
    privateGuidance:
      'Directly mirrors the stability bar teams were taught: the core flow runs twice in a row, no dead buttons or dead-end screens, CRUD works on main entities, data persists after reload. Console errors and failed network calls are evidence here. Distinguish a product defect from a third-party outage — an outage is not a stability failure.',
    evidenceSources: ['browser_step', 'console', 'network', 'screenshot'],
  },
  {
    key: 'ai_usefulness',
    title: 'AI usefulness and differentiation',
    maxPoints: 15,
    displayOrder: 4,
    publicDescription:
      'Whether AI materially improves the product outcome, rather than being a decorative or generic addition.',
    privateGuidance:
      'Ask whether the AI feature changes the user outcome and uses product context. A generic chatbot bolted onto an unrelated product scores low regardless of how well it works. Reward handled AI-failure states. An AI feature that could not be exercised is missing evidence, not a zero.',
    evidenceSources: ['browser_step', 'screenshot', 'written', 'network'],
  },
  {
    key: 'learning_execution',
    title: 'Learning and execution quality',
    maxPoints: 10,
    displayOrder: 5,
    publicDescription:
      'The quality of the team’s reflection: bugs they found and fixed, trade-offs they made, and what changed between Day 12 and Day 13.',
    privateGuidance:
      'Scored from the written learning evidence, corroborated where possible against the product. Specific, concrete bugs and a real trade-off with a stated cost score well. Vague or template-sounding answers score low. Do not reward volume — reward specificity.',
    evidenceSources: ['written', 'browser_step'],
  },
  {
    key: 'ux_accessibility',
    title: 'UX and accessibility',
    maxPoints: 10,
    displayOrder: 6,
    publicDescription:
      'Clarity of the interface, quality of empty/loading/error states, mobile behaviour, and basic accessibility.',
    privateGuidance:
      'Combine the axe scan, keyboard traversal, mobile smoke test, and observed state handling. Weight serious and critical axe violations above minor ones. Aesthetic preference is not a scoring input; usability and accessibility are.',
    evidenceSources: ['a11y', 'browser_step', 'screenshot'],
  },
  {
    key: 'practical_potential',
    title: 'Practical or commercial potential',
    maxPoints: 5,
    displayOrder: 7,
    publicDescription:
      'Whether the product has a credible path to repeated use and real-world adoption.',
    privateGuidance:
      'Low weight by design — judgement here is inherently speculative. Reward a plausible repeat-use reason and an identifiable audience. Never promise or predict commercial success, and never let this category compensate for a product that does not work.',
    evidenceSources: ['written', 'deck', 'browser_step'],
  },
  {
    key: 'deck_demo',
    title: 'Deck and demo clarity',
    maxPoints: 5,
    displayOrder: 8,
    publicDescription:
      'Whether the pitch deck and demo video communicate the product clearly and accurately.',
    privateGuidance:
      'Check the deck covers problem, product and demo, and that it is actually filled in — unedited template placeholder text is contradictory evidence. If the demo video could not be analysed, record missing evidence and lower confidence; never invent video content. A deck claiming features the product does not have is an accuracy problem, recorded here and as contradictory evidence in the affected category.',
    evidenceSources: ['deck', 'video', 'screenshot'],
  },
] as const;

export const RUBRIC_TOTAL_POINTS = 100 as const;

/** Compile-time guard: the weights must literally sum to 100. */
type Sum<T extends readonly number[]> = T extends readonly [
  infer Head extends number,
  ...infer Rest extends readonly number[],
]
  ? [...BuildTuple<Head>, ...BuildTuple<Sum<Rest>>]['length'] extends infer N extends number
    ? N
    : never
  : 0;
type BuildTuple<N extends number, Acc extends unknown[] = []> = Acc['length'] extends N
  ? Acc
  : BuildTuple<N, [...Acc, unknown]>;
type _AssertRubricSumsTo100 = Sum<[15, 25, 15, 15, 10, 10, 5, 5]> extends 100 ? true : never;
const _rubricSumProof: _AssertRubricSumsTo100 = true;
void _rubricSumProof;

/** Runtime guard, so a bad edit fails at import time rather than at scoring time. */
const runtimeTotal = RUBRIC_CATEGORIES.reduce((sum, c) => sum + c.maxPoints, 0);
if (runtimeTotal !== RUBRIC_TOTAL_POINTS) {
  throw new Error(
    `Rubric integrity failure: categories sum to ${runtimeTotal}, expected ${RUBRIC_TOTAL_POINTS}.`,
  );
}
if (new Set(RUBRIC_CATEGORIES.map((c) => c.key)).size !== RUBRIC_CATEGORIES.length) {
  throw new Error('Rubric integrity failure: duplicate category key.');
}

const categoryByKey = new Map<RubricCategoryKey, RubricCategory>(
  RUBRIC_CATEGORIES.map((c) => [c.key, c]),
);

export function getRubricCategory(key: RubricCategoryKey): RubricCategory {
  const category = categoryByKey.get(key);
  if (!category) throw new Error(`Unknown rubric category: ${key}`);
  return category;
}

export function getMaxPoints(key: RubricCategoryKey): number {
  return getRubricCategory(key).maxPoints;
}

/**
 * The participant-safe projection of the rubric.
 *
 * Private scoring guidance is dropped here rather than being filtered at the
 * route — so a new participant surface cannot accidentally leak it.
 */
export interface PublicRubricCategory {
  key: RubricCategoryKey;
  title: string;
  maxPoints: number;
  displayOrder: number;
  description: string;
}

export function getPublicRubric(): PublicRubricCategory[] {
  return RUBRIC_CATEGORIES.map((c) => ({
    key: c.key,
    title: c.title,
    maxPoints: c.maxPoints,
    displayOrder: c.displayOrder,
    description: c.publicDescription,
  }));
}

/**
 * Raw score (0..maxPoints) is already in rubric points, so the weighted score
 * equals the raw score. The function exists so that a future rubric using a
 * normalised 0..1 raw scale changes one place, and so every call site is
 * explicit about which number it is storing.
 */
export function weightedScore(key: RubricCategoryKey, rawScore: number): number {
  const max = getMaxPoints(key);
  const clamped = clampScore(rawScore, max);
  return roundToQuarter(clamped);
}

export function clampScore(rawScore: number, maxPoints: number): number {
  if (!Number.isFinite(rawScore)) return 0;
  return Math.min(Math.max(rawScore, 0), maxPoints);
}

/** Scores are recorded to the nearest 0.25 to keep totals stable and comparable. */
export function roundToQuarter(value: number): number {
  return Math.round(value * 4) / 4;
}

export interface CategoryScoreLike {
  categoryKey: RubricCategoryKey;
  weightedScore: number;
}

/** Total across all categories, rounded to avoid float drift in ranking. */
export function totalScore(scores: readonly CategoryScoreLike[]): number {
  const sum = scores.reduce((acc, s) => acc + s.weightedScore, 0);
  return Math.round(sum * 100) / 100;
}

/** True when every rubric category has a score. Partial scoring must not rank. */
export function isCompleteScoreSet(scores: readonly CategoryScoreLike[]): boolean {
  const seen = new Set(scores.map((s) => s.categoryKey));
  return RUBRIC_CATEGORY_KEYS.every((key) => seen.has(key));
}
