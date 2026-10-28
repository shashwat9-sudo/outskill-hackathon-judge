import { describe, expect, it } from 'vitest';
import {
  intakeTimezoneOf,
  isCohortIntakeMode,
  isValidTimeZone,
  validateExternalCohortId,
  validateTabName,
  wallClockToInstant,
  zoneOffsetMs,
} from './cohort-intake';
import { parseSheetTimestamp } from '../intake/sheet-rows';
import { canTransitionCohort, cohortTransitionsFor } from './status';

/**
 * Time is not a routing mechanism, but it does decide lateness — so a Form
 * timestamp must be read in the zone the sheet writes it in, with daylight
 * saving resolved for that date rather than assumed.
 */
describe('wallClockToInstant', () => {
  it('reads an Indian sheet timestamp as IST, not as server time', () => {
    const at = wallClockToInstant({ year: 2026, month: 10, day: 30, hour: 10, minute: 0, second: 0 }, 'Asia/Kolkata');
    expect(at.toISOString()).toBe('2026-10-30T04:30:00.000Z');
  });

  it('resolves New York as EDT in summer and EST in winter', () => {
    expect(
      wallClockToInstant({ year: 2026, month: 7, day: 1, hour: 20, minute: 0, second: 0 }, 'America/New_York').toISOString(),
    ).toBe('2026-07-02T00:00:00.000Z');
    expect(
      wallClockToInstant({ year: 2026, month: 12, day: 1, hour: 20, minute: 0, second: 0 }, 'America/New_York').toISOString(),
    ).toBe('2026-12-02T01:00:00.000Z');
  });

  it('handles the daylight-saving switch days without drifting an hour', () => {
    // 2026-11-01 02:30 local does not exist twice as a problem for us: 01:30
    // (before the fall-back) and 03:30 (after) must land on either side of
    // the 06:00Z boundary at which New York returns to EST.
    const before = wallClockToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 }, 'America/New_York');
    const after = wallClockToInstant({ year: 2026, month: 11, day: 1, hour: 3, minute: 30, second: 0 }, 'America/New_York');
    expect(before.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(after.toISOString()).toBe('2026-11-01T08:30:00.000Z');
    // Spring forward: 2026-03-08 03:30 EDT is 07:30Z.
    expect(
      wallClockToInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 30, second: 0 }, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
  });

  it('reports zone offsets', () => {
    expect(zoneOffsetMs(new Date('2026-10-30T00:00:00Z'), 'Asia/Kolkata')).toBe(5.5 * 3_600_000);
    expect(zoneOffsetMs(new Date('2026-07-01T00:00:00Z'), 'America/New_York')).toBe(-4 * 3_600_000);
    expect(zoneOffsetMs(new Date('2026-12-01T00:00:00Z'), 'America/New_York')).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(new Date('2026-12-01T00:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('parseSheetTimestamp with a source zone', () => {
  it('reads the Forms default shape in the configured zone', () => {
    expect(parseSheetTimestamp('2026-10-30 10:00:00', 'Asia/Kolkata')?.toISOString()).toBe('2026-10-30T04:30:00.000Z');
    expect(parseSheetTimestamp('2026-10-30 20:00', 'America/New_York')?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });

  it('decides a deadline boundary by the zone, not the server clock', () => {
    const deadline = new Date('2026-10-30T04:30:00.000Z'); // 10:00 IST
    const onTime = parseSheetTimestamp('2026-10-30 09:59:59', 'Asia/Kolkata')!;
    const late = parseSheetTimestamp('2026-10-30 10:00:01', 'Asia/Kolkata')!;
    expect(onTime.getTime() <= deadline.getTime()).toBe(true);
    expect(late.getTime() > deadline.getTime()).toBe(true);
    // The same wall-clock text in New York is a different instant.
    expect(parseSheetTimestamp('2026-10-30 09:59:59', 'America/New_York')!.getTime()).toBeGreaterThan(deadline.getTime());
  });

  it('still reads ISO and other shapes without a zone, as before', () => {
    expect(parseSheetTimestamp('2026-09-11T17:42:03Z')?.toISOString()).toBe('2026-09-11T17:42:03.000Z');
    expect(parseSheetTimestamp('')).toBeNull();
    expect(parseSheetTimestamp('not a date')).toBeNull();
  });
});

describe('intake validation', () => {
  it('accepts the C15 identifiers and refuses malformed ones', () => {
    expect(validateExternalCohortId('AIAP-C15-IST')).toBeNull();
    expect(validateExternalCohortId('AIAP-C15-EST')).toBeNull();
    expect(validateExternalCohortId('')).toMatch(/required/);
    expect(validateExternalCohortId('AIAP C15')).toMatch(/letters, digits and dashes/);
    expect(validateExternalCohortId('-x-')).toMatch(/letters, digits and dashes/);
    expect(validateTabName('Submissions - AIAP C15 IST')).toBeNull();
    expect(validateTabName('   ')).toMatch(/required/);
    expect(validateTabName('Bad/Tab')).toMatch(/cannot contain/);
    expect(validateTabName('x'.repeat(101))).toMatch(/longer than/);
  });

  it('knows real zones and refuses fixed-offset guesses', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('EST')).toBe(false);
    expect(isValidTimeZone('GMT+5:30')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isCohortIntakeMode('sheet')).toBe(true);
    expect(isCohortIntakeMode('email')).toBe(false);
    expect(intakeTimezoneOf({ timezone: 'Asia/Kolkata', intakeTimezone: null })).toBe('Asia/Kolkata');
    expect(intakeTimezoneOf({ timezone: 'Asia/Kolkata', intakeTimezone: 'America/New_York' })).toBe('America/New_York');
  });
});

describe('sheet cohort lifecycle', () => {
  it('lets a sheet-fed cohort go from draft straight to closed, and keeps the portal rule', () => {
    expect(canTransitionCohort('draft', 'closed', { intakeMode: 'sheet' }).allowed).toBe(true);
    expect(canTransitionCohort('draft', 'closed', { intakeMode: 'portal' }).allowed).toBe(false);
    expect(canTransitionCohort('draft', 'closed').allowed).toBe(false);
    expect(canTransitionCohort('closed', 'judging', { intakeMode: 'sheet' }).allowed).toBe(true);
    expect(cohortTransitionsFor('sheet').draft).toContain('closed');
    expect(cohortTransitionsFor('portal').draft).not.toContain('closed');
  });
});

describe('spreadsheet id and partner mode', () => {
  it('accepts a bare id or a full URL, and blank for the default', async () => {
    const { normaliseSpreadsheetId, validateSpreadsheetId, isExternallyFed } = await import('./cohort-intake');
    expect(normaliseSpreadsheetId('  1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789  ')).toBe('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    expect(normaliseSpreadsheetId('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0')).toBe(
      '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    );
    expect(validateSpreadsheetId('')).toBeNull();
    expect(validateSpreadsheetId('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBeNull();
    expect(validateSpreadsheetId('short')).toMatch(/long id/);
    expect(validateSpreadsheetId('has spaces in it and is long enough')).toMatch(/long id/);
    expect(isExternallyFed('partner')).toBe(true);
    expect(isExternallyFed('sheet')).toBe(true);
    expect(isExternallyFed('portal')).toBe(false);
  });

  it('treats a partner-API cohort like a sheet cohort for the lifecycle', () => {
    expect(canTransitionCohort('draft', 'closed', { intakeMode: 'partner' }).allowed).toBe(true);
    expect(cohortTransitionsFor('partner').draft).toContain('closed');
  });
});
