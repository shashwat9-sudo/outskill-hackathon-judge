/**
 * Ranking and tie-breaking.
 *
 * Tie-break order is fixed by the event rules:
 *   1. total score
 *   2. core workflow
 *   3. solution_usefulness
 *   4. AI usefulness
 *   5. learning and execution
 *   6. fewer unresolved risks
 *
 * A deterministic final fallback (submission id) is appended so the ordering is
 * total and stable — two genuinely identical entries must not swap places
 * between renders of the same snapshot.
 *
 * The tie-break chain is private: it is never exposed on a participant route.
 */

import type { RubricCategoryKey } from '../rubric/index';
import { totalScore, type CategoryScoreLike } from '../rubric/index';

/**
 * Categories consulted for tie-breaking, in priority order.
 *
 * Typed as the tie-break subset rather than the full category union, so the
 * comparator below can index the vector without a cast — and so adding a
 * category here without adding it to `TiebreakVector` is a compile error.
 */
export type TiebreakCategoryKey = Extract<
  RubricCategoryKey,
  'core_workflow' | 'solution_usefulness' | 'ai_usefulness' | 'two_day_execution'
>;

export const TIEBREAK_CATEGORY_ORDER: readonly TiebreakCategoryKey[] = [
  'core_workflow',
  'solution_usefulness',
  'ai_usefulness',
  'two_day_execution',
];

export interface RankableSubmission {
  submissionId: string;
  scores: readonly CategoryScoreLike[];
  /** Open manual-review flags and unresolved risks. Fewer ranks higher. */
  unresolvedRiskCount: number;
  meanConfidence: number;
}

export interface RankedEntry {
  submissionId: string;
  rank: number;
  totalScore: number;
  meanConfidence: number;
  /** The values compared, in order, so a ranking decision can be explained. */
  tiebreakVector: TiebreakVector;
  inShortlist: boolean;
}

export interface TiebreakVector {
  total: number;
  core_workflow: number;
  solution_usefulness: number;
  ai_usefulness: number;
  two_day_execution: number;
  unresolvedRisks: number;
}

function categoryScore(scores: readonly CategoryScoreLike[], key: RubricCategoryKey): number {
  return scores.find((s) => s.categoryKey === key)?.weightedScore ?? 0;
}

export function buildTiebreakVector(entry: RankableSubmission): TiebreakVector {
  return {
    total: totalScore(entry.scores),
    core_workflow: categoryScore(entry.scores, 'core_workflow'),
    solution_usefulness: categoryScore(entry.scores, 'solution_usefulness'),
    ai_usefulness: categoryScore(entry.scores, 'ai_usefulness'),
    two_day_execution: categoryScore(entry.scores, 'two_day_execution'),
    unresolvedRisks: entry.unresolvedRiskCount,
  };
}

/**
 * Comparator implementing the tie-break chain.
 * Returns a negative number when `a` ranks ahead of `b`.
 */
export function compareForRanking(a: RankableSubmission, b: RankableSubmission): number {
  const va = buildTiebreakVector(a);
  const vb = buildTiebreakVector(b);

  if (va.total !== vb.total) return vb.total - va.total;
  for (const key of TIEBREAK_CATEGORY_ORDER) {
    if (va[key] !== vb[key]) return vb[key] - va[key];
  }
  // Fewer unresolved risks ranks higher — note the inverted direction.
  if (va.unresolvedRisks !== vb.unresolvedRisks) return va.unresolvedRisks - vb.unresolvedRisks;

  // Deterministic final fallback so ordering is total and stable.
  return a.submissionId.localeCompare(b.submissionId);
}

export interface RankingOptions {
  /** How many entries are highlighted as the private shortlist. Default 10. */
  shortlistTarget?: number;
}

/**
 * Rank eligible submissions.
 *
 * Callers must pass only eligible submissions — filtering is the caller's job
 * so that "why was this team excluded" is answered by an explicit eligibility
 * decision with an audit trail, not buried inside the sort.
 */
export function rankSubmissions(
  entries: readonly RankableSubmission[],
  options: RankingOptions = {},
): RankedEntry[] {
  const shortlistTarget = options.shortlistTarget ?? 10;
  const sorted = [...entries].sort(compareForRanking);

  return sorted.map((entry, index) => ({
    submissionId: entry.submissionId,
    rank: index + 1,
    totalScore: totalScore(entry.scores),
    meanConfidence: entry.meanConfidence,
    tiebreakVector: buildTiebreakVector(entry),
    inShortlist: index < shortlistTarget,
  }));
}

// --------------------------------------------------------------------------
// Consistency-pass selection
// --------------------------------------------------------------------------

export const CONSISTENCY_TRIGGERS = [
  'top20',
  'low_confidence',
  'manual_review',
  'near_cutoff',
  'close_tie',
  'disputed',
] as const;
export type ConsistencyTrigger = (typeof CONSISTENCY_TRIGGERS)[number];

/** Points either side of the shortlist cutoff that qualify for a second pass. */
export const NEAR_CUTOFF_POINTS = 2;
/** Score gap at or below which two adjacent entries count as a close tie. */
export const CLOSE_TIE_POINTS = 0.5;
export const TOP_N_FOR_CONSISTENCY = 20;
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export interface ConsistencyCandidate {
  submissionId: string;
  triggers: ConsistencyTrigger[];
}

/**
 * Select which submissions get a second scoring pass.
 *
 * Running a second pass on everyone would roughly double AI cost for little
 * benefit; running it on nobody leaves the decisions that actually matter —
 * the ones near the cutoff — resting on a single pass. This selects exactly
 * the cases where a disagreement would change an outcome.
 */
export function selectForConsistencyReview(
  ranked: readonly RankedEntry[],
  context: {
    shortlistTarget: number;
    lowConfidenceIds: ReadonlySet<string>;
    manualReviewIds: ReadonlySet<string>;
    disputedIds: ReadonlySet<string>;
  },
): ConsistencyCandidate[] {
  const triggersById = new Map<string, Set<ConsistencyTrigger>>();

  const add = (id: string, trigger: ConsistencyTrigger) => {
    const existing = triggersById.get(id) ?? new Set<ConsistencyTrigger>();
    existing.add(trigger);
    triggersById.set(id, existing);
  };

  ranked.slice(0, TOP_N_FOR_CONSISTENCY).forEach((entry) => add(entry.submissionId, 'top20'));

  for (const id of context.lowConfidenceIds) add(id, 'low_confidence');
  for (const id of context.manualReviewIds) add(id, 'manual_review');
  for (const id of context.disputedIds) add(id, 'disputed');

  // Within NEAR_CUTOFF_POINTS of the shortlist boundary, either side.
  const cutoffEntry = ranked[context.shortlistTarget - 1];
  if (cutoffEntry) {
    for (const entry of ranked) {
      if (Math.abs(entry.totalScore - cutoffEntry.totalScore) <= NEAR_CUTOFF_POINTS) {
        add(entry.submissionId, 'near_cutoff');
      }
    }
  }

  // Adjacent entries separated by a hair.
  for (let i = 1; i < ranked.length; i++) {
    const previous = ranked[i - 1];
    const current = ranked[i];
    if (!previous || !current) continue;
    if (Math.abs(previous.totalScore - current.totalScore) <= CLOSE_TIE_POINTS) {
      add(previous.submissionId, 'close_tie');
      add(current.submissionId, 'close_tie');
    }
  }

  return [...triggersById.entries()].map(([submissionId, triggers]) => ({
    submissionId,
    triggers: [...triggers].sort(),
  }));
}

// --------------------------------------------------------------------------
// Final selection
// --------------------------------------------------------------------------

export const FINAL_SELECTION_COUNT = 4;

export interface FinalSelectionValidation {
  valid: boolean;
  problems: string[];
}

/**
 * Validate a proposed final four.
 *
 * Called on the admin action path only. There is deliberately no automated
 * caller anywhere in the codebase — no worker, job stage, or AI response can
 * write a final selection (ADR-018).
 */
export function validateFinalSelection(
  selections: readonly { submissionId: string; position: number }[],
  eligibleSubmissionIds: ReadonlySet<string>,
): FinalSelectionValidation {
  const problems: string[] = [];

  if (selections.length !== FINAL_SELECTION_COUNT) {
    problems.push(`Exactly ${FINAL_SELECTION_COUNT} winners must be selected; got ${selections.length}.`);
  }

  const positions = selections.map((s) => s.position).sort((a, b) => a - b);
  const expected = Array.from({ length: FINAL_SELECTION_COUNT }, (_, i) => i + 1);
  if (selections.length === FINAL_SELECTION_COUNT && positions.join(',') !== expected.join(',')) {
    problems.push(`Positions must be exactly ${expected.join(', ')} with no duplicates.`);
  }

  const uniqueIds = new Set(selections.map((s) => s.submissionId));
  if (uniqueIds.size !== selections.length) {
    problems.push('The same submission cannot occupy two positions.');
  }

  for (const selection of selections) {
    if (!eligibleSubmissionIds.has(selection.submissionId)) {
      problems.push(`Submission ${selection.submissionId} is not eligible for selection.`);
    }
  }

  return { valid: problems.length === 0, problems };
}
