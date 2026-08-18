/**
 * The submission window.
 *
 * Whether a team may write is decided here, from the SERVER clock, on every
 * draft save, upload, removal and final submit. A browser clock is never an
 * input, and correctness never depends on a scheduler having run.
 *
 * Two things gate acceptance:
 *   1. the cohort's stored lifecycle status;
 *   2. the effective deadline, evaluated against server time.
 *
 * The stored status can lag reality — a cohort left `open` past its deadline is
 * effectively closed the moment the deadline passes. `computeSubmissionWindow`
 * returns the EFFECTIVE state, so a reconciliation job that never runs changes
 * nothing about what the system accepts.
 */

import type { CohortStatus, SubmissionStatus } from './status';
import { SUBMISSION_EDITABLE_STATUSES } from './status';

export type EffectiveWindowState =
  | 'not_yet_open'
  | 'open'
  | 'paused'
  | 'closed_by_deadline'
  | 'closed_by_admin'
  | 'judging'
  | 'finalised'
  | 'archived';

export interface SubmissionWindowInput {
  status: CohortStatus;
  day12StartAt: Date;
  day13DeadlineAt: Date;
  /**
   * Set when an admin reopens after the official deadline. Writes are accepted
   * until this instant even though `day13DeadlineAt` has passed — which is what
   * stops "reopened" from being a status that still rejects every write.
   */
  acceptingUntil?: Date | null;
}

export interface SubmissionWindow {
  state: EffectiveWindowState;
  /** May a participant edit a draft, upload, or remove an artifact? */
  canEdit: boolean;
  /** May a participant make a final submission? */
  canSubmit: boolean;
  /** May a participant at least read their own submission? Always true. */
  canView: true;
  /** The instant writes stop being accepted. */
  effectiveDeadline: Date;
  /** True when the effective deadline is later than the official one. */
  isExtended: boolean;
  /** Participant-facing explanation. Safe to render. */
  message: string;
}

/**
 * Decide the effective window.
 *
 * `now` is injected so callers pass a single server timestamp through a whole
 * request rather than sampling the clock repeatedly mid-operation.
 */
export function computeSubmissionWindow(
  cohort: SubmissionWindowInput,
  now: Date = new Date(),
): SubmissionWindow {
  const effectiveDeadline = cohort.acceptingUntil ?? cohort.day13DeadlineAt;
  const isExtended = effectiveDeadline.getTime() > cohort.day13DeadlineAt.getTime();
  const deadlinePassed = now.getTime() > effectiveDeadline.getTime();

  const closed = (state: EffectiveWindowState, message: string): SubmissionWindow => ({
    state,
    canEdit: false,
    canSubmit: false,
    canView: true,
    effectiveDeadline,
    isExtended,
    message,
  });

  switch (cohort.status) {
    case 'draft':
      return closed('not_yet_open', 'Submissions have not opened yet.');

    case 'archived':
      return closed('archived', 'This cohort is archived. Submissions are read-only.');

    case 'finalised':
      return closed('finalised', 'Submissions are closed and judging is complete.');

    case 'judging':
      return closed('judging', 'Submissions are closed. Assessment is under way.');

    case 'closed':
      return closed('closed_by_admin', 'Submissions are now closed.');

    case 'paused':
      // A pause is not a closure: the team can still read everything.
      return closed(
        'paused',
        'Submissions are paused. You can view your entry, but cannot edit or submit it until Outskill resumes submissions.',
      );

    case 'open': {
      if (now.getTime() < cohort.day12StartAt.getTime()) {
        return closed('not_yet_open', 'Submissions have not opened yet.');
      }
      // The load-bearing case: status says open, but the clock says otherwise.
      if (deadlinePassed) {
        return closed('closed_by_deadline', 'Submissions are now closed.');
      }
      return {
        state: 'open',
        canEdit: true,
        canSubmit: true,
        canView: true,
        effectiveDeadline,
        isExtended,
        message: 'Submissions are open.',
      };
    }

    default: {
      // Exhaustive: a new cohort status must be handled explicitly rather than
      // silently defaulting to "open".
      const exhaustive: never = cohort.status;
      throw new Error(`Unhandled cohort status: ${String(exhaustive)}`);
    }
  }
}

/**
 * The complete participant permission decision.
 *
 * Combines the cohort window with this submission's own state, because a locked
 * submission is read-only even while the cohort is wide open.
 */
export interface ParticipantPermissions {
  canEdit: boolean;
  canSubmit: boolean;
  reason: string;
  window: SubmissionWindow;
}

export function evaluateParticipantPermissions(
  cohort: SubmissionWindowInput,
  submissionStatus: SubmissionStatus,
  now: Date = new Date(),
): ParticipantPermissions {
  const window = computeSubmissionWindow(cohort, now);
  const submissionEditable = SUBMISSION_EDITABLE_STATUSES.includes(submissionStatus);

  if (!submissionEditable) {
    return {
      canEdit: false,
      canSubmit: false,
      reason:
        submissionStatus === 'withdrawn'
          ? 'This submission has been withdrawn.'
          : 'Your submission is locked. The Outskill programme team can reopen it only when an exception is approved.',
      window,
    };
  }

  if (!window.canEdit) {
    return { canEdit: false, canSubmit: false, reason: window.message, window };
  }

  return { canEdit: true, canSubmit: window.canSubmit, reason: window.message, window };
}

/** Cohort statuses in which a reconciliation job should close an open cohort. */
export function needsDeadlineReconciliation(
  cohort: SubmissionWindowInput,
  now: Date = new Date(),
): boolean {
  if (cohort.status !== 'open') return false;
  const effectiveDeadline = cohort.acceptingUntil ?? cohort.day13DeadlineAt;
  return now.getTime() > effectiveDeadline.getTime();
}

// --------------------------------------------------------------------------
// Reopening
// --------------------------------------------------------------------------

export interface ReopenRequest {
  reason: string;
  /** A replacement Day 13 deadline. */
  newDeadline?: Date | null;
  /** Or a temporary acceptance window, leaving the official deadline intact. */
  acceptingUntil?: Date | null;
}

export interface ReopenValidation {
  valid: boolean;
  problems: string[];
  /** True when the original deadline has already passed. */
  requiresExtension: boolean;
}

/**
 * Validate a reopen.
 *
 * If the official deadline has passed, reopening MUST come with either a new
 * deadline or an explicit acceptance window. Without one the cohort would show
 * as open while rejecting every write — the single most confusing state this
 * system could present to a team that has been told they may resubmit.
 */
export function validateReopen(
  cohort: SubmissionWindowInput,
  request: ReopenRequest,
  now: Date = new Date(),
): ReopenValidation {
  const problems: string[] = [];
  const requiresExtension = now.getTime() > cohort.day13DeadlineAt.getTime();

  if (!request.reason || request.reason.trim().length < 5) {
    problems.push('Give a reason for reopening. It is recorded and shown to the team.');
  }

  if (requiresExtension) {
    const extension = request.newDeadline ?? request.acceptingUntil ?? null;
    if (!extension) {
      problems.push(
        'The official deadline has passed, so reopening needs either a new deadline or an explicit acceptance-until time. Without one, teams would see an open cohort that rejects every save.',
      );
    } else if (extension.getTime() <= now.getTime()) {
      problems.push('The new deadline or acceptance time must be in the future.');
    }
  }

  return { valid: problems.length === 0, problems, requiresExtension };
}
