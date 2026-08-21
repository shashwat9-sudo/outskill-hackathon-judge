import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from './testing/pglite';
import { buildWorkerStatusStore } from './repositories/support';
import type { WorkerStatusStore } from '../store';

/**
 * What the judging page is allowed to claim about judging.
 *
 * The admin banner described the *web* application's AI environment. Judging
 * does not run there — that tier never constructs an AI client and holds no AI
 * key, correctly — so the only states it could report were the two meaning
 * "judging is not real". A production cohort being judged against real Gemini
 * was captioned "Demo fixtures — no AI provider".
 *
 * The worker knows these things as facts about itself. This is where it says
 * so.
 */

let db: PgliteHandle;
let workers: WorkerStatusStore;

const report = {
  workerId: 'railway-judging-worker-1',
  aiProvider: 'gemini',
  aiModel: 'gemini-2.5-flash-lite',
  evaluationMode: 'production' as const,
  demoMode: false,
  concurrency: 1,
  driver: 'postgres',
  startedAt: new Date('2026-08-21T12:00:00Z'),
};

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  workers = buildWorkerStatusStore(db);
});

describe('a worker reporting itself', () => {
  it('records what it is, so the admin page does not have to guess', async () => {
    await workers.report(report);

    const [seen] = await workers.list();
    expect(seen?.aiProvider).toBe('gemini');
    expect(seen?.aiModel).toBe('gemini-2.5-flash-lite');
    expect(seen?.evaluationMode).toBe('production');
    expect(seen?.demoMode).toBe(false);
    expect(seen?.concurrency).toBe(1);
  });

  it('is safe to call on every poll, and does not accumulate rows', async () => {
    await workers.report(report);
    await workers.report(report);
    await workers.report(report);

    expect(await workers.list()).toHaveLength(1);
  });

  it('moves last seen forward while keeping the row it already had', async () => {
    await workers.report(report);
    const first = (await workers.list())[0]!;

    await new Promise((r) => setTimeout(r, 10));
    await workers.report(report);
    const second = (await workers.list())[0]!;

    expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
    expect(second.workerId).toBe(first.workerId);
  });

  it('shows a restarted worker as newly started', async () => {
    await workers.report(report);
    await workers.report({ ...report, startedAt: new Date('2026-08-21T13:00:00Z') });

    const [seen] = await workers.list();
    expect(seen?.startedAt.toISOString()).toBe('2026-08-21T13:00:00.000Z');
  });

  it('lists the most recently seen worker first', async () => {
    await workers.report({ ...report, workerId: 'worker-old' });
    await new Promise((r) => setTimeout(r, 10));
    await workers.report({ ...report, workerId: 'worker-new' });

    const seen = await workers.list();
    expect(seen[0]?.workerId).toBe('worker-new');
  });

  it('stores nothing that could carry a secret', async () => {
    /*
     * The whole reason this table exists rather than copying AI_API_KEY onto
     * the web tier: a caption is not worth widening where the provider key
     * lives. It must not quietly become somewhere a key can end up either.
     */
    await workers.report(report);

    const { rows } = await db.query<Record<string, unknown>>('select * from worker_status');
    const columns = Object.keys(rows[0]!);

    expect(columns).not.toContain('ai_api_key');
    expect(columns.some((c) => /key|secret|token|password/i.test(c))).toBe(false);
  });
});
