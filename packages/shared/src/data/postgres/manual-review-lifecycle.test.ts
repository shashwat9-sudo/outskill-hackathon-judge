import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildAssessmentStore } from './repositories/assessment';
import { createInMemoryStorage } from './storage';
import { seedCohortWithSubmissions } from './testing/assessment-fixtures';
import type { AssessmentStore } from '../store';

/**
 * What a manual-review flag means after the job has run again.
 *
 * A flag saying "the browser never reached the product" is an observation about
 * one attempt. When a later attempt succeeds it stops being true, and a
 * reviewer opening the queue is sent to look at a problem that has already gone
 * away — which is how a review queue stops being believed.
 *
 * The line that matters is who raised it. This system's flags are recomputed
 * every attempt. A human's decision is not an observation and does not expire
 * because a machine ran again.
 */

let db: PgliteHandle;
let assessment: AssessmentStore;
let submissionId: string;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Test', true)`,
  );
  const seeded = await seedCohortWithSubmissions(db, 1);
  submissionId = seeded.submissions[0]!.id;
  assessment = buildAssessmentStore(db, createInMemoryStorage());
});

const raise = (reasonCode: string, raisedBy: 'system' | 'shared-admin') =>
  assessment.raiseManualReview({
    submissionId,
    reasonCode,
    detail: `${reasonCode} raised by ${raisedBy}`,
    raisedBy,
    status: 'open',
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
  });

const flags = async () => {
  const { rows } = await db.query<{
    reason_code: string;
    raised_by: string;
    status: string;
    resolution_note: string | null;
  }>(
    'select reason_code, raised_by, status, resolution_note from manual_review_flags where submission_id = $1 order by created_at',
    [submissionId],
  );
  return rows;
};

describe('a flag from an attempt that is over', () => {
  it('is retired when a new attempt begins', async () => {
    await raise('browser_never_reached_product', 'system');
    const retired = await assessment.supersedeSystemManualReview(submissionId, 'Superseded by attempt 2.');

    expect(retired).toBe(1);
    const [flag] = await flags();
    expect(flag!.status).toBe('resolved');
    expect(flag!.resolution_note).toMatch(/attempt 2/);
  });

  it('stays in the record rather than being deleted', async () => {
    /*
     * The flag is history: it is the reason a reviewer may have looked, and
     * deleting it would erase why. Retiring means resolved, not gone.
     */
    await raise('browser_never_reached_product', 'system');
    await assessment.supersedeSystemManualReview(submissionId, 'Superseded by attempt 2.');

    const all = await flags();
    expect(all).toHaveLength(1);
    expect(all[0]!.reason_code).toBe('browser_never_reached_product');
  });

  it('retires every system observation, not just the first', async () => {
    await raise('browser_never_reached_product', 'system');
    await raise('product_unreachable', 'system');
    await raise('low_confidence', 'system');

    expect(await assessment.supersedeSystemManualReview(submissionId, 'attempt 2')).toBe(3);
    expect((await flags()).every((f) => f.status === 'resolved')).toBe(true);
  });

  it('does nothing when there is nothing to retire', async () => {
    expect(await assessment.supersedeSystemManualReview(submissionId, 'attempt 2')).toBe(0);
  });

  it('leaves an already-resolved flag alone', async () => {
    // Retiring twice must not rewrite the note a human may have left.
    const flag = await raise('low_confidence', 'system');
    await assessment.resolveManualReview(flag.id, {
      status: 'resolved',
      note: 'Checked by hand — fine.',
      actor: 'ops',
    });
    await assessment.supersedeSystemManualReview(submissionId, 'attempt 2');

    expect((await flags())[0]!.resolution_note).toBe('Checked by hand — fine.');
  });
});

describe('a decision a person made', () => {
  it('survives a re-judge', async () => {
    /*
     * The half that would be dangerous to get wrong. An administrator flagging
     * a submission is not making an observation that a later run can disprove —
     * and a system that quietly cleared it would let a re-judge undo a human's
     * call without anyone noticing.
     */
    await raise('confirmed_serious_rule_violation', 'shared-admin');
    await raise('browser_never_reached_product', 'system');

    const retired = await assessment.supersedeSystemManualReview(submissionId, 'attempt 2');

    expect(retired).toBe(1);
    const all = await flags();
    const admin = all.find((f) => f.raised_by === 'shared-admin')!;
    const system = all.find((f) => f.raised_by === 'system')!;

    expect(admin.status).toBe('open');
    expect(system.status).toBe('resolved');
  });

  it('survives however many times the job is re-run', async () => {
    await raise('confirmed_serious_rule_violation', 'shared-admin');
    for (let i = 0; i < 3; i += 1) {
      await assessment.supersedeSystemManualReview(submissionId, `attempt ${i + 2}`);
    }
    expect((await flags())[0]!.status).toBe('open');
  });
});

describe('what the review queue shows afterwards', () => {
  it('no longer lists a submission whose only flag was superseded', async () => {
    await raise('browser_never_reached_product', 'system');
    await assessment.supersedeSystemManualReview(submissionId, 'attempt 2');

    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from manual_review_flags where submission_id = $1 and status = 'open'`,
      [submissionId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('still lists it when a new attempt raises the problem again', async () => {
    // Retiring is not forgiving: if the product is still unreachable, this
    // attempt says so in its own right.
    await raise('product_unreachable', 'system');
    await assessment.supersedeSystemManualReview(submissionId, 'attempt 2');
    await raise('product_unreachable', 'system');

    const open = (await flags()).filter((f) => f.status === 'open');
    expect(open).toHaveLength(1);
  });
});
