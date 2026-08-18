/**
 * Environment configuration.
 *
 * Validated with Zod at startup so the process refuses to boot on bad config
 * rather than failing later in a request. Demo mode relaxes the requirements
 * that need external services, and nothing else.
 */

import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const positiveInt = (fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
    });

export const envSchema = z.object({
  DEMO_MODE: booleanish.default(false),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * The public base URL.
   *
   * Printed on every access-code sheet as the submission address, so a wrong
   * value sends every team somewhere that does not exist. The localhost default
   * is convenient for development and is REFUSED in production below.
   */
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  ADMIN_SEED_USERNAME: z.string().optional(),
  ADMIN_SEED_PASSWORD: z.string().optional(),
  ADMIN_SESSION_SECRET: z.string().optional(),

  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  CREDENTIAL_KEY_VERSION: positiveInt(1),

  SUPABASE_URL: z.string().optional(),
  /**
   * Server-side Supabase key, `sb_secret_...`. Bypasses RLS entirely, so it is
   * server-only and must never be prefixed with NEXT_PUBLIC_.
   */
  SUPABASE_SECRET_KEY: z.string().optional(),
  /**
   * The pre-2026 key for the same job. Accepted so an existing deployment keeps
   * working, but a new setup should use SUPABASE_SECRET_KEY — the legacy key is
   * being retired by Supabase and cannot be rotated independently.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  /**
   * Postgres connection string. For the serverless web tier this must be the
   * TRANSACTION pooler: a session-pooler connection holds a backend for the
   * life of the connection, and a few hundred concurrent functions exhaust the
   * server long before they exhaust the pooler (ADR-032).
   */
  DATABASE_URL: z.string().optional(),
  /** Pool ceiling per serverless instance. One or two is correct, not ten. */
  DATABASE_POOL_MAX: positiveInt(2),

  AI_PROVIDER: z
    .enum(['demo', 'anthropic', 'openai', 'gemini', 'ollama', 'custom'])
    .default('demo'),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_MAX_RETRIES: positiveInt(2),
  AI_TIMEOUT_MS: positiveInt(60_000),

  /**
   * What the external model is allowed to see.
   *
   * `synthetic_only` is the internal-evaluation setting: the pipeline will send
   * demo and test data to a provider, and refuses outright to send a real
   * learner submission. It exists because the free tier is being used to
   * evaluate the product, and free tiers are exactly where a provider's data
   * retention terms are least favourable — a learner's deck should not be the
   * thing that finds that out.
   *
   * `production` permits real cohorts. It is not the default: enabling it has
   * to be a decision somebody made.
   */
  AI_EVALUATION_MODE: z.enum(['synthetic_only', 'production']).default('synthetic_only'),

  /**
   * Shared secret authenticating the judging worker to the web app.
   *
   * The worker holds no Storage credential, so it asks the web app to mint one
   * upload authorisation at a time. This token proves the caller is our worker.
   * It is deliberately not enough on its own: every request is also checked
   * against the job it names, and every path is derived server-side.
   */
  WORKER_API_TOKEN: z.string().optional(),
  WORKER_ID: z.string().optional(),
  /** Where the worker serves /healthz and /readyz. Container-internal only. */
  WORKER_HEALTH_PORT: positiveInt(8080),
  WORKER_CONCURRENCY: positiveInt(4),
  WORKER_POLL_INTERVAL_MS: positiveInt(2000),
  BROWSER_TEST_BUDGET_MS: positiveInt(480_000),
  BROWSER_HEADLESS: booleanish.default(true),
  JOB_LEASE_SECONDS: positiveInt(900),
  JOB_MAX_ATTEMPTS: positiveInt(3),

  DEFAULT_TIMEZONE: z.string().default('Asia/Kolkata'),
  DEFAULT_SHORTLIST_TARGET: positiveInt(10),

  RETENTION_EVIDENCE_DAYS: positiveInt(90),
  RETENTION_SUBMISSION_DAYS: positiveInt(90),

  BRAND_GREEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * Parse and cross-validate.
 *
 * The cross-checks below are the ones that matter: outside demo mode, missing
 * a session secret or an encryption key is not a warning — the platform cannot
 * do its job safely without them.
 */
/**
 * What this process is, for the purposes of what it must be given.
 *
 * The checks below were written for the web tier and applied to everything,
 * which was fine until the worker existed. The worker holds no Supabase Storage
 * credential — that is the whole point of the evidence design — so demanding one
 * stopped it booting at all, while demanding nothing would have let a real web
 * deployment start with a missing key.
 *
 * Stating the role makes both cases right, and lets the worker's case be
 * enforced rather than merely tolerated.
 */
export interface LoadEnvOptions {
  /**
   * `required` — the default, and what the web tier needs: it signs URLs and
   * streams objects, so a missing key is a boot failure.
   *
   * `absent` — the worker. It must not have one, and is refused if it does.
   */
  storageCredential?: 'required' | 'absent';
}

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
  options: LoadEnvOptions = {},
): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const env = parsed.data;
  const problems: string[] = [];

  if (!env.DEMO_MODE) {
    if (!env.ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET.length < 32) {
      problems.push('ADMIN_SESSION_SECRET must be set to at least 32 characters when DEMO_MODE is off.');
    }
    if (!env.CREDENTIAL_ENCRYPTION_KEY) {
      problems.push('CREDENTIAL_ENCRYPTION_KEY must be set when DEMO_MODE is off.');
    }
    if (!env.DATABASE_URL) {
      problems.push('DATABASE_URL must be set when DEMO_MODE is off.');
    }
    if (!env.SUPABASE_URL) {
      problems.push('SUPABASE_URL must be set when DEMO_MODE is off.');
    }
    if (options.storageCredential === 'absent') {
      /*
       * The worker, and the check runs the other way.
       *
       * It reaches Storage by asking the web app for a signed URL that can write
       * one object; a key here would be a general-purpose credential held by the
       * process that drives a hostile participant's website. Refusing to start
       * is the correct response to being handed one — a warning would be
       * ignored, and the boundary is only real if it is enforced.
       */
      if (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY) {
        problems.push(
          'SUPABASE_SECRET_KEY must NOT be set for this process. It uploads evidence by asking ' +
            'the web app for a signed URL, and must hold no Storage credential of its own. ' +
            'Remove it from this environment.',
        );
      }
    } else if (!env.SUPABASE_SECRET_KEY && !env.SUPABASE_SERVICE_ROLE_KEY) {
      problems.push(
        'SUPABASE_SECRET_KEY must be set when DEMO_MODE is off (or the legacy SUPABASE_SERVICE_ROLE_KEY).',
      );
    }
    // A local APP_BASE_URL is NOT a boot failure.
    //
    // It used to be, and that was enforcement in the wrong place: running the
    // real application against the real database on this machine — which is
    // exactly what a pre-launch acceptance test is — became impossible, while
    // the actual harm was never about the server.
    //
    // The harm is a code sheet that tells five hundred teams to visit
    // localhost. That is refused where the sheet is produced
    // (`assertDistributableBaseUrl`), so the guarantee is stronger: it now
    // covers a URL that becomes local after boot, which a startup check could
    // never see.
    // Ollama runs on this machine and has nothing to authenticate against.
    if (env.AI_PROVIDER !== 'demo' && env.AI_PROVIDER !== 'ollama' && !env.AI_API_KEY) {
      problems.push(`AI_API_KEY must be set when AI_PROVIDER is "${env.AI_PROVIDER}".`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return env;
}

let cached: Env | null = null;

/** Cached accessor for request paths. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper — resets the cache between cases. */
export function resetEnvCache(): void {
  cached = null;
}

export function isDemoMode(env: Env = getEnv()): boolean {
  return env.DEMO_MODE;
}

/**
 * Retention deletion is disabled outside production and always in demo mode,
 * so a policy written for production cannot destroy local fixture work
 * (ADR-019).
 */
export function isRetentionDeletionEnabled(env: Env = getEnv()): boolean {
  return env.NODE_ENV === 'production' && !env.DEMO_MODE;
}

/**
 * The server-side Supabase key.
 *
 * Prefers the current `sb_secret_...` key and falls back to the legacy
 * service-role key so an existing deployment is not broken by the rename. Both
 * bypass RLS; neither may ever reach a browser.
 */
export function supabaseSecretKey(env: Env = getEnv()): string | undefined {
  return env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
}

/** True when only the retired key is configured, so setup can say so. */
export function usingLegacySupabaseKey(env: Env = getEnv()): boolean {
  return !env.SUPABASE_SECRET_KEY && Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
}


/** Addresses that only work on the machine serving them. */
const LOCAL_ADDRESS = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/;

export function isLocalBaseUrl(url: string): boolean {
  return LOCAL_ADDRESS.test(url);
}

/**
 * Refuse to produce anything a learner will be sent.
 *
 * Called before an access-code sheet or a distribution file is built. A local
 * address in that file sends every team somewhere that does not exist, and the
 * codes are one-time — reissuing them invalidates the sheet that was already
 * distributed, so the mistake costs a full rotation to undo.
 */
export function assertDistributableBaseUrl(baseUrl: string): void {
  if (!isLocalBaseUrl(baseUrl)) return;
  throw new ConfigError([
    `APP_BASE_URL is "${baseUrl}", which only works on this machine. ` +
      'It is printed on every access-code sheet as the submission address, so teams would be ' +
      'sent somewhere unreachable. Set it to the address learners will actually use before ' +
      'issuing codes. Running locally for testing is fine — producing a sheet is not.',
  ]);
}
