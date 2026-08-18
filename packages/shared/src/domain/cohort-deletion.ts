/**
 * Retiring a cohort.
 *
 * Two distinct operations, deliberately not one control with a checkbox:
 *
 *   ARCHIVE is the normal action. It hides the cohort from operational views and
 *   stops learners reaching it, while preserving every submission, team, access
 *   record, audit entry and later assessment. Real cohorts are always archived.
 *
 *   PERMANENT DELETE exists only for a cohort created by accident. It is
 *   irreversible and no amount of confirmation text makes it safe on a cohort
 *   holding real work — so instead of relying on the operator reading a warning,
 *   the system refuses outright when meaningful data exists.
 *
 * The dependency check below is what makes that refusal possible. It is
 * deliberately strict: anything a learner produced, anything judging produced,
 * and anything that would leave a hole in the audit trail all block deletion.
 */

/** What a cohort currently holds. Every count is read before deletion is offered. */
export interface CohortDependencies {
  teams: number;
  teamMembers: number;
  submissions: number;
  /** Submissions past draft — the ones representing real learner work. */
  finalSubmissions: number;
  artifacts: number;
  accessCodes: number;
  participantSessions: number;
  assessmentJobs: number;
  categoryScores: number;
  rankingSnapshots: number;
  finalSelections: number;
  auditEntries: number;
}

export type DeletionVerdict = 'deletable' | 'archive_instead';

export interface DeletionAssessment {
  verdict: DeletionVerdict;
  /** Plain-English reasons deletion is refused. Empty when deletable. */
  blockers: string[];
  /** What deletion WOULD remove, so the operator sees it before confirming. */
  willRemove: { label: string; count: number }[];
  /**
   * What deletion explicitly does NOT remove.
   *
   * Shown alongside `willRemove` because a Danger Zone that overstates its own
   * reach is as misleading as one that understates it — an operator who thinks
   * the audit trail disappears may avoid a safe action, or worse, believe a
   * deletion left no record.
   */
  willPreserve: { label: string; count: number }[];
  /** The phrase the operator must type. Always the cohort's own name. */
  confirmationPhrase: string;
}

/**
 * Blocking conditions.
 *
 * A cohort holding any of these represents work somebody did. `auditEntries` is
 * deliberately NOT a blocker on its own — creating a cohort writes one, so every
 * cohort has at least one and blocking on it would make deletion impossible.
 */
const BLOCKERS: {
  key: keyof CohortDependencies;
  reason: (n: number) => string;
}[] = [
  {
    key: 'finalSubmissions',
    reason: (n) => `${n} final submission${n === 1 ? '' : 's'} — this is completed learner work.`,
  },
  {
    key: 'submissions',
    reason: (n) =>
      `${n} submission${n === 1 ? '' : 's'}, including drafts. A draft is work in progress, not scratch data.`,
  },
  {
    key: 'artifacts',
    reason: (n) => `${n} uploaded file${n === 1 ? '' : 's'}.`,
  },
  {
    key: 'assessmentJobs',
    reason: (n) => `${n} assessment job${n === 1 ? '' : 's'}.`,
  },
  {
    key: 'categoryScores',
    reason: (n) => `${n} score${n === 1 ? '' : 's'}.`,
  },
  {
    key: 'rankingSnapshots',
    reason: (n) => `${n} ranking snapshot${n === 1 ? '' : 's'} — a decision may have been made from it.`,
  },
  {
    key: 'finalSelections',
    reason: (n) => `${n} finalist selection${n === 1 ? '' : 's'}.`,
  },
  {
    key: 'participantSessions',
    reason: (n) => `${n} participant session${n === 1 ? '' : 's'} — a team has signed in.`,
  },
];

const REMOVAL_LABELS: { key: keyof CohortDependencies; label: string }[] = [
  { key: 'teams', label: 'Teams' },
  { key: 'teamMembers', label: 'Team members' },
  { key: 'accessCodes', label: 'Access codes' },
  { key: 'submissions', label: 'Submissions' },
  { key: 'artifacts', label: 'Uploaded files' },
  { key: 'participantSessions', label: 'Participant sessions' },
  { key: 'assessmentJobs', label: 'Assessment jobs' },
];

/**
 * Audit entries survive.
 *
 * `audit_logs.cohort_id` is deliberately not a foreign key (migration 0005), so
 * deleting a cohort leaves its history intact. Listing them under "will remove"
 * was simply wrong, and verified so against the real database: after deleting a
 * cohort, all four of its audit entries were still present.
 */
const PRESERVED_LABELS: { key: keyof CohortDependencies; label: string }[] = [
  { key: 'auditEntries', label: 'Audit entries (kept — history outlives the cohort)' },
];

export function assessCohortDeletion(
  cohortName: string,
  dependencies: CohortDependencies,
): DeletionAssessment {
  const blockers = BLOCKERS.filter((b) => dependencies[b.key] > 0).map((b) =>
    b.reason(dependencies[b.key]),
  );

  return {
    verdict: blockers.length === 0 ? 'deletable' : 'archive_instead',
    blockers,
    // Shown whether or not deletion is allowed, so the operator can see the
    // scale of what they were about to do even when it is refused.
    willRemove: REMOVAL_LABELS.map((r) => ({ label: r.label, count: dependencies[r.key] })).filter(
      (r) => r.count > 0,
    ),
    willPreserve: PRESERVED_LABELS.map((r) => ({
      label: r.label,
      count: dependencies[r.key],
    })).filter((r) => r.count > 0),
    confirmationPhrase: cohortName,
  };
}

/**
 * Is the typed confirmation acceptable?
 *
 * Trimmed and case-sensitive. Case-insensitive matching would make a phrase like
 * "production test" pass for "PRODUCTION TEST — DELETE LATER", and the whole
 * point of typing the name is that it is hard to do by accident.
 */
export function confirmationMatches(typed: string, cohortName: string): boolean {
  return typed.trim() === cohortName.trim();
}

export const ARCHIVE_EXPLANATION =
  'Archiving keeps everything — submissions, teams, access history, audit trail and any ' +
  'assessment results — and removes the cohort from operational views. Learners can no longer ' +
  'reach it. This is the normal way to retire a cohort, and it can be undone.';

export const DELETE_EXPLANATION =
  'Permanent deletion cannot be undone and is intended only for a cohort created by mistake. ' +
  'It is refused outright if the cohort holds submissions, uploads, sessions or judging data. ' +
  'The audit trail is kept: a deletion always leaves a record of what was removed and by whom.';
