import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataStore } from './store';
import { DEMO_COHORT_ID, DEMO_TEAMS, demoSubmissionId } from '../../fixtures/demo';
import {
  ASSESSMENT_OUTCOMES,
  SUBMISSIONS_AUDIT_HEADERS,
  buildSubmissionsAuditCsv,
  classifyOutcome,
  explainOutcome,
  summariseSubmissionAudit,
} from '../../domain/submission-audit';
import { parseCsv } from '../../utils/csv';

/**
 * The audit on the memory driver, over the demo cohort: every demo submission
 * comes back exactly once, the demo's non-complete scenarios are explained
 * from their records, and the CSV has one row per submission.
 */

let store: MemoryDataStore;

beforeEach(async () => {
  store = new MemoryDataStore();
  await store.whenReady();
});

describe('listSubmissionAudit (memory)', () => {
  it('returns every demo submission exactly once, each in one outcome bucket', async () => {
    const expected = DEMO_TEAMS.map((team) => demoSubmissionId(team.groupNumber)).sort();
    const rows = await store.ranking.listSubmissionAudit(DEMO_COHORT_ID);

    expect(rows.length).toBe(expected.length);
    expect(new Set(rows.map((r) => r.submissionId)).size).toBe(expected.length);
    expect(rows.map((r) => r.submissionId).sort()).toEqual(expected);

    for (const row of rows) {
      expect(ASSESSMENT_OUTCOMES).toContain(classifyOutcome(row));
      expect(row.cohortId).toBe(DEMO_COHORT_ID);
    }
    const summary = summariseSubmissionAudit(rows);
    const bucketed =
      summary.ranked +
      summary.completedUnranked +
      summary.needsHumanReview +
      summary.failed +
      summary.disqualified +
      summary.incomplete +
      summary.notAssessed;
    expect(bucketed).toBe(summary.total);
  });

  it('explains the demo scenarios from their records', async () => {
    const rows = await store.ranking.listSubmissionAudit(DEMO_COHORT_ID);
    const byGroup = new Map(rows.map((r) => [r.groupNumber, r]));

    for (const team of DEMO_TEAMS) {
      const row = byGroup.get(team.groupNumber);
      expect(row, `group ${team.groupNumber}`).toBeDefined();
      expect(row!.submissionId).toBe(demoSubmissionId(team.groupNumber));
      const outcome = classifyOutcome(row!);
      const explained = explainOutcome(row!);
      if (outcome === 'Completed') {
        expect(explained.failureCategory).toBe('');
      } else {
        expect(explained.failureCategory, `group ${team.groupNumber} (${team.scenario})`).not.toBe('');
        expect(explained.explanation).not.toBe('');
      }
    }

    // The inaccessible product never reached judging on product behaviour.
    const inaccessible = byGroup.get(33)!;
    expect(classifyOutcome(inaccessible)).not.toBe('Completed');
    expect(explainOutcome(inaccessible).reasonSource).not.toBe('Not recorded');

    // The low-confidence product is completed and under review, not failed.
    const lowConfidence = byGroup.get(61)!;
    expect(classifyOutcome(lowConfidence)).toBe('Completed');
    expect(lowConfidence.manualReviewFlags.length + Number(lowConfidence.summary?.lowConfidence ?? 0)).toBeGreaterThan(0);
  });

  it('writes one CSV row per submission', async () => {
    const rows = await store.ranking.listSubmissionAudit(DEMO_COHORT_ID);
    const [headers, ...records] = parseCsv(buildSubmissionsAuditCsv(rows));
    expect(headers).toEqual([...SUBMISSIONS_AUDIT_HEADERS]);
    expect(records).toHaveLength(rows.length);
  });
});
