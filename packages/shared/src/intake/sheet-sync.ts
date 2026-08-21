import { createHash } from 'node:crypto';
import type { DataStore } from '../data/store';
import { parseCsv } from '../utils/csv';
import {
  SHEET_SOURCE,
  parseSheetRows,
  sheetSubmissionId,
  type ParsedIntakeSheet,
  type ResubmittedGroup,
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

/** One group, as an operator needs to see it. Never a credential, never PII. */
export interface IntakeGroupRow {
  row: number;
  groupNumber: number;
  productName: string;
  category: string;
  status: 'ready' | 'already_synced' | 'changed_since_sync' | 'blocked' | 'superseded';
  /** Plain-language explanation when the status is not 'ready'. */
  issue?: string;
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
  /** Groups that submitted more than once, and which row was chosen. */
  resubmittedGroups: ResubmittedGroup[];
  newSubmissions: number;
  alreadyIngested: number;
  jobsQueued: number;
  errors: SheetRowIssue[];
  /** Per-group operator view, safe to render. */
  groups: IntakeGroupRow[];
  /**
   * A fingerprint of exactly what a sync would act on.
   *
   * The operator reads a dry run and then decides to sync. In between, a
   * learner can still edit the sheet — so the sync re-reads, re-parses and
   * compares this. A mismatch means the numbers on screen no longer describe
   * reality, and the operator is asked to look again rather than importing
   * something they never reviewed.
   */
  fingerprint: string;
  /** Groups already ingested whose sheet row has since changed. */
  changedSinceSync: { groupNumber: number; row: number }[];
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
  /**
   * The fingerprint the operator was shown when they decided to sync.
   *
   * Sync refuses if the sheet no longer matches it. Without this, a dry run
   * showing 118 submissions could be followed by a sync importing something
   * else entirely, and nobody would know until the scores came out.
   */
  expectedFingerprint?: string;
}

/**
 * What a sync would act on, reduced to a stable string.
 *
 * Built from the normalised judging inputs, so cosmetic sheet edits — a
 * reordered column, a changed team member name — do not invalidate a dry run,
 * while a changed product URL or main user action does. Credentials are
 * included only as a presence marker: a password must not reach a hash that
 * ends up in a URL, a log or a report.
 */
export function fingerprintRows(rows: { groupNumber: number; input: unknown; credentials: unknown }[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.groupNumber - b.groupNumber)
    .map((r) => ({ group: r.groupNumber, input: r.input, hasCredentials: r.credentials !== null }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/** The judging-relevant shape of a stored snapshot, for change detection. */
function snapshotFingerprint(snapshot: Record<string, unknown> | null): string | null {
  if (!snapshot) return null;
  const relevant = {
    productName: snapshot.productName,
    briefDescription: snapshot.briefDescription,
    mainUserAction: snapshot.mainUserAction,
    aiValue: snapshot.aiValue,
    whatGotWorking: snapshot.whatGotWorking,
    productUrl: snapshot.productUrl,
    accessMode: snapshot.accessMode,
    ideaSlug: snapshot.ideaSlug,
    loomUrl: snapshot.loomUrl ?? null,
    deckUrl: snapshot.deckUrl ?? null,
  };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 32);
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
    resubmittedGroups: [],
    newSubmissions: 0,
    alreadyIngested: 0,
    jobsQueued: 0,
    errors: [],
    groups: [],
    fingerprint: '',
    changedSinceSync: [],
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

  /*
   * What is already here, and whether the sheet still says the same thing.
   *
   * A group already ingested is reported as such rather than re-imported. If
   * its sheet row has since changed, that is surfaced — not silently applied.
   * Replacing an assessment because somebody edited a cell afterwards is a
   * policy decision with real consequences for a team's score, and it belongs
   * to a human, not to an import button.
   */
  const existingByGroup = new Map<number, string | null>();
  for (const entry of await options.store.partner.listIngestedSnapshots(options.externalCohortId)) {
    existingByGroup.set(entry.groupNumber, snapshotFingerprint(entry.snapshot));
  }


  const changedSinceSync: SyncReport['changedSinceSync'] = [];

  const groups: IntakeGroupRow[] = [];
  for (const row of parsed.valid) {
    const known = existingByGroup.has(row.groupNumber);
    const current = fingerprintRows([row]).slice(0, 32);
    const stored = existingByGroup.get(row.groupNumber) ?? null;
    const rowFingerprint = snapshotFingerprint({
      ...(row.input as unknown as Record<string, unknown>),
    });
    void current;

    let status: IntakeGroupRow['status'] = 'ready';
    let issue: string | undefined;
    if (known && stored && rowFingerprint && stored !== rowFingerprint) {
      status = 'changed_since_sync';
      issue = 'Already imported, but the Sheet has changed since. Not re-imported.';
      changedSinceSync.push({ groupNumber: row.groupNumber, row: row.row });
    } else if (known) {
      status = 'already_synced';
      issue = 'Already imported.';
    }

    groups.push({
      row: row.row,
      groupNumber: row.groupNumber,
      productName: row.input.productName,
      category: row.input.ideaSlug,
      status,
      ...(issue ? { issue } : {}),
    });
  }

  /*
   * Resubmissions, shown so an operator can see which row won.
   *
   * A team that resubmitted should be able to see, at a glance, that their
   * latest form response is the one being judged — and if it was not, why.
   */
  for (const group of parsed.resubmittedGroups) {
    for (const superseded of group.supersededRows) {
      groups.push({
        row: superseded,
        groupNumber: group.groupNumber,
        productName: '—',
        category: '—',
        status: 'superseded',
        issue: `Replaced by a later submission on row ${group.selectedRow}. Not imported.`,
      });
    }
    if (group.newestRejected) {
      groups.push({
        row: group.newestRejected.row,
        groupNumber: group.groupNumber,
        productName: '—',
        category: '—',
        status: 'blocked',
        issue:
          `Newer submission could not be used (${group.newestRejected.reason}) — ` +
          `row ${group.selectedRow} is being imported instead.`,
      });
    }
  }

  const explainedRows = new Set(
    parsed.resubmittedGroups.flatMap((g) => (g.newestRejected ? [g.newestRejected.row] : [])),
  );
  for (const issue of parsed.invalid) {
    // Already shown above with the row that replaced it.
    if (explainedRows.has(issue.row)) continue;
    groups.push({
      row: issue.row,
      groupNumber: issue.groupNumber ?? 0,
      productName: '—',
      category: '—',
      status: 'blocked',
      issue: `${issue.field} — ${issue.reason}`,
    });
  }

  groups.sort((a, b) => a.row - b.row || a.groupNumber - b.groupNumber);

  const report: SyncReport = {
    ...base,
    groups,
    changedSinceSync,
    fingerprint: fingerprintRows(parsed.valid),
    judgeCohortId: mapped?.id ?? null,
    rowsRead: parsed.rowsRead,
    blankRowsIgnored: parsed.blankRowsIgnored,
    validRows: parsed.valid.length,
    invalidRows: parsed.invalid.length,
    resubmittedGroups: parsed.resubmittedGroups,
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

  /*
   * The sheet must still be what the operator looked at.
   *
   * Sync re-read and re-parsed above, so this compares the live sheet against
   * the fingerprint shown at dry run. A mismatch means the counts on screen no
   * longer describe reality — the operator is asked to look again rather than
   * importing something they never reviewed.
   */
  if (options.expectedFingerprint && options.expectedFingerprint !== report.fingerprint) {
    return {
      ...report,
      fatalError:
        'The Sheet has changed since the last Dry Run. Run Dry Run again and review the new results before syncing.',
    };
  }

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
