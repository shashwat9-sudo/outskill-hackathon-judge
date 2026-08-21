import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from '../data/postgres/testing/pglite';
import { composePostgresDataStore } from '../data/postgres/store';
import { createInMemoryStorage } from '../data/postgres/storage';
import { RUBRIC_VERSION } from '../rubric/index';
import { SHEET_HEADERS } from './sheet-rows';
import { syncSheet, type SheetSource } from './sheet-sync';
import type { DataStore } from '../data/store';

/**
 * A Loom link and a deck link, from the sheet cell to the worker's own read.
 *
 * Every hop of this chain worked. The sheet parser produced both URLs, the
 * partner payload carried them, and `submissions.loom_url` / `deck_url` held
 * them — the values are in production right now. What did not happen is
 * anything reading them: preflight looked in `submission_artifacts`, and the
 * `Submission` type did not declare the two columns, so nothing could.
 *
 * That made it a contract gap rather than a bug in any one function, and a gap
 * of that shape is only caught by walking the whole chain in one test. Each
 * hop tested alone would have passed, exactly as they all did.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const COHORT = 'AIAP-C13';

// The real values from the C13 sheet row that was judged as having neither.
const LOOM = 'https://www.loom.com/share/70fc0c9de0004cbc8347a5bf2e41b0fe';
const DECK = 'https://drive.google.com/open?id=1gsFyGihooBwZ3jxfsHS5V-OnJ_CzjWXk';

let db: PgliteHandle;
let store: DataStore;

const cell: Record<string, string> = {
  Timestamp: '2026-09-11 17:42:03',
  'Group Number': '102',
  Category: 'Recipe Sharing App',
  'Product Name': 'Sizzle',
  'Team Leader': 'Priya Sharma',
  'Team Members': 'Priya Sharma, Rahul Nair',
  'Primary Contact': 'priya@example.invalid',
  'MVP/Product Link': 'https://sizzle.example.com',
  Access: 'Specific Login',
  'Login Email': 'judge@example.invalid',
  'Login Password': 'correct-horse-battery',
  'Brief Description': 'Share the recipes you actually cook.',
  'Main User Action': 'Post a recipe and see it appear in the shared feed.',
  'How AI Helps': 'It writes the method from a photo of the dish.',
  'What We Got Working': 'Posting, the feed, and the AI method draft.',
  'Loom Video Link': LOOM,
  'Final Deck Link': DECK,
};

const source = (over: Record<string, string> = {}): SheetSource => ({
  read: async () => [
    [...SHEET_HEADERS],
    SHEET_HEADERS.map((h) => ({ ...cell, ...over })[h] ?? ''),
  ],
  describe: () => ({ kind: 'csv' as const, label: 'sizzle.csv' }),
});

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(`insert into rubric_versions (version, name, is_active) values ($1, 'Test', true)`, [
    RUBRIC_VERSION,
  ]);
  store = composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: 's'.repeat(48),
    credentialKey: KEY,
    credentialKeyVersion: 1,
  });
  // Seeds the approved-idea catalogue itself, so "Recipe Sharing App" is
  // already a category a row may name.
  await store.partner!.syncCohort({ externalCohortId: COHORT, name: 'AIAP Cohort 13' });
});

const importSheet = async (over: Record<string, string> = {}) => {
  const report = await syncSheet({
    store,
    source: source(over),
    externalCohortId: COHORT,
    cohortName: 'AIAP Cohort 13',
    dryRun: false,
  });
  expect(report.errors).toHaveLength(0);
  expect(report.newSubmissions).toBe(1);

  const { rows } = await db.query<{ id: string }>('select id from submissions limit 1');
  return rows[0]!.id;
};

describe('a Loom link from the sheet', () => {
  it('arrives at the read the worker judges from', async () => {
    const submissionId = await importSheet();

    const input = await store.assessment.getJudgingInput(submissionId);

    expect(input?.submission.loomUrl).toBe(LOOM);
    // And with no artifact row anywhere, which is the state every sheet
    // submission is in — no learner uploads anything into the Judge.
    expect(input?.artifacts).toHaveLength(0);
  });
});

describe('a deck link from the sheet', () => {
  it('arrives at the read the worker judges from', async () => {
    const submissionId = await importSheet();

    const input = await store.assessment.getJudgingInput(submissionId);

    expect(input?.submission.deckUrl).toBe(DECK);
    expect(input?.artifacts).toHaveLength(0);
  });

  it('is absent, not empty-string, when the team left the cell blank', async () => {
    /*
     * "No deck" and "a deck link that does not work" are reported differently,
     * so an empty cell must not arrive as a falsy-but-present string and get
     * fetched.
     */
    const submissionId = await importSheet({ 'Final Deck Link': '', 'Loom Video Link': '' });

    const input = await store.assessment.getJudgingInput(submissionId);

    expect(input?.submission.deckUrl).toBeNull();
    expect(input?.submission.loomUrl).toBeNull();
  });
});

describe('what the worker is allowed to see', () => {
  it('carries no learner PII and no login password alongside the evidence links', async () => {
    /*
     * The links now travel further than they used to — into a deck fetch and
     * into artifact analysis. Worth re-proving that nothing rode along with
     * them. The password exists and is correct; it is simply not on this path,
     * and is decrypted only when a browser fills a login form.
     */
    const submissionId = await importSheet();

    const input = await store.assessment.getJudgingInput(submissionId);
    const serialised = JSON.stringify(input);

    expect(serialised).not.toContain('correct-horse-battery');
    expect(serialised).not.toContain('judge@example.invalid');
    expect(serialised).not.toContain('Priya Sharma');
    expect(serialised).not.toContain('Rahul Nair');
    expect(serialised).not.toContain('priya@example.invalid');

    // The evidence links themselves did survive — this is not a test that
    // passes by everything being missing.
    expect(serialised).toContain(LOOM);
    expect(serialised).toContain(DECK);
  });

  it('keeps the password out of the ingest snapshot the links are stored beside', async () => {
    const submissionId = await importSheet();

    const { rows } = await db.query<{ ingest_snapshot: Record<string, unknown> }>(
      'select ingest_snapshot from submissions where id = $1',
      [submissionId],
    );
    const snapshot = rows[0]!.ingest_snapshot;

    expect(JSON.stringify(snapshot)).not.toContain('correct-horse-battery');
    expect(snapshot.loomUrl).toBe(LOOM);
    expect(snapshot.deckUrl).toBe(DECK);
  });
});
