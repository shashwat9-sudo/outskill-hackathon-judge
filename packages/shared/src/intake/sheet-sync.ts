import type { DataStore } from '../data/store';
import { parseCsv } from '../utils/csv';
import {
  SHEET_SOURCE,
  parseSheetRows,
  sheetSubmissionId,
  type ParsedIntakeSheet,
  type SheetRowIssue,
} from './sheet-rows';

/**
 * Bringing a sheet of final submissions into the Judge.
 *
 * Deliberately a controlled operation an operator runs, not a poller that
 * watches a spreadsheet. On hackathon day the sheet is edited live — rows get
 * corrected, sorted, pasted over — and a loop reacting to every change would
 * start judging half-finished edits. Someone presses Sync when submissions have
 * closed.
 *
 * Dry Run and Sync walk exactly the same code to exactly the same point. The
 * only difference is the last step: Dry Run stops before writing anything, and
 * Sync continues. Two separate implementations would drift, and the drift would
 * show up as a dry run that promised something the real one did not do.
 */

export interface SheetSource {
  /** Rows including the header. */
  read(): Promise<string[][]>;
  /** For the report. Never a credential. */
  describe(): { kind: 'google_sheets' | 'csv'; spreadsheetId?: string; tabName?: string };
}

export interface SyncReport {
  spreadsheetId: string | null;
  tabName: string | null;
  externalCohortId: string;
  /** Null until a cohort has actually been synced. */
  judgeCohortId: string | null;
  rowsRead: number;
  blankRowsIgnored: number;
  validRows: number;
  invalidRows: number;
  duplicateGroups: { groupNumber: number; rows: number[] }[];
  newSubmissions: number;
  alreadyIngested: number;
  jobsQueued: number;
  errors: SheetRowIssue[];
  /** Something stopped the whole run: no headers, Google refused, and so on. */
  fatalError?: string;
  dryRun: boolean;
}

export interface SyncOptions {
  store: DataStore;
  source: SheetSource;
  /** Server configuration. Never a column in the sheet. */
  externalCohortId: string;
  cohortName: string;
  /** True to validate and report without writing anything. */
  dryRun: boolean;
}

/** Mask the middle of an id so a report can be shared without exposing it. */
export function maskSpreadsheetId(id: string | undefined | null): string | null {
  if (!id) return null;
  if (id.length <= 10) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/**
 * Read, validate, and — unless this is a dry run — ingest.
 *
 * Nothing is written until the sheet has been read and parsed in full. A
 * Google failure halfway through therefore cannot leave a cohort half-judged:
 * either the read succeeded and we know what we are working with, or nothing
 * happened at all.
 */
export async function syncSheet(options: SyncOptions): Promise<SyncReport> {
  const described = options.source.describe();
  const base: SyncReport = {
    spreadsheetId: maskSpreadsheetId(described.spreadsheetId),
    tabName: described.tabName ?? null,
    externalCohortId: options.externalCohortId,
    judgeCohortId: null,
    rowsRead: 0,
    blankRowsIgnored: 0,
    validRows: 0,
    invalidRows: 0,
    duplicateGroups: [],
    newSubmissions: 0,
    alreadyIngested: 0,
    jobsQueued: 0,
    errors: [],
    dryRun: options.dryRun,
  };

  if (!options.externalCohortId) {
    /*
     * The cohort is server configuration, and a missing one is a loud failure.
     *
     * Guessing, or defaulting, would put a whole cohort's submissions into the
     * wrong ranking — and nobody would notice until the Top 10 was wrong.
     */
    return { ...base, fatalError: 'No external cohort is configured for this sheet.' };
  }

  let rows: string[][];
  try {
    rows = await options.source.read();
  } catch (error) {
    // A read failure creates nothing. Reported, not retried silently.
    return {
      ...base,
      fatalError: error instanceof Error ? error.message : 'Could not read the sheet.',
    };
  }

  if (!options.store.partner) {
    return { ...base, fatalError: 'This deployment cannot ingest partner submissions.' };
  }

  /*
   * The approved ideas come from the cohort that is already mapped, when there
   * is one. On a first run there is not, so the categories are read from
   * whichever cohort the sync is about to create — which means a first dry run
   * cannot validate categories and says so rather than pretending to.
   */
  const cohorts = await options.store.cohorts.listCohorts();
  const mapped = cohorts.find(
    (c) => (c as { externalCohortId?: string }).externalCohortId === options.externalCohortId,
  );
  const approvedCategories = mapped
    ? (await options.store.cohorts.listIdeas(mapped.id)).map((i) => ({ slug: i.slug, title: i.title }))
    : [];

  const parsed: ParsedIntakeSheet = parseSheetRows(rows, { approvedCategories });

  const report: SyncReport = {
    ...base,
    judgeCohortId: mapped?.id ?? null,
    rowsRead: parsed.rowsRead,
    blankRowsIgnored: parsed.blankRowsIgnored,
    validRows: parsed.valid.length,
    invalidRows: parsed.invalid.length,
    duplicateGroups: parsed.duplicateGroups,
    errors: parsed.invalid,
    ...(parsed.fatalError ? { fatalError: parsed.fatalError } : {}),
  };

  if (parsed.fatalError) return report;

  /*
   * Dry Run stops here, having touched nothing.
   *
   * Everything above is a read and a pure transformation: no cohort was
   * created, no submission written, no job queued, no model called and nothing
   * asked of Railway. The counts an operator sees are the counts a real sync
   * would act on.
   */
  if (options.dryRun) return report;

  const synced = await options.store.partner.syncCohort({
    externalCohortId: options.externalCohortId,
    name: options.cohortName,
  });
  if (!synced.ok) return { ...report, fatalError: synced.error ?? 'Could not sync the cohort.' };
  report.judgeCohortId = synced.cohortId ?? null;

  for (const row of parsed.valid) {
    const result = await options.store.partner.ingestSubmission({
      ...row.input,
      externalCohortId: options.externalCohortId,
      externalSubmissionId: sheetSubmissionId(row.groupNumber),
      judgeCredentials: row.credentials
        ? { username: row.credentials.username, password: row.credentials.password }
        : null,
    });

    if (!result.ok) {
      report.errors.push({
        row: row.row,
        groupNumber: row.groupNumber,
        field: 'ingest',
        // The store's refusals name job state and configuration, never a secret.
        reason: result.error ?? 'Could not ingest this row.',
      });
      report.invalidRows += 1;
      continue;
    }

    if (result.duplicate) report.alreadyIngested += 1;
    else {
      report.newSubmissions += 1;
      report.jobsQueued += 1;
    }
  }

  return report;
}

/** The CSV fallback, reading the same headers through the same pipeline. */
export function csvSource(text: string, label = 'uploaded.csv'): SheetSource {
  return {
    read: async () => parseCsv(text),
    describe: () => ({ kind: 'csv', tabName: label }),
  };
}

export { SHEET_SOURCE };
