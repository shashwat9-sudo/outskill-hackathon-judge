/**
 * Status machines.
 *
 * Every lifecycle in the system is an explicit transition table rather than a
 * free-form string column. An illegal transition is rejected loudly instead of
 * silently corrupting a submission's state mid-judging.
 */

// --------------------------------------------------------------------------
// Cohort
// --------------------------------------------------------------------------

export const COHORT_STATUSES = [
  'draft',
  'open',
  'paused',
  'closed',
  'judging',
  'finalised',
  'archived',
] as const;
export type CohortStatus = (typeof COHORT_STATUSES)[number];

const COHORT_TRANSITIONS: Record<CohortStatus, readonly CohortStatus[]> = {
  draft: ['open', 'archived'],
  open: ['paused', 'closed'],
  paused: ['open', 'closed'],
  // Archiving a closed cohort retires it without judging. A cohort run for a
  // rehearsal, a pilot or an acceptance test is never judged, and the only
  // route to `archived` used to run through `judging` and `finalised` — so the
  // safe way to retire one was to fake a judging run first. The confirmation
  // states how many final submissions would never be assessed.
  closed: ['judging', 'open', 'archived'],
  judging: ['closed', 'finalised'], // back to closed to re-run assessment
  finalised: ['judging', 'archived'], // reversible until archived
  archived: [],
};

/** Participants may create or edit a submission only in these cohort states. */
export const COHORT_ACCEPTING_STATUSES: readonly CohortStatus[] = ['open'];

/** Cohort states in which the participant portal is readable but read-only. */
export const COHORT_READONLY_STATUSES: readonly CohortStatus[] = [
  'paused',
  'closed',
  'judging',
  'finalised',
  'archived',
];

// --------------------------------------------------------------------------
// Submission
// --------------------------------------------------------------------------

export const SUBMISSION_STATUSES = [
  'draft',
  'submitted',
  'locked',
  'reopened',
  'withdrawn',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

const SUBMISSION_TRANSITIONS: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['locked', 'reopened', 'withdrawn'],
  locked: ['reopened', 'withdrawn'],
  reopened: ['submitted', 'withdrawn'],
  withdrawn: ['draft'],
};

/** Statuses in which a participant may still edit their own submission. */
export const SUBMISSION_EDITABLE_STATUSES: readonly SubmissionStatus[] = ['draft', 'reopened'];

/** Statuses that count as a real submission for assessment and ranking. */
export const SUBMISSION_FINAL_STATUSES: readonly SubmissionStatus[] = ['submitted', 'locked'];

// --------------------------------------------------------------------------
// Assessment job
// --------------------------------------------------------------------------

export const ASSESSMENT_STAGES = [
  'queued',
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
  'completed',
  'manual_review',
  'failed',
  'disqualified',
] as const;
export type AssessmentStage = (typeof ASSESSMENT_STAGES)[number];

/** The happy path, in order. */
export const ASSESSMENT_HAPPY_PATH: readonly AssessmentStage[] = [
  'queued',
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
  'completed',
];

/**
 * Every processing stage may also divert to manual_review, failed, or
 * disqualified. Terminal states can be re-entered only by an explicit admin
 * rerun, which re-queues the job.
 */
const DIVERSIONS: readonly AssessmentStage[] = ['manual_review', 'failed', 'disqualified'];

const ASSESSMENT_TRANSITIONS: Record<AssessmentStage, readonly AssessmentStage[]> = {
  queued: ['preflight', ...DIVERSIONS],
  preflight: ['artifact_analysis', ...DIVERSIONS],
  artifact_analysis: ['test_plan_generation', ...DIVERSIONS],
  test_plan_generation: ['browser_testing', ...DIVERSIONS],
  browser_testing: ['evidence_review', ...DIVERSIONS],
  evidence_review: ['scoring', ...DIVERSIONS],
  scoring: ['consistency_review', 'completed', ...DIVERSIONS],
  consistency_review: ['completed', ...DIVERSIONS],
  // Terminal / holding states — re-entry only via an admin rerun back to queued.
  completed: ['queued', 'manual_review', 'disqualified'],
  manual_review: ['queued', 'completed', 'disqualified', 'failed'],
  failed: ['queued', 'manual_review', 'disqualified'],
  disqualified: ['queued', 'manual_review'],
};

export const ASSESSMENT_TERMINAL_STAGES: readonly AssessmentStage[] = [
  'completed',
  'failed',
  'disqualified',
];

/** Stages a worker is allowed to pick up. Holding states need a human first. */
export const ASSESSMENT_CLAIMABLE_STAGES: readonly AssessmentStage[] = [
  'queued',
  'preflight',
  'artifact_analysis',
  'test_plan_generation',
  'browser_testing',
  'evidence_review',
  'scoring',
  'consistency_review',
];

export function nextHappyStage(stage: AssessmentStage): AssessmentStage | null {
  const index = ASSESSMENT_HAPPY_PATH.indexOf(stage);
  if (index === -1 || index === ASSESSMENT_HAPPY_PATH.length - 1) return null;
  return ASSESSMENT_HAPPY_PATH[index + 1] ?? null;
}

// --------------------------------------------------------------------------
// Generic transition checking
// --------------------------------------------------------------------------

export interface TransitionResult {
  allowed: boolean;
  reason?: string;
}

function check<T extends string>(
  table: Record<T, readonly T[]>,
  label: string,
  from: T,
  to: T,
): TransitionResult {
  if (from === to) return { allowed: true };
  const permitted = table[from];
  if (!permitted) return { allowed: false, reason: `Unknown ${label} status "${from}".` };
  if (!permitted.includes(to)) {
    return {
      allowed: false,
      reason: `Illegal ${label} transition "${from}" → "${to}". Permitted: ${
        permitted.length > 0 ? permitted.join(', ') : '(none — terminal)'
      }.`,
    };
  }
  return { allowed: true };
}

export function canTransitionCohort(from: CohortStatus, to: CohortStatus): TransitionResult {
  return check(COHORT_TRANSITIONS, 'cohort', from, to);
}

export function canTransitionSubmission(
  from: SubmissionStatus,
  to: SubmissionStatus,
): TransitionResult {
  return check(SUBMISSION_TRANSITIONS, 'submission', from, to);
}

export function canTransitionAssessment(
  from: AssessmentStage,
  to: AssessmentStage,
): TransitionResult {
  return check(ASSESSMENT_TRANSITIONS, 'assessment', from, to);
}

/** Throwing variants for call sites where an illegal transition is a bug. */
export function assertCohortTransition(from: CohortStatus, to: CohortStatus): void {
  const result = canTransitionCohort(from, to);
  if (!result.allowed) throw new Error(result.reason);
}

export function assertSubmissionTransition(from: SubmissionStatus, to: SubmissionStatus): void {
  const result = canTransitionSubmission(from, to);
  if (!result.allowed) throw new Error(result.reason);
}

export function assertAssessmentTransition(from: AssessmentStage, to: AssessmentStage): void {
  const result = canTransitionAssessment(from, to);
  if (!result.allowed) throw new Error(result.reason);
}

// --------------------------------------------------------------------------
// Derived permissions
// --------------------------------------------------------------------------

export function isCohortAcceptingSubmissions(status: CohortStatus): boolean {
  return COHORT_ACCEPTING_STATUSES.includes(status);
}

/**
 * A participant may edit only when the cohort is open AND their submission is
 * in an editable state. Both conditions, always — a reopened submission in a
 * closed cohort stays read-only.
 */
export function canParticipantEdit(
  cohortStatus: CohortStatus,
  submissionStatus: SubmissionStatus,
): boolean {
  return (
    isCohortAcceptingSubmissions(cohortStatus) &&
    SUBMISSION_EDITABLE_STATUSES.includes(submissionStatus)
  );
}

export function isSubmittedForAssessment(status: SubmissionStatus): boolean {
  return SUBMISSION_FINAL_STATUSES.includes(status);
}
