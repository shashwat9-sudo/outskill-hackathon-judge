/**
 * Optimistic concurrency for shared team editing.
 *
 * Several members can hold the same access code and edit at once. Last-write-
 * wins would silently discard a teammate's work minutes before a deadline, so
 * every write carries the version the client last read and the server rejects
 * anything stale.
 *
 * The client then reloads, and the team is told plainly what happened rather
 * than discovering it after submitting.
 */

export interface VersionedWrite {
  /** The version the client believes it is editing. */
  expectedVersion: number;
  /** The version currently stored. */
  currentVersion: number;
}

export type ConcurrencyOutcome =
  | { ok: true; nextVersion: number }
  | { ok: false; reason: 'stale'; currentVersion: number; message: string };

export const STALE_WRITE_MESSAGE =
  'Another team member updated this submission. We loaded the latest version. Review your changes before saving again.';

/**
 * Check a versioned write.
 *
 * A client that has never read a version (`expectedVersion < 0`) is treated as
 * stale rather than allowed through — an unversioned write is exactly the
 * silent overwrite this exists to prevent.
 */
export function checkVersion({ expectedVersion, currentVersion }: VersionedWrite): ConcurrencyOutcome {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return {
      ok: false,
      reason: 'stale',
      currentVersion,
      message: STALE_WRITE_MESSAGE,
    };
  }
  if (expectedVersion !== currentVersion) {
    return { ok: false, reason: 'stale', currentVersion, message: STALE_WRITE_MESSAGE };
  }
  return { ok: true, nextVersion: currentVersion + 1 };
}

// --------------------------------------------------------------------------
// Team activity
// --------------------------------------------------------------------------

/**
 * Activity a team may see about itself.
 *
 * Deliberately a small closed set. The internal audit log records far more —
 * admin actions, credential reveals, disqualification steps — and none of that
 * belongs in the learner portal.
 */
export const TEAM_ACTIVITY_KINDS = [
  'draft_opened',
  'section_saved',
  'deck_replaced',
  'demo_link_saved',
  'review_opened',
  'final_submitted',
] as const;

export type TeamActivityKind = (typeof TEAM_ACTIVITY_KINDS)[number];

export const TEAM_ACTIVITY_LABELS: Record<TeamActivityKind, string> = {
  draft_opened: 'opened the submission',
  section_saved: 'saved a section',
  deck_replaced: 'uploaded the pitch deck',
  demo_link_saved: 'saved the demo link',
  review_opened: 'opened the final review',
  final_submitted: 'made the final submission',
};

export interface TeamActivityEntry {
  kind: TeamActivityKind;
  editorName: string;
  section: string | null;
  at: Date;
}

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
export function relativeTime(at: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (seconds < 45) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** One line per entry for the learner-facing activity panel. */
export function describeActivity(entry: TeamActivityEntry, now: Date = new Date()): string {
  const what = TEAM_ACTIVITY_LABELS[entry.kind];
  const where = entry.section ? ` — ${entry.section}` : '';
  return `${entry.editorName} ${what}${where}, ${relativeTime(entry.at, now)}`;
}
