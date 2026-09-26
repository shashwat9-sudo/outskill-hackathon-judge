import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The results export and the cohort-wide feedback retry are admin-only.
 *
 * The export contains every product's scores and the private feedback text;
 * the retry changes worker queue state. `requireAdmin` redirects anyone
 * without an admin session before either does anything — which is what stops
 * a caller reaching them by posting straight at the server-action endpoint.
 */

const redirected = vi.fn(() => {
  throw new Error('NEXT_REDIRECT:/admin/login');
});

vi.mock('next/navigation', () => ({ redirect: redirected }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const store = {
  cohorts: { getCohort: vi.fn(async () => null) },
  ranking: { listRankedResults: vi.fn(async () => []) },
  assessment: { listJobsNeedingFeedback: vi.fn(async () => []), getJob: vi.fn(), setFeedbackStatus: vi.fn() },
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
  store.ranking.listRankedResults.mockReset();
});

describe('an unauthenticated caller', () => {
  it('cannot export results and feedback', async () => {
    await expect(
      actions.exportResultsFeedbackAction({ cohortId: 'c', scope: 'all' }),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(redirected).toHaveBeenCalledWith('/admin/login');
    expect(store.ranking.listRankedResults).not.toHaveBeenCalled();
  });

  it('cannot request missing feedback for a cohort', async () => {
    const form = new FormData();
    form.set('cohortId', 'c');
    await expect(actions.retryMissingFeedbackAction(form)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(store.assessment.setFeedbackStatus).not.toHaveBeenCalled();
  });
});

describe('an authenticated admin', () => {
  beforeEach(() => {
    session = { username: 'ops', csrfToken: 'csrf' };
  });

  it('is refused an unknown export scope before any read', async () => {
    store.cohorts.getCohort.mockResolvedValue({ id: 'c', code: 'C14', name: 'Cohort' } as never);
    await expect(
      actions.exportResultsFeedbackAction({ cohortId: 'c', scope: 'everything' as 'all' }),
    ).rejects.toThrow(/Unknown export scope/);
    expect(store.ranking.listRankedResults).not.toHaveBeenCalled();
  });

  it('is told plainly when there is no ranking to export yet', async () => {
    store.cohorts.getCohort.mockResolvedValue({ id: 'c', code: 'C14', name: 'Cohort' } as never);
    store.ranking.listRankedResults.mockResolvedValue([]);
    await expect(actions.exportResultsFeedbackAction({ cohortId: 'c', scope: 'all' })).rejects.toThrow(
      /No ranking snapshot/,
    );
    expect(audited).not.toHaveBeenCalled();
  });

  it('gets a named, audited file with every ranked row when a snapshot exists', async () => {
    store.cohorts.getCohort.mockResolvedValue({ id: 'c', code: 'AIAP-C14', name: 'AIAP C14 Final' } as never);
    const base = {
      cohortId: 'c', cohortName: 'AIAP C14 Final', cohortCode: 'AIAP-C14', groupNumber: 1, productName: 'P',
      ideaTitle: null, ideaSlug: null, totalScore: 50, meanConfidence: 0.7, lowConfidence: false,
      finalPosition: null, finalSelectionReason: null, assessmentStage: 'completed', submissionStatus: 'submitted',
      openManualReviewReasons: [], disqualification: null, productUrl: null, loomUrl: null, deckUrl: null,
      hasUploadedDeck: false, categoryScores: {}, feedbackStatus: 'pending' as const, feedbackError: null,
      feedbackAttempts: 0, feedback: null,
    };
    store.ranking.listRankedResults.mockResolvedValue([
      { ...base, submissionId: 's1', rank: 1, inShortlist: true },
      { ...base, submissionId: 's2', rank: 2, inShortlist: false },
    ] as never);

    const result = await actions.exportResultsFeedbackAction({ cohortId: 'c', scope: 'all' });
    expect(result.rows).toBe(2);
    expect(result.filename).toMatch(/^aiap-c14-results-feedback-.*\.csv$/);
    expect(result.csv.split('\r\n').filter(Boolean)).toHaveLength(3);
    expect(audited).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'results.exported', after: expect.objectContaining({ scope: 'all', rows: 2, ranked: 2 }) }),
    );
  });
});
