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
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  ADMIN_SEED_USERNAME: z.string().optional(),
  ADMIN_SEED_PASSWORD: z.string().optional(),
  ADMIN_SESSION_SECRET: z.string().optional(),

  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  CREDENTIAL_KEY_VERSION: positiveInt(1),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  AI_PROVIDER: z.enum(['demo', 'anthropic', 'openai', 'custom']).default('demo'),
  AI_MODEL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_MAX_RETRIES: positiveInt(2),
  AI_TIMEOUT_MS: positiveInt(60_000),

  WORKER_ID: z.string().optional(),
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
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
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
    if (!env.DATABASE_URL && !env.SUPABASE_URL) {
      problems.push('DATABASE_URL or SUPABASE_URL must be set when DEMO_MODE is off.');
    }
    if (env.AI_PROVIDER !== 'demo' && !env.AI_API_KEY) {
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
