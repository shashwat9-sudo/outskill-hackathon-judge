import { describe, expect, it } from 'vitest';
import {
  assessCohortDeletion,
  confirmationMatches,
  DELETE_EXPLANATION,
  type CohortDependencies,
} from './cohort-deletion';

/**
 * Retiring a cohort.
 *
 * Archive is the normal action; permanent deletion exists only for a cohort
 * created by accident. The refusal is what makes it safe — no amount of
 * confirmation text protects a cohort holding real learner work.
 */

const EMPTY: CohortDependencies = {
  teams: 0,
  teamMembers: 0,
  submissions: 0,
  finalSubmissions: 0,
  artifacts: 0,
  accessCodes: 0,
  participantSessions: 0,
  assessmentJobs: 0,
  categoryScores: 0,
  rankingSnapshots: 0,
  finalSelections: 0,
  auditEntries: 0,
};

describe('an empty cohort', () => {
  it('is deletable', () => {
    expect(assessCohortDeletion('tet', EMPTY).verdict).toBe('deletable');
  });

  it('is still deletable with only audit entries', () => {
    // Creating a cohort writes one, so blocking on audit entries would make
    // deletion impossible for every cohort that has ever existed.
    const assessment = assessCohortDeletion('tet', { ...EMPTY, auditEntries: 4 });
    expect(assessment.verdict).toBe('deletable');
    expect(assessment.blockers).toEqual([]);
  });

  it('requires the cohort name as the confirmation phrase', () => {
    expect(assessCohortDeletion('tet', EMPTY).confirmationPhrase).toBe('tet');
  });
});

describe('what deletion actually does', () => {
  it('reports audit entries as PRESERVED, not removed', () => {
    // Verified against the real database: after deleting a cohort, all four of
    // its audit entries were still there. Listing them under "will remove"
    // would tell an operator the opposite of the truth.
    const assessment = assessCohortDeletion('tet', { ...EMPTY, auditEntries: 4 });

    expect(assessment.willRemove.map((r) => r.label).join(' ')).not.toMatch(/audit/i);
    expect(assessment.willPreserve).toEqual([
      { label: 'Audit entries (kept — history outlives the cohort)', count: 4 },
    ]);
  });

  it('lists what genuinely goes', () => {
    const assessment = assessCohortDeletion('tet', {
      ...EMPTY,
      teams: 3,
      accessCodes: 3,
      auditEntries: 2,
    });
    const labels = assessment.willRemove.map((r) => r.label);
    expect(labels).toContain('Teams');
    expect(labels).toContain('Access codes');
  });

  it('says the audit trail is kept, in the explanation an operator reads', () => {
    expect(DELETE_EXPLANATION).toMatch(/audit trail is kept/i);
  });

  it('omits categories with nothing in them', () => {
    expect(assessCohortDeletion('tet', EMPTY).willRemove).toEqual([]);
  });
});

describe('a cohort holding work', () => {
  const cases: [keyof CohortDependencies, RegExp][] = [
    ['finalSubmissions', /completed learner work/i],
    ['submissions', /work in progress/i],
    ['artifacts', /uploaded file/i],
    ['participantSessions', /has signed in/i],
    ['assessmentJobs', /assessment job/i],
    ['categoryScores', /score/i],
    ['rankingSnapshots', /decision may have been made/i],
    ['finalSelections', /finalist selection/i],
  ];

  for (const [key, expected] of cases) {
    it(`is refused when it has ${key}`, () => {
      const assessment = assessCohortDeletion('Real cohort', { ...EMPTY, [key]: 2 });
      expect(assessment.verdict).toBe('archive_instead');
      expect(assessment.blockers.join(' ')).toMatch(expected);
    });
  }

  it('reports every blocker, not just the first', () => {
    const assessment = assessCohortDeletion('Real', {
      ...EMPTY,
      submissions: 5,
      finalSubmissions: 2,
      artifacts: 3,
    });
    expect(assessment.blockers.length).toBeGreaterThanOrEqual(3);
  });

  it('still shows the scale of what was refused', () => {
    // Useful context: "this is what you were about to delete".
    const assessment = assessCohortDeletion('Real', { ...EMPTY, teams: 40, submissions: 38 });
    expect(assessment.willRemove.find((r) => r.label === 'Teams')?.count).toBe(40);
  });
});

describe('the confirmation phrase', () => {
  it('accepts the exact name, trimmed', () => {
    expect(confirmationMatches('PRODUCTION TEST', 'PRODUCTION TEST')).toBe(true);
    expect(confirmationMatches('  PRODUCTION TEST  ', 'PRODUCTION TEST')).toBe(true);
  });

  it('is case-sensitive', () => {
    // Case-insensitive matching would let "production test" pass for
    // "PRODUCTION TEST — DELETE LATER". Typing the name is meant to be hard to
    // do by accident.
    expect(confirmationMatches('production test', 'PRODUCTION TEST')).toBe(false);
  });

  it('rejects a partial or empty phrase', () => {
    for (const typed of ['', 'PRODUCTION', 'DELETE', 'yes']) {
      expect(confirmationMatches(typed, 'PRODUCTION TEST'), typed).toBe(false);
    }
  });
});
