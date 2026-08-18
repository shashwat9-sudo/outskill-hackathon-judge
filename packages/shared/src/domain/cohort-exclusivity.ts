/**
 * At most one cohort may face learners at a time.
 *
 * This exists because the system already allowed two cohorts to be `open`
 * simultaneously, and the consequences were not theoretical: `findActiveCohort`
 * picked between them by creation order, so the learner entry page and the admin
 * shell both named a cohort nobody had chosen. An operator managing one cohort
 * saw another cohort's name above the controls they were using.
 *
 * "Learner-facing" means a cohort a team can sign in to and act on. `paused` is
 * included deliberately: a paused cohort still admits learners, and treating it
 * as dormant would let an operator pause one, open another, then resume the
 * first — arriving at exactly the state this prevents.
 */

import type { CohortStatus } from './status';

/** Statuses in which learners can sign in and the cohort competes to be "active". */
export const LEARNER_FACING_STATUSES: readonly CohortStatus[] = ['open', 'paused'];

export function isLearnerFacing(status: CohortStatus): boolean {
  return LEARNER_FACING_STATUSES.includes(status);
}

export interface CohortSummary {
  id: string;
  name: string;
  code: string;
  status: CohortStatus;
}

export interface ExclusivityCheck {
  allowed: boolean;
  /** The cohort already facing learners, when one blocks this transition. */
  blockedBy: CohortSummary | null;
  reason: string;
}

/**
 * May `target` move to `nextStatus`?
 *
 * Refused — never resolved silently — when another cohort already faces
 * learners. Silently closing the other one would be a far larger action than
 * the operator asked for, and doing nothing would leave the ambiguity in place.
 */
export function checkCohortExclusivity(
  target: { id: string; status: CohortStatus },
  nextStatus: CohortStatus,
  allCohorts: readonly CohortSummary[],
): ExclusivityCheck {
  if (!isLearnerFacing(nextStatus)) {
    return { allowed: true, blockedBy: null, reason: '' };
  }

  const blocker = allCohorts.find(
    (cohort) => cohort.id !== target.id && isLearnerFacing(cohort.status),
  );

  if (!blocker) {
    return { allowed: true, blockedBy: null, reason: '' };
  }

  return {
    allowed: false,
    blockedBy: blocker,
    reason:
      `“${blocker.name}” (${blocker.code}) is already ${blocker.status} and is what learners ` +
      'currently reach. Two cohorts open at once means the submission page has to guess which ' +
      'one a team belongs to. Close or archive it first, then open this one.',
  };
}

/**
 * Find the single learner-facing cohort.
 *
 * Returns `null` when there is none and — importantly — reports `ambiguous`
 * rather than choosing when there is more than one. A caller that silently
 * picked the first would reintroduce the original bug.
 */
export function resolveLearnerFacingCohort<T extends CohortSummary>(
  cohorts: readonly T[],
): { cohort: T | null; ambiguous: boolean; candidates: T[] } {
  const candidates = cohorts.filter((cohort) => isLearnerFacing(cohort.status));
  return {
    cohort: candidates.length === 1 ? (candidates[0] as T) : null,
    ambiguous: candidates.length > 1,
    candidates,
  };
}

/** Operator-facing warning when the database is already in the ambiguous state. */
export function describeAmbiguity(candidates: readonly CohortSummary[]): string {
  const names = candidates.map((c) => `“${c.name}” (${c.code}, ${c.status})`).join(' and ');
  return (
    `${candidates.length} cohorts are open to learners at once: ${names}. ` +
    'The submission page cannot tell which one a team belongs to. Close or archive all but one.'
  );
}
