/**
 * Assessment worker.
 *
 * A polling loop, not a server. Each iteration claims jobs with a lease,
 * advances each one through its next pipeline stage, and releases it —
 * advanced, retried with backoff, or parked for a human.
 *
 * Runs as its own process so a hostile participant product cannot reach the web
 * app's memory, session secrets, or request context.
 */

import { mkdir } from 'node:fs/promises';
import { MemoryDataStore, Logger, loadEnv, type AssessmentStage, type DataStore } from '@ohj/shared';
import { createAiClientFromEnv } from '@ohj/ai';
import { runStage, type StageContext } from './pipeline';

const log = new Logger({ name: 'worker' });

async function main(): Promise<void> {
  const env = loadEnv();
  const workerId = env.WORKER_ID || `worker-${process.pid}`;

  if (!env.DEMO_MODE) {
    // The postgres driver arrives with the Supabase wiring; refusing loudly is
    // better than silently assessing fixture data as if it were real.
    throw new Error(
      'The worker currently supports DEMO_MODE=1 only. Configure DATABASE_URL and enable the postgres driver before running against real data.',
    );
  }

  const store: DataStore = new MemoryDataStore();
  const ai = createAiClientFromEnv(env);

  const evidenceRoot = `${process.cwd()}/.local-evidence`;
  await mkdir(evidenceRoot, { recursive: true });

  log.info('Worker started', {
    workerId,
    concurrency: env.WORKER_CONCURRENCY,
    budgetMs: env.BROWSER_TEST_BUDGET_MS,
    driver: store.driver,
    aiProvider: env.AI_PROVIDER,
    demoMode: env.DEMO_MODE,
  });

  let running = true;
  const shutdown = (signal: string) => {
    log.info('Shutdown requested — finishing in-flight work', { signal });
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (running) {
    try {
      // Reclaim anything a crashed worker left leased before claiming new work.
      const reclaimed = await store.assessment.reclaimExpiredLeases();
      if (reclaimed > 0) log.warn('Reclaimed expired leases', { count: reclaimed });

      const jobs = await store.assessment.claimJobs({
        workerId,
        limit: env.WORKER_CONCURRENCY,
        leaseSeconds: env.JOB_LEASE_SECONDS,
      });

      if (jobs.length === 0) {
        await sleep(env.WORKER_POLL_INTERVAL_MS);
        continue;
      }

      log.info('Claimed jobs', { count: jobs.length, stages: jobs.map((j) => j.stage) });

      await Promise.all(
        jobs.map(async (job) => {
          const context: StageContext = {
            store,
            ai,
            env,
            workerId,
            evidenceRoot,
            log: log.child(job.id.slice(0, 8)),
          };

          try {
            const next = await runStage(job, context);
            await store.assessment.advanceStage(job.id, next.stage, next.error ?? null);
            context.log.info('Stage complete', { from: job.stage, to: next.stage });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            context.log.error('Stage failed', { stage: job.stage, error: message });

            const attempt = job.attemptCount + 1;
            if (attempt >= job.maxAttempts) {
              await store.assessment.advanceStage(job.id, 'failed', message);
            } else {
              // Exponential backoff, so a flapping host is retried rather than
              // hammered.
              await store.assessment.releaseJob(job.id, {
                retryInMs: 60_000 * 2 ** (attempt - 1),
                error: message,
              });
            }
          }
        }),
      );
    } catch (error) {
      log.error('Polling iteration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(env.WORKER_POLL_INTERVAL_MS);
    }
  }

  log.info('Worker stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { AssessmentStage };

// Only auto-start when run directly, so tests can import the module freely.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  main().catch((error) => {
    log.error('Worker crashed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}
