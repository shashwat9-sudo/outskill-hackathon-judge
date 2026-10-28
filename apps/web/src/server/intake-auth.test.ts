import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Nobody without an admin session gets near the sheet, and nobody gets near
 * a sheet without naming the cohort it belongs to.
 *
 * These actions read a spreadsheet full of learner submissions and can import a
 * whole cohort. `requireAdmin` redirects an unauthenticated caller to the login
 * page before any of that happens — which is what stops someone reaching them
 * by posting straight at the server-action endpoint. And every action takes
 * the cohort id (0016): the cohort carries the tab, so an action without a
 * cohort has nothing to read and refuses rather than guesses.
 */

const redirected = vi.fn(() => {
  throw new Error('NEXT_REDIRECT:/admin/login');
});

vi.mock('next/navigation', () => ({ redirect: redirected }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const sheetCohort = {
  id: 'cohort-1',
  name: 'AIAP C15 IST',
  code: 'C15IST',
  status: 'closed',
  timezone: 'Asia/Kolkata',
  intakeMode: 'sheet',
  externalCohortId: 'AIAP-C15-IST',
  intakeTabName: 'Submissions - AIAP C15 IST',
  intakeTimezone: 'Asia/Kolkata',
};
const portalCohort = { ...sheetCohort, id: 'cohort-2', name: 'Portal cohort', intakeMode: 'portal', externalCohortId: null, intakeTabName: null };

const store = {
  cohorts: {
    getCohort: vi.fn(async (id: string) => (id === 'cohort-1' ? sheetCohort : id === 'cohort-2' ? portalCohort : null)),
    listCohorts: vi.fn(async () => [sheetCohort, portalCohort]),
    listIdeas: vi.fn(async () => [{ isActive: true, definitionStatus: 'approved' }]),
  },
};

vi.mock('@/lib/store', () => ({
  getEnvConfig: () => ({}),
  getStoreAsync: async () => store,
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
    await expect(actions.getIntakeConfig('cohort-1')).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirected).toHaveBeenCalledWith('/admin/login');
  });

  it('cannot list the cohorts', async () => {
    await expect(actions.listIntakeCohorts()).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it('cannot test the connection', async () => {
    await expect(actions.testConnectionAction('cohort-1')).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it('cannot run a dry run', async () => {
    await expect(actions.dryRunAction('cohort-1')).rejects.toThrow(/NEXT_REDIRECT/);
  });

  it('cannot import submissions', async () => {
    // The one that would actually change a cohort.
    await expect(actions.syncAction('cohort-1', 'abc123')).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe('an authenticated admin', () => {
  beforeEach(() => {
    session = { username: 'ops' };
  });

  it('gets past the gate, and is then limited by configuration rather than by auth', async () => {
    const config = await actions.getIntakeConfig('cohort-1');
    expect(config.configured).toBe(false);
    expect(config.cohortId).toBe('cohort-1');
    expect(config.tabName).toBe('Submissions - AIAP C15 IST');
    expect(config.missing).toContain('Spreadsheet ID');
    // No Google credentials in this test environment, so it declines — but it
    // declines for the right reason, having accepted the caller and the cohort.
    const result = await actions.testConnectionAction('cohort-1');
    expect('error' in result && result.error).toMatch(/not configured on the server/i);
  });

  it('offers only sheet-fed cohorts for intake', async () => {
    const options = await actions.listIntakeCohorts();
    expect(options.map((o) => o.id)).toEqual(['cohort-1']);
  });

  it('refuses without a selected cohort, rather than guessing one', async () => {
    const config = await actions.getIntakeConfig(null);
    expect(config.configured).toBe(false);
    expect(config.missing).toContain('A selected cohort');
    const result = await actions.dryRunAction('');
    expect(result.error).toMatch(/select a cohort/i);
    expect(result.report).toBeUndefined();
  });

  it('refuses a cohort that does not exist or is fed by the portal', async () => {
    expect((await actions.dryRunAction('missing')).error).toMatch(/does not exist/i);
    expect((await actions.dryRunAction('cohort-2')).error).toMatch(/through the Judge portal/i);
    expect((await actions.syncAction('cohort-2', 'abc123')).error).toMatch(/through the Judge portal/i);
  });

  it('refuses an import that was not preceded by a check of this cohort', async () => {
    const result = await actions.syncAction('cohort-1', '');
    expect(result.error).toMatch(/check the sheet first/i);
    expect(result.report).toBeUndefined();
  });
});
