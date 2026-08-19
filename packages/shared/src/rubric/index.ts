/**
 * The official 100-point rubric.
 *
 * The category set and weights are fixed by the event rules. Both the public
 * participant-facing view and the private scoring pipeline read from this one
 * definition, so they cannot drift apart.
 *
 * `publicDescription` is shown to participants. `privateGuidance` never leaves
 * the server and never appears in a participant response.
 *
 * WHO IS BEING JUDGED, AND WHO IS NOT
 *
 * These are beginner and non-technical builders who had two days. This is not
 * an engineering competition, and v2 exists because v1 read like one: it scored
 * "stability, data and technical completeness" and asked for technical
 * explanations that these teams have no way to give and no reason to.
 *
 * So nothing here rewards framework choice, architecture, database design,
 * production hardening, code quality or edge-case coverage. A team that shipped
 * something genuinely useful on Bubble beats a team with an elegant empty repo,
 * every time.
 *
 * The single heaviest category is whether the main thing the product promises
 * actually works when a normal person tries it. That is 25 of the 100 points,
 * and it is deliberately the only place where failure hurts a lot. Rough edges,
 * unpolished layouts and missing extras cost a few points in their own
 * categories and nothing more — the difference between "this is unfinished" and
 * "this does not work" is the difference this rubric is built to draw.
 */

/**
 * v2 — rebuilt for the two-day beginner hackathon.
 *
 * Scores from v1 are not comparable: the categories carry different meanings
 * and one of them measures something else entirely. The version is part of
 * every stored score so an old assessment can still be read as what it was.
 */
export const RUBRIC_VERSION = 'rubric-v2' as const;

export const RUBRIC_CATEGORY_KEYS = [
  'problem_clarity',
  'solution_usefulness',
  'core_workflow',
  'ease_of_use',
  'ai_usefulness',
  'two_day_execution',
  'deck_demo',
  'practical_potential',
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

export const RUBRIC_CATEGORIES = [
  {
    key: 'problem_clarity',
    title: 'Problem and user clarity',
    maxPoints: 15,
    displayOrder: 1,
    publicDescription:
      'How clearly you describe who the product is for and what problem it solves for them.',
    privateGuidance:
      'Reward a specific person and a specific problem, in whatever words the team found. "Busy parents who forget what is in the fridge" is excellent; "everyone" or "users" is not. Do not require market sizing, personas or research — they had two days. Judge the clarity of the thinking, not the vocabulary used to express it: a plainly written answer from a non-technical builder is a strong answer, not a weak one.',
    evidenceSources: ['written', 'deck', 'browser_step', 'screenshot'],
  },
  {
    key: 'solution_usefulness',
    title: 'Solution usefulness',
    maxPoints: 15,
    displayOrder: 2,
    publicDescription:
      'Whether the thing you built would actually help the person you built it for.',
    privateGuidance:
      'Ask one question: if the described user opened this, would it help them? A simple product that genuinely solves the stated problem scores high. An ambitious product that solves nothing in particular scores low, however impressive it looks. This is about fit between problem and solution — not scope, not effort, and explicitly not technical sophistication. A well-chosen small idea is the point of a two-day build, not a shortfall.',
    evidenceSources: ['written', 'browser_step', 'screenshot', 'deck'],
  },
  {
    key: 'core_workflow',
    title: 'Working core experience',
    maxPoints: 25,
    displayOrder: 3,
    publicDescription:
      'Whether the main thing your product promises actually works when someone tries it.',
    privateGuidance:
      'The heaviest category, and the one place where failure should hurt. The team told us the main thing a user should be able to do; the browser run tried it. Did it work? Score on that primary path only. A product where the main action completes end to end scores high even if everything around it is rough. A product where the main action cannot be completed scores low even if the rest is polished — that is the distinction this rubric exists to make. Do not deduct here for visual roughness, missing secondary features, slow responses or unhandled edge cases; those belong to other categories or nowhere. If the browser could not reach the product at all, or the supplied login did not work, this is not a zero — it is a manual review, because we failed to observe rather than the team failing to build.',
    evidenceSources: ['browser_step', 'screenshot', 'console', 'network', 'preflight'],
  },
  {
    key: 'ease_of_use',
    title: 'Ease of use',
    maxPoints: 10,
    displayOrder: 4,
    publicDescription:
      'Whether a first-time user can find their way around without being told what to do.',
    privateGuidance:
      'Judge from the position of someone opening this for the first time with no explanation. Is it obvious what to do first? Do the buttons say what they do? Did anything mislead the browser run into a dead end? Rough styling is not a defect here. Unlabelled controls, invisible next steps and dead ends are. Ten points is a small share of the total on purpose: a beginner team should not be punished for design skills they were never asked to have.',
    evidenceSources: ['browser_step', 'screenshot', 'a11y'],
  },
  {
    key: 'ai_usefulness',
    title: 'AI usefulness',
    maxPoints: 15,
    displayOrder: 5,
    publicDescription:
      'Whether AI makes your product genuinely more useful to the person using it.',
    privateGuidance:
      'The team answered how AI helps their user. Check that answer against the product. Reward AI that does something the user actually benefits from — saving them work, producing something they could not easily make themselves, or making a decision easier. Do not reward AI that is present because it was expected: a chatbot bolted onto a form is not usefulness. Equally, do not demand technical explanation of models or prompts. What matters is whether the user is better off, which is visible in the product and in their answer. If the product plainly uses no AI, this category is low. That is a scoring outcome, not a disqualification.',
    evidenceSources: ['written', 'browser_step', 'screenshot', 'deck'],
  },
  {
    key: 'two_day_execution',
    title: 'Two-day execution',
    maxPoints: 10,
    displayOrder: 6,
    publicDescription: 'How much of a real product you got working in the two days you had.',
    privateGuidance:
      'How much genuinely working product exists, judged against two days and a beginner starting point. Reward teams who chose a scope they could finish and finished it. A narrow product that works is better execution than a broad one that does not. This is not a measure of hours worked, commit counts or feature counts, none of which we can see or should infer. It is what is standing at the end.',
    evidenceSources: ['browser_step', 'screenshot', 'written', 'deck'],
  },
  {
    key: 'deck_demo',
    title: 'Demo and deck clarity',
    maxPoints: 5,
    displayOrder: 7,
    publicDescription: 'Whether your demo and deck explain the product clearly.',
    privateGuidance:
      'Did the demo and deck make the product understandable? Production values are irrelevant — a clear phone recording beats a polished video that explains nothing. If a deck or Loom could not be opened, do not guess at its contents and do not score it as absent when it may simply be unreachable. Say so, and let the missing-evidence rule apply.',
    evidenceSources: ['deck', 'video', 'written'],
  },
  {
    key: 'practical_potential',
    title: 'Practical potential',
    maxPoints: 5,
    displayOrder: 8,
    publicDescription: 'Whether this could plausibly become something real with more time.',
    privateGuidance:
      'Would this be worth continuing? Reward a real need and an idea with somewhere to go. Do not require a business model, revenue projections or market analysis — none of that was asked for, and inventing an opinion about it would be scoring something we did not observe.',
    evidenceSources: ['written', 'deck', 'browser_step'],
  },
] as const satisfies readonly RubricCategory[];

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
