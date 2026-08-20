import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Nobody without an admin session gets near the sheet.
 *
 * These actions read a spreadsheet full of learner submissions and can import a
 * whole cohort. `requireAdmin` redirects an unauthenticated caller to the login
 * page before any of that happens — which is what stops someone reaching them
 * by posting straight at the server-action endpoint.
 */

const redirected = vi.fn(() => {
  throw new Error('NEXT_REDIRECT:/admin/login');
});

vi.mock('next/navigation', () => ({ redirect: redirected }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/store', () => ({
  getEnvConfig: () => ({}),
  getStoreAsync: async () => ({}),
}));

let session: unknown = null;
vi.mock('@/server/admin-auth', async () => {
  const { redirect } = await import('next/navigation');
  return {
    getAdminSession: async () => session,
    requireAdmin: async () => {
      if (!session) redirect('/admin/login');
      return session;
    },
    auditAdminAction: vi.fn(),
  };
});

const actions = await import('./intake-actions');

beforeEach(() => {
  session = null;
  redirected.mockClear();
});

describe('an unauthenticated caller', () => {
  it('cannot read the configuration', async () => {
    await expect(actions.getIntakeConfig()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirected).toHaveBeenCalledWith('/admin/login');
  });

  it('cannot test the connection', async () => {
    await expect(actions.testConnectionAction()).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it('cannot run a dry run', async () => {
    await expect(actions.dryRunAction()).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it('cannot import submissions', async () => {
    // The one that would actually change a cohort.
    await expect(actions.syncAction('abc123')).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe('an authenticated admin', () => {
  it('gets past the gate, and is then limited by configuration rather than by auth', async () => {
    session = { username: 'ops' };

    const config = await actions.getIntakeConfig();
    expect(config.configured).toBe(false);
    expect(config.missing.length).toBeGreaterThan(0);

    // No Google credentials in this test environment, so it declines — but it
    // declines for the right reason, having accepted the caller.
    const result = await actions.testConnectionAction();
    expect('error' in result && result.error).toMatch(/not configured/i);
  });

  it('refuses to import when no cohort is configured, rather than guessing', async () => {
    session = { username: 'ops' };
    const result = await actions.syncAction('abc123');

    expect(result.error).toMatch(/no cohort is configured/i);
    expect(result.report).toBeUndefined();
  });
});
