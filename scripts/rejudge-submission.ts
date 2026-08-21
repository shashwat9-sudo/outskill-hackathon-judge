/**
 * Re-judge one submission, by product name, within one external cohort.
 *
 * Calls the same store function the admin's "Retry failed assessment" calls,
 * rather than issuing SQL of its own — a maintenance script that re-judges
 * differently from the button is a script that proves nothing about the button.
 *
 *   npx tsx scripts/rejudge-submission.ts AIAP-C13 Sizzle
 */

import { readFileSync } from 'node:fs';
import { createPostgresDatabase } from '../packages/shared/src/data/postgres/client';
import { buildAssessmentStore } from '../packages/shared/src/data/postgres/repositories/assessment';
import { createInMemoryStorage } from '../packages/shared/src/data/postgres/storage';

async function main() {
  const [externalCohortId, productName] = process.argv.slice(2);
  if (!externalCohortId || !productName) {
    console.error('Usage: npx tsx scripts/rejudge-submission.ts <externalCohortId> <productName>');
    process.exit(1);
  }

  const connectionString = readFileSync('.env.local', 'utf8')
    .match(/^DATABASE_URL=["']?([^"'\n]+)/m)?.[1];
  if (!connectionString) throw new Error('DATABASE_URL is not set in .env.local');

  const db = await createPostgresDatabase({ connectionString });

  // Storage is never touched by the queue path; the in-memory one keeps this
  // script from needing a Supabase credential to re-queue a job.
  const assessment = buildAssessmentStore(db, createInMemoryStorage());

  const { rows } = await db.query<{ id: string }>(
    `select s.id from submissions s
       join cohorts c on c.id = s.cohort_id
      where c.external_cohort_id = $1 and s.product_name = $2`,
    [externalCohortId, productName],
  );
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one "${productName}" in ${externalCohortId}, found ${rows.length}`);
  }
  const submissionId = rows[0]!.id;

  const before = await assessment.getJobBySubmission(submissionId);
  console.log('before:', {
    stage: before?.stage,
    attempt: before?.attemptCount,
    maxAttempts: before?.maxAttempts,
  });

  const job = await assessment.enqueueSubmission(submissionId);
  console.log('after: ', {
    stage: job.stage,
    attempt: job.attemptCount,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError,
  });

  process.exit(0);
}

void main();
