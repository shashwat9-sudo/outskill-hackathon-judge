/**
 * Where a cohort's submissions come from.
 *
 * `portal`: teams submit through the Judge's own /submit page, which serves
 * one cohort at a time (ADR on cohort exclusivity). `sheet`: submissions are
 * imported from a named tab of the shared Google spreadsheet, and any number
 * of such cohorts may run side by side — each tab feeds exactly one cohort,
 * and the cohort an operator selects decides which tab is read. Time of day,
 * deadlines and creation order are never routing inputs.
 */

import type { Cohort } from '../data/types';

export const COHORT_INTAKE_MODES = ['portal', 'sheet'] as const;
export type CohortIntakeMode = (typeof COHORT_INTAKE_MODES)[number];

export function isCohortIntakeMode(value: unknown): value is CohortIntakeMode {
  return typeof value === 'string' && (COHORT_INTAKE_MODES as readonly string[]).includes(value);
}

export const INTAKE_MODE_LABELS: Record<CohortIntakeMode, string> = {
  portal: 'Judge participant portal',
  sheet: 'External Google Sheet intake',
};

export function isSheetCohort(cohort: Pick<Cohort, 'intakeMode'>): boolean {
  return cohort.intakeMode === 'sheet';
}

/** `AIAP-C15-IST`: letters, digits and dashes, 3–40 characters. */
export const EXTERNAL_COHORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{1,38}[A-Za-z0-9]$/;

export function normaliseExternalCohortId(value: string): string {
  return value.trim();
}

export function validateExternalCohortId(value: string): string | null {
  const id = normaliseExternalCohortId(value);
  if (!id) return 'An external cohort ID is required for a sheet-fed cohort.';
  if (!EXTERNAL_COHORT_ID_PATTERN.test(id)) {
    return 'The external cohort ID may contain letters, digits and dashes only (3–40 characters), e.g. AIAP-C15-IST.';
  }
  return null;
}

export const MAX_TAB_NAME_LENGTH = 100;

/** Trimmed; interior whitespace collapsed; never empty for a sheet cohort. */
export function normaliseTabName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function validateTabName(value: string): string | null {
  const tab = normaliseTabName(value);
  if (!tab) return 'A Google Sheet tab name is required for a sheet-fed cohort.';
  if (tab.length > MAX_TAB_NAME_LENGTH) return `The tab name is longer than ${MAX_TAB_NAME_LENGTH} characters.`;
  // Sheets forbids these in tab names; a value with one is a copy-paste error.
  if (/[[\]*?:/\\]/.test(tab)) return 'A tab name cannot contain [ ] * ? : / or \\.';
  return null;
}

/** An IANA zone the runtime knows, e.g. Asia/Kolkata or America/New_York. */
export function isValidTimeZone(value: string): boolean {
  if (!value || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * A wall-clock time in a named zone, as an instant.
 *
 * Google Forms writes `2026-09-11 17:42:03` in the spreadsheet's own zone,
 * with no offset. Reading that as server-local time would shift every
 * timestamp by the server's offset from the sheet's — on a UTC server that is
 * five and a half hours for an Indian sheet, enough to move a submission across
 * a deadline. The zone is a configured fact about the sheet; it is never
 * inferred, and daylight-saving offsets (EST vs EDT) are resolved by the
 * runtime's zone database for that date rather than assumed.
 */
export function wallClockToInstant(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): Date {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  // First guess: the offset the zone has at the UTC reading of the wall time;
  // second pass corrects the guess across a DST boundary.
  const offset1 = zoneOffsetMs(new Date(asUtc), timeZone);
  const guess = asUtc - offset1;
  const offset2 = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(asUtc - offset2);
}

/** Milliseconds east of UTC for `timeZone` at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - instant.getTime();
}

/** The zone sheet timestamps for this cohort are written in. */
export function intakeTimezoneOf(cohort: Pick<Cohort, 'timezone' | 'intakeTimezone'>): string {
  return cohort.intakeTimezone ?? cohort.timezone;
}
