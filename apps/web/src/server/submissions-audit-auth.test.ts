import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The all-submissions audit export is admin-only.
 *
 * It lists every product's judging outcome, failure detail and feedback text.
 * `requireAdmin` redirects anyone without an admin session before the store
 * is touched — which is what stops a caller reaching it by posting straight
 * at the server-action endpoint.
 */

const redirected = vi.fn(() => {
  throw new Error('NEXT_REDIRECT:/admin/login');
});

vi.mock('next/navigation', () => ({ redirect: redirected }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const store = {
  cohorts: { getCohort: vi.fn(async () => null as unknown) },
  ranking: { listSubmissionAudit: vi.fn(async () => [] as unknown[]), listRankedResults: vi.fn(async () => []) },
  assessment: {},
  capabilities: { assessment: true, ranking: true },
};

vi.mock('@/lib/store', () => ({
  getEnvConfig: () => ({}),
  getStoreAsync: async () => store,
}));

let session: unknown = null;
const audited = vi.fn();
vi.mock('@/server/admin-auth', async () => {
  const { redirect } = await import('next/navigation');
  return {
    getAdminSession: async () => session,
    requireAdmin: async () => {
      if (!session) redirect('/admin/login');
      return session;
    },
    assertCsrf: async () => undefined,
    auditAdminAction: audited,
    loginAdmin: vi.fn(),
    logoutAdmin: vi.fn(),
    rotateAdminCredentials: vi.fn(),
  };
});

const actions = await import('./admin-actions');

beforeEach(() => {
  session = null;
  redirected.mockClear();
  audited.mockClear();
  store.cohorts.getCohort.mockReset();
  store.ranking.listSubmissionAudit.mockReset();
});

describe('an unauthenticated caller', () => {
  it('cannot export the all-submissions audit', async () => {
    await expect(actions.exportSubmissionsAuditAction('cohort-1')).rejects.toThrow('NEXT_REDIRECT:/admin/login');
    expect(redirected).toHaveBeenCalledWith('/admin/login');
    expect(store.cohorts.getCohort).not.toHaveBeenCalled();
    expect(store.ranking.listSubmissionAudit).not.toHaveBeenCalled();
    expect(audited).not.toHaveBeenCalled();
  });
});

describe('an admin', () => {
  beforeEach(() => {
    session = { username: 'admin', csrfToken: 'x' };
    store.cohorts.getCohort.mockResolvedValue({ id: 'cohort-1', name: 'AIAP C14', code: 'AIAP C14' });
  });

  it('receives the CSV for the cohort, and the export is audited', async () => {
    store.ranking.listSubmissionAudit.mockResolvedValue([]);
    const csv = await actions.exportSubmissionsAuditAction('cohort-1');

    expect(store.ranking.listSubmissionAudit).toHaveBeenCalledWith('cohort-1');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Cohort,Cohort Code,Submission ID,Group Number');
    expect(audited).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'submissions_audit.exported',
        entityType: 'cohort',
        entityId: 'cohort-1',
        after: expect.objectContaining({ total: 0, ranked: 0 }),
      }),
    );
  });

  it('is refused for a cohort that does not exist', async () => {
    store.cohorts.getCohort.mockResolvedValue(null);
    await expect(actions.exportSubmissionsAuditAction('missing')).rejects.toThrow('Cohort not found.');
    expect(store.ranking.listSubmissionAudit).not.toHaveBeenCalled();
  });
});
