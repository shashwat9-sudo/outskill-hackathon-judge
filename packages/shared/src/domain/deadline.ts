/**
 * Deadline evaluation.
 *
 * The hackathon runs on Days 12–13 of a 14-day accelerator, with a deadline of
 * 11:59 PM IST on Day 13 and a private shortlist due by 10:00 AM IST on Day 14.
 *
 * Two rules matter here:
 *   1. Lateness is evaluated on the SERVER against the cohort's stored deadline.
 *      A participant's clock is never an input.
 *   2. Lateness is a FACT, not a verdict (ADR-016). This module reports whether
 *      a submission is late; whether that disqualifies anyone is a separate,
 *      reversible admin decision.
 */

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** Hours between the Day-13 deadline and the Day-14 shortlist commitment. */
export const SHORTLIST_WINDOW_HOURS = 10;

export interface DeadlineEvaluation {
  isLate: boolean;
  /** Negative before the deadline, positive after. */
  millisecondsPastDeadline: number;
  /** Human phrasing for the participant portal, e.g. "3 hours 12 minutes". */
  remainingLabel: string;
  hasPassed: boolean;
}

export function evaluateDeadline(
  deadline: Date,
  at: Date = new Date(),
): DeadlineEvaluation {
  const delta = at.getTime() - deadline.getTime();
  return {
    isLate: delta > 0,
    millisecondsPastDeadline: delta,
    remainingLabel: formatDuration(Math.abs(delta)),
    hasPassed: delta > 0,
  };
}

/**
 * Was this submission late?
 *
 * Returns false when `submittedAt` is null — an unsubmitted draft is not late,
 * it is simply not submitted. Conflating the two would let a draft be
 * auto-disqualified for lateness.
 */
export function isSubmissionLate(submittedAt: Date | null, deadline: Date): boolean {
  if (!submittedAt) return false;
  return submittedAt.getTime() > deadline.getTime();
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes > 0) return `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'}`;
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/**
 * Format an instant in a named timezone.
 *
 * Uses Intl rather than manual offset maths so IST, DST-observing zones, and
 * future rule changes are all handled by the platform's tz database.
 */
export function formatInTimezone(
  date: Date,
  timezone: string = DEFAULT_TIMEZONE,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
    ...options,
  }).format(date);
}

/** Short timezone label, e.g. "GMT+5:30", for showing alongside a formatted time. */
export function timezoneLabel(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timezone;
}

/**
 * The shortlist commitment: 10:00 AM IST on Day 14, i.e. ten hours after the
 * Day-13 deadline. Used by the queue ETA to say whether judging is on track.
 */
export function shortlistDueAt(deadline: Date): Date {
  return new Date(deadline.getTime() + SHORTLIST_WINDOW_HOURS * 3_600_000);
}

export interface ShortlistWindowStatus {
  dueAt: Date;
  remainingMs: number;
  onTrack: boolean;
  label: string;
}

/**
 * Is judging going to finish before the shortlist is due?
 *
 * `projectedCompletion` comes from the queue's own ETA calculation, so this
 * answers the operational question admins actually ask on the night.
 */
export function evaluateShortlistWindow(
  deadline: Date,
  projectedCompletion: Date | null,
  now: Date = new Date(),
): ShortlistWindowStatus {
  const dueAt = shortlistDueAt(deadline);
  const remainingMs = dueAt.getTime() - now.getTime();

  if (!projectedCompletion) {
    return {
      dueAt,
      remainingMs,
      onTrack: remainingMs > 0,
      label:
        remainingMs > 0
          ? `${formatDuration(remainingMs)} until the shortlist is due.`
          : 'The shortlist deadline has passed.',
    };
  }

  const onTrack = projectedCompletion.getTime() <= dueAt.getTime();
  const margin = Math.abs(dueAt.getTime() - projectedCompletion.getTime());
  return {
    dueAt,
    remainingMs,
    onTrack,
    label: onTrack
      ? `On track — projected to finish ${formatDuration(margin)} before the shortlist is due.`
      : `Behind — projected to finish ${formatDuration(margin)} after the shortlist is due.`,
  };
}
