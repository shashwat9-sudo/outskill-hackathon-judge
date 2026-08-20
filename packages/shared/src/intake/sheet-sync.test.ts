import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type PgliteHandle } from '../data/postgres/testing/pglite';
import { composePostgresDataStore } from '../data/postgres/store';
import { createInMemoryStorage } from '../data/postgres/storage';
import { RUBRIC_VERSION } from '../rubric/index';
import { SHEET_HEADERS } from './sheet-rows';
import { csvSource, syncSheet, maskSpreadsheetId, type SheetSource } from './sheet-sync';
import {
  EXPECTED_SERVICE_ACCOUNT,
  GOOGLE_SHEETS_SCOPE,
  checkGoogleConnectivity,
  googleSheetsSource,
  normalisePrivateKey,
} from './google-sheets';
import type { DataStore } from '../data/store';

/**
 * The operation someone runs when submissions close.
 *
 * Dry Run and Sync take the same path to the same point; only the last step
 * differs. That matters more than it sounds: an operator decides whether to
 * press Sync based on what Dry Run reported, so a dry run that walked different
 * code would be a promise the real one might not keep.
 *
 * Google is mocked throughout. The real credential is not needed to test any of
 * this, and a suite that required one could not run on a laptop or in CI.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const COHORT = 'AIAP-C13';

let db: PgliteHandle;
let store: DataStore;

const cell: Record<string, string> = {
  Timestamp: '2026-09-11 17:42:03',
  'Group Number': '12',
  Category: 'Expense Tracker',
  'Product Name': 'SpendWise',
  'Team Leader': 'Priya Sharma',
  'Team Members': 'Priya Sharma, Rahul Nair',
  'Primary Contact': 'priya@example.invalid',
  'MVP/Product Link': 'https://spendwise.example.com',
  Access: 'Open Access',
  'Login Email': '',
  'Login Password': '',
  'Brief Description': 'Shows where your money goes.',
  'Main User Action': 'Add expenses and see where most of the money went.',
  'How AI Helps': 'It categorises each expense automatically.',
  'What We Got Working': 'Adding expenses and the monthly chart.',
  'Loom Video Link': 'https://loom.com/share/abc',
  'Final Deck Link': 'https://docs.google.com/presentation/d/abc',
};

const sheetRows = (overrides: Record<string, string>[] = [{}]) => [
  [...SHEET_HEADERS],
  ...overrides.map((o) => SHEET_HEADERS.map((h) => ({ ...cell, ...o })[h] ?? '')),
];

const fakeSource = (rows: string[][]): SheetSource => ({
  read: async () => rows,
  describe: () => ({ kind: 'google_sheets', spreadsheetId: 'sheet-abcdef123456', tabName: 'Form Responses 1' }),
});

const failingSource = (message: string): SheetSource => ({
  read: async () => {
    throw new Error(message);
  },
  describe: () => ({ kind: 'google_sheets', spreadsheetId: 'sheet-abcdef123456', tabName: 'Form Responses 1' }),
});

const run = (source: SheetSource, dryRun: boolean) =>
  syncSheet({ store, source, externalCohortId: COHORT, cohortName: 'AIAP Cohort 13', dryRun });

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.truncateAll();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ($1, 'Test', true)`,
    [RUBRIC_VERSION],
  );
  store = composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: 's'.repeat(48),
    credentialKey: KEY,
    credentialKeyVersion: 1,
  });

  // The cohort exists and carries the approved ideas a Category must match.
  const synced = await store.partner!.syncCohort({
    externalCohortId: COHORT,
    name: 'AIAP Cohort 13',
  });
  await db.query(
    `insert into cohort_ideas (cohort_id, slug, title, description, target_user, expected_use_case,
       minimum_core_flow, expected_entities, is_active)
     values ($1, 'expense-tracker', 'Expense Tracker', 'd', 'u', 'c', '["s"]'::jsonb, '{"e"}', true)`,
    [synced.cohortId],
  );
});

describe('dry run', () => {
  it('reports what a real sync would do', async () => {
    const report = await run(fakeSource(sheetRows()), true);

    expect(report.dryRun).toBe(true);
    expect(report.rowsRead).toBe(1);
    expect(report.validRows).toBe(1);
    expect(report.invalidRows).toBe(0);
    expect(report.externalCohortId).toBe(COHORT);
  });

  it('writes absolutely nothing', async () => {
    /*
     * The whole value of a dry run is that an operator can press it on the day
     * without consequences. No submission, no job, no AI call, no Railway call.
     */
    const before = await db.query<{ n: string }>(
      `select (select count(*) from submissions) || '/' || (select count(*) from assessment_jobs) n`,
    );
    await run(fakeSource(sheetRows([{}, { 'Group Number': '13' }])), true);
    const after = await db.query<{ n: string }>(
      `select (select count(*) from submissions) || '/' || (select count(*) from assessment_jobs) n`,
    );

    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(after.rows[0]!.n).toBe('0/0');
  });

  it('masks the spreadsheet id so a report can be shared', async () => {
    const report = await run(fakeSource(sheetRows()), true);
    expect(report.spreadsheetId).toBe('sheet-…3456');
    expect(report.spreadsheetId).not.toContain('abcdef');
    expect(maskSpreadsheetId('short')).toBe('sh…');
  });
});

describe('sync', () => {
  it('ingests valid rows and queues one job each', async () => {
    const report = await run(fakeSource(sheetRows([{}, { 'Group Number': '13' }])), false);

    expect(report.newSubmissions).toBe(2);
    expect(report.jobsQueued).toBe(2);
    expect(report.judgeCohortId).toBeTruthy();

    const { rows } = await db.query<{ n: string }>('select count(*) n from assessment_jobs');
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('is safe to run again, because the operator will', async () => {
    await run(fakeSource(sheetRows()), false);
    const second = await run(fakeSource(sheetRows()), false);

    expect(second.alreadyIngested).toBe(1);
    expect(second.newSubmissions).toBe(0);
    expect(second.jobsQueued).toBe(0);

    const { rows } = await db.query<{ n: string }>('select count(*) n from submissions');
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('creates no duplicate when the sheet has been reordered', async () => {
    /*
     * Identity comes from the group, not the row. Sorting a sheet is the most
     * ordinary thing an operator does to it, and it must not re-judge anyone.
     */
    await run(fakeSource(sheetRows([{ 'Group Number': '12' }, { 'Group Number': '13' }])), false);
    const second = await run(
      fakeSource(sheetRows([{ 'Group Number': '13' }, { 'Group Number': '12' }])),
      false,
    );

    expect(second.alreadyIngested).toBe(2);
    expect(second.newSubmissions).toBe(0);
  });

  it('refuses both rows when a group submitted twice, and says which rows', async () => {
    const report = await run(fakeSource(sheetRows([{}, { 'Product Name': 'SpendWise v2' }])), false);

    expect(report.duplicateGroups).toEqual([{ groupNumber: 12, rows: [2, 3] }]);
    expect(report.newSubmissions).toBe(0);
    expect(JSON.stringify(report.duplicateGroups)).not.toContain('Priya');
  });

  it('seals a specific-login password and keeps it out of the report', async () => {
    const report = await run(
      fakeSource(
        sheetRows([
          {
            Access: 'Specific Login',
            'Login Email': 'judge@example.invalid',
            'Login Password': 'hunter2-secret',
          },
        ]),
      ),
      false,
    );

    expect(report.newSubmissions).toBe(1);
    expect(JSON.stringify(report)).not.toContain('hunter2-secret');

    const { rows } = await db.query<{ password_ciphertext: Buffer; ingest_snapshot: unknown }>(
      `select c.password_ciphertext, s.ingest_snapshot
         from submission_credentials c join submissions s on s.id = c.submission_id`,
    );
    expect(rows[0]!.password_ciphertext.toString('utf8')).not.toContain('hunter2-secret');
    expect(JSON.stringify(rows[0]!.ingest_snapshot)).not.toContain('hunter2-secret');
  });

  it('stores no learner PII from the sheet', async () => {
    await run(fakeSource(sheetRows()), false);
    const { rows } = await db.query<{ blob: string }>(
      `select coalesce(s.ingest_snapshot::text,'') || t.lead_name || coalesce(t.lead_email::text,'') blob
         from submissions s join teams t on t.id = s.team_id`,
    );

    for (const value of ['Priya', 'Rahul', 'priya@example.invalid']) {
      expect(rows[0]!.blob, value).not.toContain(value);
    }
    expect(rows[0]!.blob).toContain('Group 12');
  });

  it('makes submissions visible to the existing Judge admin model', async () => {
    // No second import, no access codes: they arrive as ordinary submissions.
    await run(fakeSource(sheetRows()), false);
    const { rows } = await db.query<{ id: string }>(
      `select s.id from submissions s where s.source = 'outskill-google-sheets'
          or s.source = 'outskill_hackathon'`,
    );
    expect(rows).toHaveLength(1);

    const detail = await store.submissions.getSubmissionDetail(rows[0]!.id);
    expect(detail?.submission.productName).toBe('SpendWise');
    expect(detail?.job).toBeTruthy();
  });
});

describe('when the cohort is not configured', () => {
  it('fails loudly rather than guessing', async () => {
    /*
     * A missing or mistyped cohort would put a whole sheet into the wrong
     * ranking, and nobody would notice until the Top 10 was wrong.
     */
    const report = await syncSheet({
      store,
      source: fakeSource(sheetRows()),
      externalCohortId: '',
      cohortName: 'x',
      dryRun: false,
    });

    expect(report.fatalError).toMatch(/no external cohort is configured/i);
    expect(report.newSubmissions).toBe(0);
  });
});

describe('when Google fails', () => {
  it('creates no partial work', async () => {
    /*
     * Nothing is written until the sheet has been read in full, so a failure
     * halfway cannot leave a cohort half-judged.
     */
    const report = await run(failingSource('Google rate-limited the request (429).'), false);

    expect(report.fatalError).toMatch(/429/);
    expect(report.newSubmissions).toBe(0);

    const { rows } = await db.query<{ n: string }>('select count(*) n from assessment_jobs');
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('reports a missing header as a fatal error and ingests nothing', async () => {
    const rows = sheetRows();
    rows[0] = [...SHEET_HEADERS].filter((h) => h !== 'How AI Helps');
    const report = await run(fakeSource(rows), false);

    expect(report.fatalError).toMatch(/missing required column/i);
    expect(report.newSubmissions).toBe(0);
  });
});

describe('the CSV fallback', () => {
  it('ingests identically to the sheet', async () => {
    const rows = sheetRows();
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');

    const report = await syncSheet({
      store,
      source: csvSource(csv, 'fallback.csv'),
      externalCohortId: COHORT,
      cohortName: 'AIAP Cohort 13',
      dryRun: false,
    });

    expect(report.newSubmissions).toBe(1);
    expect(report.tabName).toBe('fallback.csv');

    const { rows: stored } = await db.query<{ must_have_workflow: string }>(
      'select must_have_workflow from submissions',
    );
    expect(stored[0]!.must_have_workflow).toContain('where most of the money went');
  });
});

describe('the Google client', () => {
  /*
   * A throwaway key generated here, so the suite exercises real JWT signing
   * without needing the production credential. Nothing in CI or on a laptop
   * should require the Google service-account key to run the tests.
   */
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const config = {
    serviceAccountEmail: EXPECTED_SERVICE_ACCOUNT,
    privateKey,
    spreadsheetId: 'sheet-abcdef123456',
    tabName: 'Form Responses 1',
  };

  it('asks for the narrowest scope, not Drive', () => {
    // Drive scopes would grant reach over every file the account can see; this
    // account needs exactly one spreadsheet.
    expect(GOOGLE_SHEETS_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
    expect(GOOGLE_SHEETS_SCOPE).not.toContain('drive');
    expect(GOOGLE_SHEETS_SCOPE).toContain('readonly');
  });

  it('restores a private key that travelled through an environment variable', () => {
    const escaped = '"-----BEGIN PRIVATE KEY-----\\nabc\\ndef\\n-----END PRIVATE KEY-----\\n"';
    const restored = normalisePrivateKey(escaped);

    expect(restored).toContain('\n');
    expect(restored).not.toContain('\\n');
    expect(restored.startsWith('-----BEGIN')).toBe(true);
  });

  it('explains a 403 by naming what to share, without leaking the key', async () => {
    const fetchImpl = (async (url: string) =>
      String(url).includes('oauth2')
        ? ({ ok: true, json: async () => ({ access_token: 't' }) } as unknown as Response)
        : ({ ok: false, status: 403, json: async () => ({}) } as unknown as Response)) as typeof fetch;

    const summary = await checkGoogleConnectivity(config, fetchImpl);

    expect(summary.ok).toBe(false);
    expect(summary.error).toMatch(/share/i);
    expect(summary.error).toContain(EXPECTED_SERVICE_ACCOUNT);
    // The key itself never appears in what an operator is shown.
    expect(JSON.stringify(summary)).not.toContain('PRIVATE KEY');
  });

  it('distinguishes a missing tab from a missing spreadsheet', async () => {
    const respond = (status: number) =>
      (async (url: string) =>
        String(url).includes('oauth2')
          ? ({ ok: true, json: async () => ({ access_token: 't' }) } as unknown as Response)
          : ({ ok: false, status, json: async () => ({}) } as unknown as Response)) as typeof fetch;

    const missingTab = await checkGoogleConnectivity(config, respond(400));
    const missingSheet = await checkGoogleConnectivity(config, respond(404));

    expect(missingTab.error).toMatch(/no tab named/i);
    expect(missingSheet.error).toMatch(/no spreadsheet/i);
  });

  it('reports headers and counts, never cell values', async () => {
    /*
     * The diagnostic exists to answer "is this wired up" before the event. It
     * must never become a way to read a password out of the sheet.
     */
    const rows = sheetRows([
      { Access: 'Specific Login', 'Login Email': 'j@example.invalid', 'Login Password': 'hunter2-secret' },
    ]);
    const fetchImpl = (async (url: string) =>
      String(url).includes('oauth2')
        ? ({ ok: true, json: async () => ({ access_token: 't' }) } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({ values: rows }) } as unknown as Response)) as typeof fetch;

    const summary = await checkGoogleConnectivity(config, fetchImpl);

    expect(summary.ok).toBe(true);
    expect(summary.headers).toContain('Main User Action');
    expect(summary.rowCount).toBe(1);

    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('hunter2-secret');
    expect(serialised).not.toContain('j@example.invalid');
    expect(serialised).not.toContain('Priya');
  });

  it('warns when the credential is some other principal', async () => {
    // Authenticating as an unexpected account is not "close enough" — it means
    // the deployment is reading with a credential nobody reviewed.
    const fetchImpl = (async (url: string) =>
      String(url).includes('oauth2')
        ? ({ ok: true, json: async () => ({ access_token: 't' }) } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({ values: sheetRows() }) } as unknown as Response)) as typeof fetch;

    const summary = await checkGoogleConnectivity(
      { ...config, serviceAccountEmail: 'someone-else@example.iam.gserviceaccount.com' },
      fetchImpl,
    );

    expect(summary.matchesExpectedAccount).toBe(false);
  });

  it('never writes: the client exposes only a read', () => {
    const source = googleSheetsSource(config);
    expect(Object.keys(source).sort()).toEqual(['describe', 'read']);
  });
});
