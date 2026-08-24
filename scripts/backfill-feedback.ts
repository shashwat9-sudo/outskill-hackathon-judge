/**
 * Produce the participant feedback reports that are missing, and nothing else.
 *
 * Reads the scores, browser runs and submission that already exist and asks the
 * model for the report that should have been stored at the time. It does not
 * recompute a score, regenerate a ranking, touch the shortlist, or launch a
 * browser — the judging run is finished and is treated as the source of truth.
 *
 * Idempotent: a submission that already has a report is skipped, never
 * overwritten. A report a participant may already have seen must not change
 * under them because a maintenance job ran.
 *
 * Dry by default. Pass --apply to write.
 *
 *   railway run --service judging-worker -- \
 *     npx tsx scripts/backfill-feedback.ts <cohortId> [--apply]
 *
 * Run through `railway run` so the OpenAI credential comes from the deployed
 * environment rather than a file.
 */

import { readFileSync } from 'node:fs';
import { Logger } from '../packages/shared/src/utils/logger';
import { createPostgresDatabase } from '../packages/shared/src/data/postgres/client';
import { composePostgresDataStore } from '../packages/shared/src/data/postgres/store';
import { createInMemoryStorage } from '../packages/shared/src/data/postgres/storage';
import { createAiClient } from '../packages/ai/src/provider';
import { generateFeedbackForSubmission } from '../apps/worker/src/feedback';

const log = new Logger({ name: 'backfill-feedback' });

async function main() {
  const [cohortId, ...flags] = process.argv.slice(2);
  const apply = flags.includes('--apply');
  if (!cohortId) {
    console.error('Usage: npx tsx scripts/backfill-feedback.ts <cohortId> [--apply]');
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.AI_MODEL;
  if (apply && (!apiKey || !model)) {
    console.error(
      'OPENAI_API_KEY and AI_MODEL must be present. Run through ' +
        '`railway run --service judging-worker` so the deployed configuration is used.',
    );
    process.exit(1);
  }

  const connectionString = readFileSync('.env.local', 'utf8')
    .match(/^DATABASE_URL=["']?([^"'\n]+)/m)![1]!;
  const db = await createPostgresDatabase({ connectionString });
  const store = composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: process.env.ADMIN_SESSION_SECRET ?? 's'.repeat(48),
    credentialKey: process.env.CREDENTIAL_ENCRYPTION_KEY!,
    credentialKeyVersion: 1,
  });

  const missing = await store.assessment.listJobsNeedingFeedback(cohortId);

  const { rows: totals } = await db.query<{ completed: string; with_fb: string }>(
    `select count(*) filter (where j.stage = 'completed') as completed,
            count(*) filter (where j.stage = 'completed' and f.id is not null) as with_fb
       from submissions s
       join assessment_jobs j on j.submission_id = s.id
  left join feedback_reports f on f.submission_id = s.id
      where s.cohort_id = $1 and s.status in ('submitted', 'locked')`,
    [cohortId],
  );

  console.log(`Number of completed submissions: ${totals[0]!.completed}`);
  console.log(`Number with feedback:            ${totals[0]!.with_fb}`);
  console.log(`Number missing feedback:         ${missing.length}`);
  console.log('');

  if (!apply) {
    for (const item of missing) {
      console.log(`  ${item.submissionId}  g${item.groupNumber}  ${item.productName ?? ''}`);
    }
    console.log('');
    console.log('Dry run. Nothing was written. Pass --apply to generate.');
    process.exit(0);
  }

  const ai = createAiClient({
    provider: 'openai',
    model,
    apiKey,
    maxRetries: 2,
    timeoutMs: 60_000,
  });

  let generated = 0;
  let skipped = 0;
  const failed: { submissionId: string; groupNumber: number; reason: string }[] = [];

  for (const item of missing) {
    const result = await generateFeedbackForSubmission(item.submissionId, { store, ai, log });
    if (result.ok && result.skipped) {
      skipped += 1;
      console.log(`  skip      g${item.groupNumber}  already has a report`);
    } else if (result.ok) {
      generated += 1;
      console.log(`  generated g${item.groupNumber}  ${item.productName ?? ''} (attempt ${result.attempts})`);
    } else {
      failed.push({ submissionId: item.submissionId, groupNumber: item.groupNumber, reason: result.reason });
      console.log(`  FAILED    g${item.groupNumber}  ${result.reason.slice(0, 120)}`);
    }
  }

  console.log('');
  console.log(`generated: ${generated}   skipped: ${skipped}   failed: ${failed.length}`);
  for (const f of failed) console.log(`  ${f.submissionId}  g${f.groupNumber}  ${f.reason.slice(0, 160)}`);
  process.exit(failed.length > 0 ? 2 : 0);
}

void main();
