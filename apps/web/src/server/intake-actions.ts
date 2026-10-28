'use server';

import { revalidatePath } from 'next/cache';
import {
  EXPECTED_SERVICE_ACCOUNT,
  checkGoogleConnectivity,
  csvSource,
  googleSheetsSource,
  intakeTimezoneOf,
  readGoogleConfig,
  readGoogleCredentials,
  syncSheet,
  REQUIRED_HEADERS,
  normaliseHeader,
  type Cohort,
  type ConnectivitySummary,
  type SyncReport,
} from '@ohj/shared';
import { getEnvConfig, getStoreAsync } from '@/lib/store';
import { auditAdminAction, requireAdmin } from '@/server/admin-auth';

/**
 * The three things an operator can do with a cohort's submissions sheet.
 *
 * Every one of them runs behind the admin session — `requireAdmin` throws for
 * anyone else, so an unauthenticated caller cannot reach these even by posting
 * directly at the action endpoint.
 *
 * Every one of them is scoped to ONE cohort, named by the operator (0016). The
 * cohort carries the tab it reads and the external id it imports under; the
 * spreadsheet and the service account are shared server configuration. A
 * second cohort's tab is never opened during another cohort's check or import,
 * and switching the selection on screen reads nothing and writes nothing.
 *
 * Nothing here polls. On the day, learners keep editing the sheet until the
 * deadline; a loop reacting to every change would judge half-finished edits.
 * The operator decides when to look and when to import.
 */

export interface IntakeCohortOption {
  id: string;
  name: string;
  code: string;
  status: Cohort['status'];
  externalCohortId: string | null;
  intakeTabName: string | null;
}

export interface IntakeConfig {
  configured: boolean;
  cohortId: string | null;
  cohortName: string | null;
  cohortCode: string | null;
  cohortStatus: string | null;
  externalCohortId: string | null;
  tabName: string | null;
  /** The zone the sheet's timestamps are read in. */
  intakeTimezone: string | null;
  /** The spreadsheet this cohort reads, masked; the deployment default unless the cohort names its own. */
  spreadsheetIdMasked: string | null;
  spreadsheetSource: 'cohort' | 'default' | null;
  serviceAccountEmail: string | null;
  expectedServiceAccount: string;
  /** Active, approved ideas on the cohort — an import needs at least one. */
  approvedIdeas: number;
  /** What is still missing, in words an operator can act on. */
  missing: string[];
}

const mask = (id: string | undefined) =>
  !id ? null : id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : '…';

/** Cohorts fed from the sheet, for the selector. Archived ones are not offered. */
export async function listIntakeCohorts(): Promise<IntakeCohortOption[]> {
  await requireAdmin();
  const cohorts = await (await getStoreAsync()).cohorts.listCohorts();
  return cohorts
    .filter((c) => c.intakeMode === 'sheet' && c.status !== 'archived')
    .map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      status: c.status,
      externalCohortId: c.externalCohortId,
      intakeTabName: c.intakeTabName,
    }));
}

type Resolved = { ok: true; cohort: Cohort } | { ok: false; error: string };

/** The selected cohort, validated server-side; never inferred from anything else. */
async function resolveIntakeCohort(cohortId: string): Promise<Resolved> {
  if (!cohortId) return { ok: false, error: 'Select a cohort first.' };
  const cohort = await (await getStoreAsync()).cohorts.getCohort(cohortId);
  if (!cohort) return { ok: false, error: 'That cohort does not exist.' };
  if (cohort.intakeMode !== 'sheet') {
    return { ok: false, error: `Cohort "${cohort.name}" takes submissions through the Judge portal, not from a sheet.` };
  }
  if (!cohort.externalCohortId) {
    return { ok: false, error: `Cohort "${cohort.name}" has no external cohort ID. Set it under Cohorts → Intake settings.` };
  }
  if (!cohort.intakeTabName) {
    return { ok: false, error: `Cohort "${cohort.name}" has no Google Sheet tab. Set it under Cohorts → Intake settings.` };
  }
  return { ok: true, cohort };
}

/** Configuration as the page shows it, for one cohort. Never the private key. */
export async function getIntakeConfig(cohortId: string | null): Promise<IntakeConfig> {
  await requireAdmin();
  const env = getEnvConfig();
  const credentials = readGoogleCredentials(env as unknown as Record<string, string | undefined>);
  const missing: string[] = [];
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push('Google service-account email');
  if (!env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) missing.push('Google service-account key');
  if (!env.GOOGLE_SHEETS_SPREADSHEET_ID) missing.push('Spreadsheet ID');

  const base: IntakeConfig = {
    configured: false,
    cohortId: null,
    cohortName: null,
    cohortCode: null,
    cohortStatus: null,
    externalCohortId: null,
    tabName: null,
    intakeTimezone: null,
    spreadsheetIdMasked: mask(env.GOOGLE_SHEETS_SPREADSHEET_ID),
    spreadsheetSource: env.GOOGLE_SHEETS_SPREADSHEET_ID ? 'default' : null,
    serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
    expectedServiceAccount: EXPECTED_SERVICE_ACCOUNT,
    approvedIdeas: 0,
    missing,
  };
  if (!cohortId) return { ...base, missing: [...missing, 'A selected cohort'] };

  const store = await getStoreAsync();
  const cohort = await store.cohorts.getCohort(cohortId);
  if (!cohort) return { ...base, missing: [...missing, 'A cohort that exists'] };
  if (cohort.intakeMode !== 'sheet') missing.push('Intake mode set to "External Google Sheet intake"');
  if (!cohort.externalCohortId) missing.push('External cohort ID on the cohort');
  if (!cohort.intakeTabName) missing.push('Google Sheet tab on the cohort');
  const ideas = await store.cohorts.listIdeas(cohort.id);
  const approvedIdeas = ideas.filter((i) => i.isActive && i.definitionStatus === 'approved').length;
  if (approvedIdeas === 0) missing.push('At least one approved idea on the cohort (needed to import)');

  return {
    ...base,
    configured: credentials !== null && cohort.intakeMode === 'sheet' && Boolean(cohort.externalCohortId && cohort.intakeTabName),
    cohortId: cohort.id,
    cohortName: cohort.name,
    cohortCode: cohort.code,
    cohortStatus: cohort.status,
    externalCohortId: cohort.externalCohortId,
    tabName: cohort.intakeTabName,
    intakeTimezone: intakeTimezoneOf(cohort),
    spreadsheetIdMasked: cohort.intakeSpreadsheetId ? mask(cohort.intakeSpreadsheetId) : mask(env.GOOGLE_SHEETS_SPREADSHEET_ID),
    spreadsheetSource: cohort.intakeSpreadsheetId ? 'cohort' : env.GOOGLE_SHEETS_SPREADSHEET_ID ? 'default' : null,
    approvedIdeas,
    missing,
  };
}

export interface ConnectionResult extends ConnectivitySummary {
  checkedAt: string;
  missingHeaders: string[];
}

/**
 * Can we reach the cohort's tab at all?
 *
 * Reads header names and a row count and nothing else — no cell values, so no
 * password and no learner record can surface here. Creates nothing: no
 * submission, no job, no AI call, no worker. An empty tab is a valid answer.
 */
export async function testConnectionAction(cohortId: string): Promise<ConnectionResult | { error: string }> {
  await requireAdmin();
  const resolved = await resolveIntakeCohort(cohortId);
  if (!resolved.ok) return { error: resolved.error };
  const env = getEnvConfig();
  const config = readGoogleConfig(
    env as unknown as Record<string, string | undefined>,
    resolved.cohort.intakeTabName,
    resolved.cohort.intakeSpreadsheetId,
  );
  if (!config) {
    return { error: 'Google Sheets is not configured on the server yet. See the configuration panel above.' };
  }
  const summary = await checkGoogleConnectivity(config);
  const present = summary.headers.map(normaliseHeader);
  const missingHeaders = summary.ok
    ? REQUIRED_HEADERS.filter((h) => !present.includes(normaliseHeader(h)))
    : [];
  return { ...summary, missingHeaders: [...missingHeaders], checkedAt: new Date().toISOString() };
}

export interface IntakeRunResult {
  report?: SyncReport;
  error?: string;
  ranAt: string;
}

/**
 * Read and validate the cohort's tab, writing nothing.
 *
 * Safe to run during the submission window, as often as the operator likes.
 */
export async function dryRunAction(cohortId: string, csv?: string): Promise<IntakeRunResult> {
  return runIntake({ cohortId, dryRun: true, csv });
}

/**
 * Import the validated submissions into the selected cohort and queue their
 * judging jobs.
 *
 * `expectedFingerprint` is what the operator was shown at dry run. It is bound
 * to the spreadsheet, the tab, the cohort and the rows, so a check of one
 * cohort's tab can never authorise another cohort's import, and a sheet
 * edited since the check is refused. Queued jobs are not judged until the
 * operator starts judging for this cohort (ADR-035).
 */
export async function syncAction(
  cohortId: string,
  expectedFingerprint: string,
  csv?: string,
): Promise<IntakeRunResult> {
  if (!expectedFingerprint) {
    return { ranAt: new Date().toISOString(), error: 'Check the sheet first, then import what the check showed.' };
  }
  return runIntake({ cohortId, dryRun: false, expectedFingerprint, csv });
}

async function runIntake(input: {
  cohortId: string;
  dryRun: boolean;
  expectedFingerprint?: string;
  csv?: string;
}): Promise<IntakeRunResult> {
  await requireAdmin();
  const ranAt = new Date().toISOString();
  const resolved = await resolveIntakeCohort(input.cohortId);
  if (!resolved.ok) return { ranAt, error: resolved.error };
  const { cohort } = resolved;
  const env = getEnvConfig();

  let source;
  if (input.csv) {
    source = csvSource(input.csv, `manual-upload (${cohort.code}).csv`);
  } else {
    const config = readGoogleConfig(
      env as unknown as Record<string, string | undefined>,
      cohort.intakeTabName,
      cohort.intakeSpreadsheetId,
    );
    if (!config) return { ranAt, error: 'Google Sheets is not configured on the server yet.' };
    source = googleSheetsSource(config);
  }

  const store = await getStoreAsync();
  const report = await syncSheet({
    store,
    source,
    cohortId: cohort.id,
    externalCohortId: cohort.externalCohortId ?? '',
    cohortName: cohort.name,
    sourceTimezone: intakeTimezoneOf(cohort),
    dryRun: input.dryRun,
    ...(input.expectedFingerprint ? { expectedFingerprint: input.expectedFingerprint } : {}),
  });

  if (!input.dryRun && !report.fatalError) {
    // Importing a cohort's submissions is consequential and audited. The report
    // holds counts and row numbers — never a credential or learner contact.
    await auditAdminAction({
      action: 'intake.sheet_synced',
      entityType: 'cohort',
      entityId: cohort.id,
      cohortId: cohort.id,
      after: {
        externalCohortId: report.externalCohortId,
        tabName: report.tabName,
        newSubmissions: report.newSubmissions,
        alreadyIngested: report.alreadyIngested,
        invalidRows: report.invalidRows,
      },
    });
    revalidatePath('/admin/submissions');
    revalidatePath('/admin/assessment-queue');
  }

  return { ranAt, report };
}
