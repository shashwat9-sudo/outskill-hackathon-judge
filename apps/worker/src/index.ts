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

import { mkdir, rm } from 'node:fs/promises';
import {
  MemoryDataStore,
  Logger,
  composePostgresDataStore,
  createCredentiallessStorage,
  createPostgresDatabase,
  describeConnectionRole,
  loadEnv,
  type AssessmentStage,
  type DataStore,
  type SqlDatabase,
} from '@ohj/shared';
import { createAiClientFromEnv } from '@ohj/ai';
import { runStage, type StageContext } from './pipeline';
import { createEvidenceUploader } from './evidence-upload';
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

  /*
   * Who are we connected as?
   *
   * Asked before anything else is built. The policies in migration 0002
   * describe a worker that reads submissions, writes assessment output, and
   * cannot see the ranking tables — and none of them apply to a superuser,
   * which bypasses row-level security silently. A worker connected as
   * `postgres` has the whole database while looking correctly restricted, which
   * was the real configuration until migration 0006.
   *
   * One short-lived connection, closed immediately. The answer cannot change
   * while the process runs.
   */
  const probe = await createPostgresDatabase({
    connectionString: env.DATABASE_URL,
    maxConnections: 1,
  });
  try {
    await assertNotSuperuser(probe);
  } finally {
    await probe.close();
  }

  /*
   * Composed by hand, around a Storage adapter that refuses everything.
   *
   * `createPostgresDataStore` builds a real Supabase client, and a real client
   * needs a real key — passing an empty one throws `supabaseKey is required`
   * before the worker gets anywhere. That is not a reason to give the worker a
   * Storage credential; the whole evidence design exists so it never holds one.
   *
   * So the worker states the situation instead of pretending: a credentialless
   * adapter whose every method fails loudly. Evidence still reaches the bucket,
   * by asking the web app for a signed URL that can write exactly one object.
   */
  const db = await createPostgresDatabase({
    connectionString: env.DATABASE_URL,
    maxConnections: env.DATABASE_POOL_MAX,
  });

  const store = composePostgresDataStore(db, createCredentiallessStorage(), {
    sessionSecret: env.ADMIN_SESSION_SECRET ?? '',
    credentialKey: env.CREDENTIAL_ENCRYPTION_KEY ?? '',
    credentialKeyVersion: env.CREDENTIAL_KEY_VERSION,
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

/**
 * Refuse to judge as a superuser.
 *
 * A warning would be the wrong shape: the whole point of the least-privilege
 * role is that a mistake in the worker cannot reach beyond judging, and a
 * deployment that quietly kept superuser access would have exactly the property
 * we set out to remove. `WORKER_ALLOW_SUPERUSER_DB=1` exists for a local
 * database that has never had the roles created, and says so in the log.
 */
async function assertNotSuperuser(db: SqlDatabase): Promise<void> {
  const role = await describeConnectionRole(db);
  if (!role || !role.bypassesRls) return;

  if (process.env.WORKER_ALLOW_SUPERUSER_DB === '1') {
    log.warn('Connected to the database as a privileged role', {
      role: role.role,
      effect: 'Row-level security is not enforced for this connection.',
      allowedBy: 'WORKER_ALLOW_SUPERUSER_DB=1',
    });
    return;
  }

  throw new Error(
    `The worker is connected as "${role.role}", which bypasses row-level security. ` +
      'Judging must run as the least-privilege role. Create the login once with ' +
      "`alter role ohj_worker with login password '<from your password manager>'` and point " +
      "the worker's DATABASE_URL at it. See docs/WORKER_DEPLOYMENT.md. " +
      'Set WORKER_ALLOW_SUPERUSER_DB=1 to override on a local database.',
  );
}

async function main(): Promise<void> {
  // Declared, not inferred: this process must hold no Storage credential, and
  // is refused at boot if it is given one.
  const env = loadEnv(process.env, { storageCredential: 'absent' });
  const workerId = env.WORKER_ID || `worker-${process.pid}`;

  const store: DataStore = env.DEMO_MODE
    ? new MemoryDataStore()
    : await connectProductionStore(env);
  const ai = createAiClientFromEnv(env);

  /*
   * The staging area for captured evidence, and only that.
   *
   * Nothing durable lives here. Screenshots and traces land in this directory,
   * get uploaded, and are deleted once the web app confirms the object is in
   * the bucket. It is emptied at boot because anything left behind belongs to a
   * previous container: either it was already uploaded, or its job has long
   * since been retried by another worker, and in both cases the bytes are
   * orphans that would otherwise accumulate until the disk filled.
   */
  const evidenceRoot = `${process.cwd()}/.local-evidence`;
  await rm(evidenceRoot, { recursive: true, force: true }).catch(() => {});
  await mkdir(evidenceRoot, { recursive: true });

  /*
   * How evidence becomes durable — or, in demo mode, does not.
   *
   * Requires both a token and a base URL. Without them the worker still judges
   * and simply records no evidence paths, which is honest: the alternative is
   * writing down a local path that will not exist tomorrow.
   */
  const evidence =
    !env.DEMO_MODE && env.WORKER_API_TOKEN && env.APP_BASE_URL
      ? createEvidenceUploader({
          baseUrl: env.APP_BASE_URL,
          token: env.WORKER_API_TOKEN,
          workerId,
        })
      : undefined;

  if (!env.DEMO_MODE && !evidence) {
    log.warn('Evidence uploads are disabled', {
      reason: 'WORKER_API_TOKEN or APP_BASE_URL is not set',
      effect: 'Browser runs will be judged and recorded with no screenshot or trace paths.',
    });
  }

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
            evidence,
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
