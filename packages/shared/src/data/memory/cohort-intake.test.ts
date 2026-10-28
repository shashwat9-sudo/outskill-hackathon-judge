import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDataStore } from './store';
import { DEMO_COHORT_ID, DEMO_ASSESSMENT_CONFIG } from '../../fixtures/demo';
import { RUBRIC_VERSION } from '../../rubric/index';

/**
 * The per-cohort intake mapping and the judging gate on the memory driver —
 * the same rules the Postgres driver enforces, so demo mode and tests behave
 * as production does.
 */

let store: MemoryDataStore;

async function cohort(name: string, code: string) {
  return store.cohorts.createCohort({
    name,
    code,
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: new Date('2026-10-28T00:00:00Z'),
    day13DeadlineAt: new Date('2026-10-30T04:30:00Z'),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: RUBRIC_VERSION,
    assessmentConfig: DEMO_ASSESSMENT_CONFIG,
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
    intakeMode: 'sheet',
  });
}

beforeEach(async () => {
  store = new MemoryDataStore();
  await store.whenReady();
});

describe('updateCohortIntake', () => {
  it('maps each external id and each tab to exactly one cohort', async () => {
    const ist = await cohort('AIAP C15 IST', 'C15IST');
    const est = await cohort('AIAP C15 EST', 'C15EST');
    await store.cohorts.updateCohortIntake(ist.id, {
      intakeMode: 'sheet',
      externalCohortId: 'AIAP-C15-IST',
      intakeSpreadsheetId: 'HackathonGroupAllocator0000000001',
      intakeTabName: 'Submissions - AIAP C15 IST',
      intakeTimezone: 'Asia/Kolkata',
    });
    await store.cohorts.updateCohortIntake(est.id, {
      intakeMode: 'sheet',
      externalCohortId: 'AIAP-C15-EST',
      intakeSpreadsheetId: 'HackathonGroupAllocator0000000001',
      intakeTabName: 'Submissions - AIAP C15 EST',
      intakeTimezone: 'America/New_York',
    });
    expect((await store.cohorts.getCohortByExternalId('AIAP-C15-IST'))?.id).toBe(ist.id);
    expect((await store.cohorts.getCohortByExternalId('AIAP-C15-EST'))?.id).toBe(est.id);
    expect(await store.cohorts.getCohortByExternalId('AIAP-C15-XYZ')).toBeNull();

    await expect(
      store.cohorts.updateCohortIntake(est.id, {
        intakeMode: 'sheet',
        externalCohortId: 'AIAP-C15-IST',
        intakeSpreadsheetId: 'HackathonGroupAllocator0000000001',
        intakeTabName: 'Submissions - AIAP C15 EST',
        intakeTimezone: null,
      }),
    ).rejects.toThrow(/already used by cohort "AIAP C15 IST"/);
    await expect(
      store.cohorts.updateCohortIntake(est.id, {
        intakeMode: 'sheet',
        externalCohortId: 'AIAP-C15-EST',
        intakeSpreadsheetId: 'HackathonGroupAllocator0000000001',
        intakeTabName: 'submissions - aiap c15 ist',
        intakeTimezone: null,
      }),
    ).rejects.toThrow(/already read by cohort "AIAP C15 IST"/);
  });

  it('is the only way the external id and tab change', async () => {
    const ist = await cohort('AIAP C15 IST', 'C15IST');
    await store.cohorts.updateCohort(ist.id, { externalCohortId: 'X', intakeTabName: 'Y' } as never);
    const after = await store.cohorts.getCohort(ist.id);
    expect(after?.externalCohortId).toBeNull();
    expect(after?.intakeTabName).toBeNull();
    const portal = await store.cohorts.updateCohortIntake(ist.id, {
      intakeMode: 'portal',
      externalCohortId: 'ignored',
      intakeSpreadsheetId: 'ignored',
      intakeTabName: 'ignored',
      intakeTimezone: 'ignored',
    });
    expect(portal.externalCohortId).toBeNull();
    expect(portal.intakeTabName).toBeNull();
    expect(portal.intakeTimezone).toBeNull();
  });
});

describe('the judging gate', () => {
  it('claims nothing from a cohort whose judging has not been started', async () => {
    // The demo cohort is open with resolved jobs; re-queue one and leave the
    // cohort open: importing is not starting.
    const { demoSubmissionId } = await import('../../fixtures/demo');
    await store.assessment.enqueueSubmission(demoSubmissionId(12));
    expect(await store.assessment.claimJobs({ workerId: 'w', limit: 10, leaseSeconds: 60 })).toHaveLength(0);

    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'closed');
    expect(await store.assessment.claimJobs({ workerId: 'w', limit: 10, leaseSeconds: 60 })).toHaveLength(0);

    await store.cohorts.setCohortStatus(DEMO_COHORT_ID, 'judging');
    const claimed = await store.assessment.claimJobs({ workerId: 'w', limit: 10, leaseSeconds: 60 });
    expect(claimed.map((j) => j.submissionId)).toEqual([demoSubmissionId(12)]);
  });
});
