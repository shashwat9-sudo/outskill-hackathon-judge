import { describe, expect, it } from 'vitest';
import { cohortIdFromPath, isCohortScopedPath } from './cohort-context';

/**
 * Which cohort an admin page is about.
 *
 * This exists because of a real bug: an operator on
 * `/admin/cohorts/<paused-cohort>/ideas` saw "Cohort tet · Open" in the header,
 * because the shell named the globally active cohort instead of the one in the
 * URL. Every control on that page acts on the cohort in the URL, so a header
 * naming a different one invites edits to the wrong cohort.
 */

const A = '06af3c43-1b4e-45f1-8df4-da3f3f8e10d6';
const B = '536c4f11-a938-4fe1-96b5-84379c7c783d';

describe('a cohort-scoped path', () => {
  it('resolves the cohort in the URL, not any other', () => {
    expect(cohortIdFromPath(`/admin/cohorts/${A}/ideas`)).toBe(A);
    expect(cohortIdFromPath(`/admin/cohorts/${A}/ideas`)).not.toBe(B);
  });

  it('covers every cohort-scoped page', () => {
    for (const page of ['ideas', 'teams', 'submissions']) {
      expect(cohortIdFromPath(`/admin/cohorts/${A}/${page}`), page).toBe(A);
    }
  });

  it('resolves the bare cohort route', () => {
    expect(cohortIdFromPath(`/admin/cohorts/${A}`)).toBe(A);
  });

  it('is reported as scoped', () => {
    expect(isCohortScopedPath(`/admin/cohorts/${A}/ideas`)).toBe(true);
  });

  it('is case-insensitive but normalises, so two spellings cannot disagree', () => {
    expect(cohortIdFromPath(`/admin/cohorts/${A.toUpperCase()}/ideas`)).toBe(A);
  });
});

describe('a path that is not about one cohort', () => {
  it('resolves nothing, so those pages may fall back to the active cohort', () => {
    // There is no specific cohort on these pages to be wrong about.
    for (const path of [
      '/admin',
      '/admin/cohorts',
      '/admin/settings',
      '/admin/submissions',
      '/admin/assessment-queue',
      '/admin/ranking',
      '/admin/final-selection',
      '/admin/resources',
    ]) {
      expect(cohortIdFromPath(path), path).toBeNull();
      expect(isCohortScopedPath(path), path).toBe(false);
    }
  });

  it('does not mistake a submission id for a cohort id', () => {
    expect(cohortIdFromPath(`/admin/submissions/${A}`)).toBeNull();
  });

  it('handles a missing or empty path', () => {
    expect(cohortIdFromPath(null)).toBeNull();
    expect(cohortIdFromPath(undefined)).toBeNull();
    expect(cohortIdFromPath('')).toBeNull();
  });

  it('ignores anything that is not a real id', () => {
    // A partial or malformed id must not resolve — better to fall back than to
    // name a cohort chosen by a broken pattern match.
    for (const path of [
      '/admin/cohorts/not-a-uuid/ideas',
      '/admin/cohorts/06af3c43/ideas',
      '/admin/cohorts//ideas',
      '/admin/cohorts/06af3c43-1b4e-45f1-8df4/ideas',
    ]) {
      expect(cohortIdFromPath(path), path).toBeNull();
    }
  });

  it('is not fooled by a cohort id appearing elsewhere in the path', () => {
    expect(cohortIdFromPath(`/admin/settings?cohort=${A}`)).toBeNull();
    expect(cohortIdFromPath(`/admin/resources/${A}`)).toBeNull();
  });
});
