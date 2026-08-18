import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the worker refuses to start without.
 *
 * A worker that starts with part of its configuration missing does not sit
 * idle. It polls, claims real submissions, and fails them one after another —
 * and those failures appear in every view as though the teams had done
 * something wrong. Refusing to start is the only behaviour that keeps a
 * misconfiguration from being charged to a learner.
 *
 * These read the source rather than booting the process, because booting it
 * would need a database and a model provider — the very things whose absence
 * is under test.
 */

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), 'index.ts');

async function source(): Promise<string> {
  return readFile(SOURCE, 'utf8');
}

describe('outside demo mode the worker refuses to start', () => {
  it('without a database', async () => {
    expect(await source()).toMatch(/DATABASE_URL must be set/);
  });

  it('without an AI provider', async () => {
    // Every stage that produces a judgement needs a model. Without one the
    // worker would fail submissions for a reason that is not about the team.
    const text = await source();
    expect(text).toMatch(/AI_PROVIDER === 'demo' \|\| !env\.AI_API_KEY/);
    expect(text).toMatch(/No AI provider is configured/);
  });

  it('when the store says assessment is unavailable', async () => {
    // Checked rather than assumed: a store that cannot assess must not be
    // handed to a loop whose only purpose is assessing.
    expect(await source()).toMatch(/if \(!store\.capabilities\.assessment\)/);
  });

  it('and never falls back to fixture data', async () => {
    // A production worker quietly assessing demo fixtures would report a full
    // set of results for submissions nobody made.
    const text = await source();
    expect(text).toMatch(/will not fall back to fixture data/);

    // MemoryDataStore is reachable only through the demo branch.
    const memoryUses = [...text.matchAll(/new MemoryDataStore\(\)/g)];
    expect(memoryUses).toHaveLength(1);
    expect(text).toMatch(/env\.DEMO_MODE\s*\n?\s*\? new MemoryDataStore\(\)/);
  });
});

describe('what the worker is trusted with', () => {
  it('is not the Supabase secret key', async () => {
    /*
     * It does not mint signed URLs and does not call the Storage API, so a key
     * that bypasses RLS would be privilege with no use — and the worker is the
     * process that drives a hostile participant's website.
     *
     * This used to assert the literal `supabaseSecretKey: ''`, which stopped
     * being the mechanism: passing an empty key to `createPostgresDataStore`
     * throws `supabaseKey is required` before the worker can start, so the
     * worker now composes its store around a Storage adapter that refuses every
     * call. The invariant is the same and the enforcement is stronger, so the
     * assertion is written against the invariant rather than against a line.
     */
    const text = await source();

    // The key never enters this process, by any spelling.
    expect(text).not.toMatch(/SUPABASE_SECRET_KEY/);
    expect(text).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(text).not.toMatch(/supabaseSecretKey: env\./);
    expect(text).not.toMatch(/serviceRoleKey/);

    // And a real Storage client is never built here — the adapter that refuses
    // is what the store is composed around.
    expect(text).toMatch(/createCredentiallessStorage\(\)/);
    expect(text).not.toMatch(/createSupabaseStorage/);
  });

  it('explains why in the code, so nobody helpfully adds it later', async () => {
    expect(await source()).toMatch(/privilege it has no use for/i);
  });
});

describe('the refusals name what is missing', () => {
  it('so an operator can act on the message alone', async () => {
    const text = await source();
    for (const hint of ['DATABASE_URL', 'AI_PROVIDER', 'AI_API_KEY', 'DEMO_MODE=1']) {
      expect(text, hint).toContain(hint);
    }
  });

  it('and reassure that submissions are safe', async () => {
    // The operator reading this at 23:55 needs to know what is at stake.
    expect(await source()).toMatch(/stored safely/i);
  });
});

describe('the environment the worker will accept', () => {
  /*
   * Boot-time enforcement of the credential boundary.
   *
   * Two failures found while deploying: the shared env check demanded a Supabase
   * Storage key of every non-demo process, so the worker could not start at all;
   * and nothing stopped someone handing it one anyway. Both are the same
   * mistake — a rule written for the web tier applied to a process with a
   * different job.
   */
  const base = {
    DEMO_MODE: '0',
    DATABASE_URL: 'postgresql://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    SUPABASE_URL: 'https://example.supabase.co',
    ADMIN_SESSION_SECRET: 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'y'.repeat(48),
    AI_PROVIDER: 'demo',
  };

  it('boots without a Supabase Storage key, which the web tier requires', async () => {
    const { loadEnv } = await import('@ohj/shared');
    expect(() => loadEnv(base, { storageCredential: 'absent' })).not.toThrow();
    // The same environment is rejected for the web tier, which does need one.
    expect(() => loadEnv(base)).toThrow(/SUPABASE_SECRET_KEY must be set/);
  });

  it('refuses to start if it is given one', async () => {
    // The boundary runs both ways. A worker handed a general-purpose Storage
    // credential does not quietly accept it.
    const { loadEnv } = await import('@ohj/shared');
    for (const key of ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
      expect(
        () => loadEnv({ ...base, [key]: 'sb_secret_realkey' }, { storageCredential: 'absent' }),
        key,
      ).toThrow(/must NOT be set/);
    }
  });

  it('declares that intent in its own source, so the default cannot creep back', async () => {
    const text = await source();
    expect(text).toMatch(/storageCredential: 'absent'/);
  });
});
