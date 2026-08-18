import { describe, expect, it } from 'vitest';
import {
  LEARNER_FACING_STATUSES,
  checkCohortExclusivity,
  describeAmbiguity,
  isLearnerFacing,
  resolveLearnerFacingCohort,
  type CohortSummary,
} from './cohort-exclusivity';

/**
 * At most one cohort faces learners.
 *
 * The system already allowed two cohorts to be open at once, and it was not
 * harmless: `findActiveCohort` picked between them by creation order, so the
 * learner entry page and the admin shell both named a cohort nobody had chosen.
 */

const cohort = (id: string, status: CohortSummary['status'], code = id.toUpperCase()): CohortSummary => ({
  id,
  name: `Cohort ${id}`,
  code,
  status,
});

describe('which statuses face learners', () => {
  it('counts open and paused', () => {
    expect([...LEARNER_FACING_STATUSES].sort()).toEqual(['open', 'paused']);
  });

  it('includes paused, so pause-then-open-another cannot slip through', () => {
    // Without this an operator could pause one, open a second, resume the
    // first, and arrive at exactly the state this prevents.
    expect(isLearnerFacing('paused')).toBe(true);
  });

  it('excludes states learners cannot act in', () => {
    for (const status of ['draft', 'closed', 'judging', 'finalised', 'archived'] as const) {
      expect(isLearnerFacing(status), status).toBe(false);
    }
  });
});

describe('opening a cohort', () => {
  it('is allowed when nothing else faces learners', () => {
    const all = [cohort('a', 'draft'), cohort('b', 'closed'), cohort('c', 'archived')];
    expect(checkCohortExclusivity(cohort('a', 'draft'), 'open', all).allowed).toBe(true);
  });

  it('is refused when another cohort is already open', () => {
    const all = [cohort('a', 'draft'), cohort('b', 'open')];
    const check = checkCohortExclusivity(cohort('a', 'draft'), 'open', all);

    expect(check.allowed).toBe(false);
    expect(check.blockedBy?.id).toBe('b');
  });

  it('names the blocking cohort, rather than refusing anonymously', () => {
    // An operator must know which cohort to close, not merely that one exists.
    const all = [cohort('a', 'draft'), cohort('b', 'open', 'AIAP-C13')];
    const check = checkCohortExclusivity(cohort('a', 'draft'), 'open', all);

    expect(check.reason).toContain('Cohort b');
    expect(check.reason).toContain('AIAP-C13');
    expect(check.reason).toMatch(/close or archive it first/i);
  });

  it('is refused when another cohort is paused', () => {
    const all = [cohort('a', 'draft'), cohort('b', 'paused')];
    expect(checkCohortExclusivity(cohort('a', 'draft'), 'open', all).allowed).toBe(false);
  });

  it('lets a cohort that is already open stay open', () => {
    // Resuming from paused must not be blocked by the cohort itself.
    const all = [cohort('a', 'paused')];
    expect(checkCohortExclusivity(cohort('a', 'paused'), 'open', all).allowed).toBe(true);
  });

  it('never blocks a transition away from learners', () => {
    const all = [cohort('a', 'open'), cohort('b', 'open')];
    for (const status of ['closed', 'judging', 'archived', 'finalised'] as const) {
      expect(checkCohortExclusivity(cohort('a', 'open'), status, all).allowed, status).toBe(true);
    }
  });

  it('does not resolve the conflict by itself', () => {
    // Silently closing the other cohort would be a far larger action than the
    // operator asked for.
    const all = [cohort('a', 'draft'), cohort('b', 'open')];
    const check = checkCohortExclusivity(cohort('a', 'draft'), 'open', all);
    expect(check.allowed).toBe(false);
    expect(all.find((c) => c.id === 'b')?.status).toBe('open');
  });
});

describe('resolving the active cohort', () => {
  it('returns the single learner-facing cohort', () => {
    const resolved = resolveLearnerFacingCohort([cohort('a', 'draft'), cohort('b', 'open')]);
    expect(resolved.cohort?.id).toBe('b');
    expect(resolved.ambiguous).toBe(false);
  });

  it('returns none when nothing faces learners', () => {
    const resolved = resolveLearnerFacingCohort([cohort('a', 'draft'), cohort('b', 'closed')]);
    expect(resolved.cohort).toBeNull();
    expect(resolved.ambiguous).toBe(false);
  });

  it('refuses to choose between two, rather than picking by order', () => {
    // This is the original bug. Returning either one would reintroduce it.
    const resolved = resolveLearnerFacingCohort([cohort('a', 'open'), cohort('b', 'paused')]);
    expect(resolved.cohort).toBeNull();
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.candidates).toHaveLength(2);
  });

  it('describes the ambiguity in terms an operator can act on', () => {
    const message = describeAmbiguity([cohort('a', 'open', 'C12'), cohort('b', 'paused', 'C13')]);
    expect(message).toContain('C12');
    expect(message).toContain('C13');
    expect(message).toMatch(/close or archive all but one/i);
  });
});
