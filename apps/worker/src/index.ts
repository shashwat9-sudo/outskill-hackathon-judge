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
import {
  MemoryDataStore,
  Logger,
  createPostgresDataStore,
  loadEnv,
  type AssessmentStage,
  type DataStore,
} from '@ohj/shared';
import { createAiClientFromEnv } from '@ohj/ai';
import { runStage, type StageContext } from './pipeline';
import { stalenessLimitMs, startHealthServer, type WorkerHeartbeat } from './health';

const log = new Logger({ name: 'worker' });

/**
 * Connect the worker to production, or refuse.
 *
 * Every refusal here is a fail-closed one, and each names exactly what is
 * missing. A worker that starts with a piece of its configuration absent does
 * not stop — it polls, claims real submissions, and fails them one after
 * another. Those failures look like the teams' fault in every view that shows
 * them, so the only safe behaviour is not to start.
 *
 * The Supabase secret key is deliberately NOT passed. The worker does not mint
 * signed URLs and does not call the Storage API, so a key that bypasses RLS
 * would be privilege it has no use for. If evidence objects need writing later,
 * that gets a narrowly-scoped credential of its own — not this one.
 */
async function connectProductionStore(env: ReturnType<typeof loadEnv>): Promise<DataStore> {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL must be set to run the worker outside demo mode. It will not fall back to fixture data.',
    );
  }

  // The pipeline reads a deck, generates a test plan and produces scores, and
  // every one of those stages needs a model. Without a provider the worker
  // would claim a submission and fail it for a reason that has nothing to do
  // with the team.
  if (env.AI_PROVIDER === 'demo' || !env.AI_API_KEY) {
    throw new Error(
      'No AI provider is configured, so the worker cannot assess anything. ' +
        'Set AI_PROVIDER and AI_API_KEY, or run with DEMO_MODE=1 against fixtures. ' +
        'Final submissions are stored safely and remain available until judging is enabled.',
    );
  }

  const store = await createPostgresDataStore({
    databaseUrl: env.DATABASE_URL,
    // Unused by the worker, but the store requires them to compose. They are
    // read from the environment rather than invented so a misconfiguration
    // surfaces here rather than at the first participant request.
    supabaseUrl: env.SUPABASE_URL ?? '',
    supabaseSecretKey: '',
    sessionSecret: env.ADMIN_SESSION_SECRET ?? '',
    credentialKey: env.CREDENTIAL_ENCRYPTION_KEY ?? '',
    credentialKeyVersion: env.CREDENTIAL_KEY_VERSION,
    maxConnections: env.DATABASE_POOL_MAX,
  });

  // The claim is checked rather than assumed: a store that cannot assess must
  // not be handed to a loop whose whole purpose is assessing.
  if (!store.capabilities.assessment) {
    throw new Error(
      'This deployment declares that automated assessment is unavailable, so the worker will not start.',
    );
  }

  return store;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const workerId = env.WORKER_ID || `worker-${process.pid}`;

  const store: DataStore = env.DEMO_MODE
    ? new MemoryDataStore()
    : await connectProductionStore(env);
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

  // Readiness is derived from the loop itself, not from a timer: a heartbeat
  // that ticks on its own schedule would report healthy while the loop was
  // wedged, which is exactly the failure worth catching.
  const heartbeat: WorkerHeartbeat = {
    lastIterationAt: new Date(),
    inFlight: 0,
    draining: false,
  };

  const shutdown = (signal: string) => {
    log.info('Shutdown requested — finishing in-flight work', { signal });
    running = false;
    // Fails readiness immediately so the platform stops routing work here,
    // while liveness stays up until in-flight assessments finish.
    heartbeat.draining = true;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  startHealthServer({
    port: env.WORKER_HEALTH_PORT,
    getHeartbeat: () => heartbeat,
    stalenessMs: stalenessLimitMs(env.WORKER_POLL_INTERVAL_MS, env.BROWSER_TEST_BUDGET_MS),
  });
  log.info('Health server listening', { port: env.WORKER_HEALTH_PORT });

  while (running) {
    try {
      heartbeat.lastIterationAt = new Date();
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
      heartbeat.inFlight = jobs.length;

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
      heartbeat.inFlight = 0;
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
