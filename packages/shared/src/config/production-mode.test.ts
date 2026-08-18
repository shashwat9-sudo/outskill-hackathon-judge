import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnv, supabaseSecretKey, usingLegacySupabaseKey } from './env';

/**
 * Production mode fails closed.
 *
 * The failure this guards against is specific and severe: the platform starting
 * with missing configuration, quietly serving fixtures, accepting several
 * hundred real submissions into memory, and losing all of them on the next
 * restart. Refusing to start is enormously better.
 */

const COMPLETE = {
  DEMO_MODE: '0',
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@pooler.invalid:6543/postgres',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_not-a-real-key',
  ADMIN_SESSION_SECRET: 'x'.repeat(48),
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  // A real address. The localhost default is refused in production, because it
  // is printed on every access-code sheet as the submission URL.
  APP_BASE_URL: 'https://judge.outskill.test',
};

function problemsFor(overrides: Record<string, string | undefined>): string[] {
  try {
    loadEnv({ ...COMPLETE, ...overrides });
    return [];
  } catch (error) {
    return error instanceof ConfigError ? error.problems : [String(error)];
  }
}

describe('a complete production configuration', () => {
  it('loads', () => {
    const env = loadEnv(COMPLETE);
    expect(env.DEMO_MODE).toBe(false);
    expect(env.DATABASE_URL).toContain('pooler.invalid');
  });

  it('defaults the pool to a serverless-safe size', () => {
    // Per instance, and serverless multiplies it. Ten here becomes hundreds.
    expect(loadEnv(COMPLETE).DATABASE_POOL_MAX).toBeLessThanOrEqual(4);
  });
});

describe('production mode refuses to start without', () => {
  it('a database URL', () => {
    expect(problemsFor({ DATABASE_URL: undefined }).join(' ')).toMatch(/DATABASE_URL/);
  });

  it('a Supabase URL', () => {
    expect(problemsFor({ SUPABASE_URL: undefined }).join(' ')).toMatch(/SUPABASE_URL/);
  });

  it('a server-side Supabase key', () => {
    const problems = problemsFor({
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    });
    expect(problems.join(' ')).toMatch(/SUPABASE_SECRET_KEY/);
  });

  it('a session secret', () => {
    expect(problemsFor({ ADMIN_SESSION_SECRET: undefined }).join(' ')).toMatch(
      /ADMIN_SESSION_SECRET/,
    );
  });

  it('a session secret of adequate length', () => {
    expect(problemsFor({ ADMIN_SESSION_SECRET: 'too-short' }).join(' ')).toMatch(/32 characters/);
  });

  it('a credential encryption key', () => {
    expect(problemsFor({ CREDENTIAL_ENCRYPTION_KEY: undefined }).join(' ')).toMatch(
      /CREDENTIAL_ENCRYPTION_KEY/,
    );
  });

  it('anything at all', () => {
    // The bare case: DEMO_MODE=0 and nothing else configured.
    const problems = problemsFor({
      DATABASE_URL: undefined,
      SUPABASE_URL: undefined,
      SUPABASE_SECRET_KEY: undefined,
      ADMIN_SESSION_SECRET: undefined,
      CREDENTIAL_ENCRYPTION_KEY: undefined,
    });
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });

  it('reports every problem at once, not one per restart', () => {
    const problems = problemsFor({ DATABASE_URL: undefined, SUPABASE_URL: undefined });
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe('demo mode', () => {
  it('needs none of it', () => {
    const env = loadEnv({ DEMO_MODE: '1' });
    expect(env.DEMO_MODE).toBe(true);
  });

  it('is never implied by missing production configuration', () => {
    // The dangerous failure would be DEMO_MODE=0 silently behaving as 1.
    expect(() => loadEnv({ DEMO_MODE: '0' })).toThrow(ConfigError);
  });
});

describe('the Supabase key', () => {
  it('prefers the current secret key', () => {
    const env = loadEnv({
      ...COMPLETE,
      SUPABASE_SECRET_KEY: 'sb_secret_current',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role',
    });
    expect(supabaseSecretKey(env)).toBe('sb_secret_current');
    expect(usingLegacySupabaseKey(env)).toBe(false);
  });

  it('accepts the legacy service-role key so an existing deployment keeps working', () => {
    const env = loadEnv({
      ...COMPLETE,
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role',
    });
    expect(supabaseSecretKey(env)).toBe('legacy-service-role');
    expect(usingLegacySupabaseKey(env)).toBe(true);
  });

  it('is never exposed under a NEXT_PUBLIC_ name', () => {
    // A NEXT_PUBLIC_ variable is inlined into the browser bundle. Either key
    // bypasses RLS entirely, so this must not be a thing the schema accepts.
    const env = loadEnv(COMPLETE) as unknown as Record<string, unknown>;
    for (const key of Object.keys(env)) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(false);
    }
  });
});
