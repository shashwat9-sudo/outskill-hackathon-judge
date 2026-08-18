import { describe, expect, it } from 'vitest';
import type { CohortStatus } from './status';
import { COHORT_STATUSES } from './status';
import {
  computeSubmissionWindow,
  evaluateParticipantPermissions,
  needsDeadlineReconciliation,
  validateReopen,
  type SubmissionWindowInput,
} from './submission-window';

/**
 * The submission window is the single place that decides whether a team may
 * write. Everything here is about one property: the answer must come from the
 * server clock and the stored state, and must never depend on a scheduler having
 * run.
 */

const DEADLINE = new Date('2026-03-13T18:29:00Z'); // 11:59 PM IST
const DAY12 = new Date('2026-03-12T03:30:00Z');
const BEFORE = new Date('2026-03-13T10:00:00Z');
const AFTER = new Date('2026-03-13T18:30:00Z');

function cohort(overrides: Partial<SubmissionWindowInput> = {}): SubmissionWindowInput {
  return {
    status: 'open',
    day12StartAt: DAY12,
    day13DeadlineAt: DEADLINE,
    acceptingUntil: null,
    ...overrides,
  };
}

describe('the open window', () => {
  it('accepts writes inside it', () => {
    const window = computeSubmissionWindow(cohort(), BEFORE);
    expect(window.state).toBe('open');
    expect(window.canEdit).toBe(true);
    expect(window.canSubmit).toBe(true);
  });

  it('is not yet open before Day 12 starts', () => {
    const window = computeSubmissionWindow(cohort(), new Date('2026-03-11T00:00:00Z'));
    expect(window.state).toBe('not_yet_open');
    expect(window.canEdit).toBe(false);
  });

  it('closes itself the instant the deadline passes, with the status still open', () => {
    // The load-bearing case. A reconciliation job that never runs must not be
    // able to leave submissions accepting writes after 11:59 PM IST.
    const window = computeSubmissionWindow(cohort({ status: 'open' }), AFTER);
    expect(window.state).toBe('closed_by_deadline');
    expect(window.canEdit).toBe(false);
    expect(window.canSubmit).toBe(false);
  });

  it('treats the deadline instant itself as still open', () => {
    expect(computeSubmissionWindow(cohort(), DEADLINE).canEdit).toBe(true);
    expect(computeSubmissionWindow(cohort(), new Date(DEADLINE.getTime() + 1)).canEdit).toBe(false);
  });
});

describe('every cohort status resolves', () => {
  it('handles all of them without falling through to open', () => {
    for (const status of COHORT_STATUSES) {
      const window = computeSubmissionWindow(cohort({ status }), BEFORE);
      expect(window.message.length, status).toBeGreaterThan(10);
      // Only 'open' may permit writing.
      expect(window.canEdit, status).toBe(status === 'open');
    }
  });

  it('always allows viewing', () => {
    for (const status of COHORT_STATUSES) {
      expect(computeSubmissionWindow(cohort({ status }), AFTER).canView, status).toBe(true);
    }
  });

  it('throws rather than guessing at an unknown status', () => {
    const rogue = cohort({ status: 'something_new' as CohortStatus });
    expect(() => computeSubmissionWindow(rogue, BEFORE)).toThrow(/Unhandled cohort status/);
  });
});

describe('pause', () => {
  it('stops writing but reads as a pause, not a closure', () => {
    const window = computeSubmissionWindow(cohort({ status: 'paused' }), BEFORE);
    expect(window.state).toBe('paused');
    expect(window.canEdit).toBe(false);
    expect(window.message).toMatch(/paused/i);
    expect(window.message).toMatch(/view/i);
    // A team told "closed" during a temporary pause would stop working.
    expect(window.message).not.toMatch(/closed/i);
  });
});

describe('extension', () => {
  it('accepts writes past the official deadline when an acceptance window is set', () => {
    const extended = cohort({ acceptingUntil: new Date('2026-03-14T06:00:00Z') });
    const window = computeSubmissionWindow(extended, AFTER);
    expect(window.canEdit).toBe(true);
    expect(window.isExtended).toBe(true);
    expect(window.effectiveDeadline.toISOString()).toBe('2026-03-14T06:00:00.000Z');
  });

  it('closes again once the extension itself expires', () => {
    const extended = cohort({ acceptingUntil: new Date('2026-03-14T06:00:00Z') });
    const window = computeSubmissionWindow(extended, new Date('2026-03-14T06:00:01Z'));
    expect(window.state).toBe('closed_by_deadline');
  });

  it('does not report an extension when none was granted', () => {
    expect(computeSubmissionWindow(cohort(), BEFORE).isExtended).toBe(false);
  });
});

describe('participant permissions', () => {
  it('lets a draft be edited in an open window', () => {
    const permissions = evaluateParticipantPermissions(cohort(), 'draft', BEFORE);
    expect(permissions.canEdit).toBe(true);
    expect(permissions.canSubmit).toBe(true);
  });

  it('locks a submitted entry even while the cohort is wide open', () => {
    const permissions = evaluateParticipantPermissions(cohort(), 'locked', BEFORE);
    expect(permissions.canEdit).toBe(false);
    expect(permissions.reason).toMatch(/locked/i);
    expect(permissions.reason).toMatch(/exception/i);
  });

  it('explains a withdrawal differently from a lock', () => {
    const permissions = evaluateParticipantPermissions(cohort(), 'withdrawn', BEFORE);
    expect(permissions.canEdit).toBe(false);
    expect(permissions.reason).toMatch(/withdrawn/i);
  });

  it('gives the window reason when the cohort is what blocks the write', () => {
    const permissions = evaluateParticipantPermissions(cohort(), 'draft', AFTER);
    expect(permissions.canEdit).toBe(false);
    expect(permissions.reason).toBe(permissions.window.message);
  });
});

describe('reconciliation', () => {
  it('flags an open cohort whose deadline has passed', () => {
    expect(needsDeadlineReconciliation(cohort(), AFTER)).toBe(true);
  });

  it('does not flag one still inside its window', () => {
    expect(needsDeadlineReconciliation(cohort(), BEFORE)).toBe(false);
  });

  it('does not flag one already closed', () => {
    expect(needsDeadlineReconciliation(cohort({ status: 'closed' }), AFTER)).toBe(false);
  });

  it('respects an extension', () => {
    const extended = cohort({ acceptingUntil: new Date('2026-03-14T06:00:00Z') });
    expect(needsDeadlineReconciliation(extended, AFTER)).toBe(false);
  });
});

describe('reopening', () => {
  it('requires a reason', () => {
    const result = validateReopen(cohort(), { reason: '' }, BEFORE);
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/reason/i);
  });

  it('reopens inside the window with just a reason', () => {
    const result = validateReopen(cohort(), { reason: 'Upload failed during the outage' }, BEFORE);
    expect(result.valid).toBe(true);
    expect(result.requiresExtension).toBe(false);
  });

  it('refuses to reopen past the deadline without an extension', () => {
    // Otherwise the team sees an open cohort that rejects every save — the worst
    // possible state for someone who has just been told they may resubmit.
    const result = validateReopen(cohort(), { reason: 'Approved exception' }, AFTER);
    expect(result.valid).toBe(false);
    expect(result.requiresExtension).toBe(true);
    expect(result.problems.join(' ')).toMatch(/rejects every save/i);
  });

  it('accepts a reopen past the deadline with an acceptance window', () => {
    const result = validateReopen(
      cohort(),
      { reason: 'Approved exception', acceptingUntil: new Date('2026-03-14T06:00:00Z') },
      AFTER,
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a reopen past the deadline with a replacement deadline', () => {
    const result = validateReopen(
      cohort(),
      { reason: 'Approved exception', newDeadline: new Date('2026-03-14T06:00:00Z') },
      AFTER,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects an extension that is already in the past', () => {
    const result = validateReopen(
      cohort(),
      { reason: 'Approved exception', acceptingUntil: new Date('2026-03-13T12:00:00Z') },
      AFTER,
    );
    expect(result.valid).toBe(false);
    expect(result.problems.join(' ')).toMatch(/future/i);
  });
});
