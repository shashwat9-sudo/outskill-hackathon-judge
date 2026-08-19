/**
 * Fixtures for the assessment tests.
 *
 * A cohort with teams and submissions is the precondition for almost every
 * assessment test, and building it inline in each file makes the tests longer
 * than the behaviour they describe. Test-only; nothing in the production path
 * imports this.
 */

import type { AssessmentConfig, Cohort, Submission } from '../../types';
import type { SqlDatabase } from '../client';
import { buildCohortStore } from '../repositories/admin';

export const CONFIG: AssessmentConfig = {
  workerConcurrency: 4,
  browserBudgetMs: 480_000,
  maxAttempts: 3,
  retryBackoffMs: 60_000,
  gracePeriodMs: 3_600_000,
  consistencyTopN: 20,
  lowConfidenceThreshold: 0.6,
  modelVersion: 'test-model',
  promptVersion: 'test-prompt',
};

/**
 * A submission window that is open right now.
 *
 * These used to be the literal dates of the first cohort, and at midnight on
 * 14 August 2026 eighteen tests failed at once: the deadline had passed, so
 * every participant write was correctly refused and every fixture that needed
 * an editable submission broke. Nothing in the product was wrong.
 *
 * Relative to the clock, so the window is open whenever the suite runs. A test
 * that needs a closed window closes it explicitly, which is clearer anyway than
 * depending on what day it is.
 */
const DAY = 24 * 60 * 60 * 1000;

export async function makeCohort(db: SqlDatabase, code = 'ASSESS'): Promise<Cohort> {
  const now = Date.now();
  return buildCohortStore(db).createCohort({
    name: `Cohort ${code}`,
    code,
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: new Date(now - DAY),
    day13DeadlineAt: new Date(now + DAY),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: 'rubric-v2',
    assessmentConfig: CONFIG,
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
  });
}

export interface SeedResult {
  cohort: Cohort;
  submissions: Submission[];
  ideaId: string;
}

/**
 * A cohort with `finalCount` locked submissions and optionally some drafts.
 *
 * Written with direct SQL rather than through the participant store: these
 * tests are about the assessment repository, and routing every fixture through
 * access codes and sessions would make a queue test fail for reasons that have
 * nothing to do with the queue.
 */
export async function seedCohortWithSubmissions(
  db: SqlDatabase,
  finalCount: number,
  options: { drafts?: number; code?: string } = {},
): Promise<SeedResult> {
  const cohort = await makeCohort(db, options.code ?? 'ASSESS');

  const { rows: ideaRows } = await db.query<{ id: string }>(
    `insert into cohort_ideas
       (cohort_id, slug, title, description, target_user, expected_use_case,
        minimum_core_flow, expected_entities, is_active)
     values ($1, 'test-idea', 'Test idea', 'A description', 'A user', 'A use case',
             '["step one"]'::jsonb, '{"thing"}', true)
     returning id`,
    [cohort.id],
  );
  const ideaId = ideaRows[0]!.id;

  const submissions: Submission[] = [];
  const total = finalCount + (options.drafts ?? 0);

  for (let i = 0; i < total; i += 1) {
    const isFinal = i < finalCount;
    const groupNumber = i + 1;

    const { rows: teamRows } = await db.query<{ id: string }>(
      `insert into teams (cohort_id, group_number, lead_phone) values ($1, $2, '') returning id`,
      [cohort.id, groupNumber],
    );
    const teamId = teamRows[0]!.id;

    const { rows } = await db.query<Record<string, unknown>>(
      `insert into submissions
         (cohort_id, team_id, idea_id, status, product_name, product_url,
          submitted_at, locked_at, receipt_id)
       values ($1, $2, $3, $4::submission_status, $5, $6, $7, $8, $9)
       returning *`,
      [
        cohort.id,
        teamId,
        ideaId,
        isFinal ? 'locked' : 'draft',
        `Product ${groupNumber}`,
        `https://product-${groupNumber}.example.com`,
        isFinal ? new Date() : null,
        isFinal ? new Date() : null,
        isFinal ? `OHJ-TEST-${String(groupNumber).padStart(4, '0')}` : null,
      ],
    );
    submissions.push(rows[0] as unknown as Submission);
  }

  return { cohort, submissions, ideaId };
}
