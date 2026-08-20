'use server';

import { revalidatePath } from 'next/cache';
import {
  checkGoogleConnectivity,
  csvSource,
  googleSheetsSource,
  readGoogleConfig,
  syncSheet,
  REQUIRED_HEADERS,
  normaliseHeader,
  type ConnectivitySummary,
  type SyncReport,
} from '@ohj/shared';
import { getEnvConfig, getStoreAsync } from '@/lib/store';
import { auditAdminAction, requireAdmin } from '@/server/admin-auth';

/**
 * The three things an operator can do with the submissions sheet.
 *
 * Every one of them runs behind the admin session — `requireAdmin` throws for
 * anyone else, so an unauthenticated caller cannot reach these even by posting
 * directly at the action endpoint.
 *
 * Nothing here polls. On the day, learners keep editing the sheet until the
 * deadline; a loop reacting to every change would judge half-finished edits.
 * The operator decides when to look and when to import.
 */

export interface IntakeConfig {
  configured: boolean;
  serviceAccountEmail: string | null;
  expectedServiceAccount: string;
  externalCohortId: string | null;
  cohortName: string | null;
  tabName: string | null;
  spreadsheetIdMasked: string | null;
  /** What is still missing, in words an operator can act on. */
  missing: string[];
}

const mask = (id: string | undefined) =>
  !id ? null : id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : '…';

/** Configuration as the page shows it. Never the private key. */
export async function getIntakeConfig(): Promise<IntakeConfig> {
  await requireAdmin();
  const env = getEnvConfig();
  const google = readGoogleConfig(env as unknown as Record<string, string | undefined>);

  const missing: string[] = [];
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push('Google service-account email');
  if (!env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) missing.push('Google service-account key');
  if (!env.GOOGLE_SHEETS_SPREADSHEET_ID) missing.push('Spreadsheet ID');
  if (!env.GOOGLE_SHEETS_TAB_NAME) missing.push('Sheet tab name');
  if (!env.GOOGLE_SHEETS_EXTERNAL_COHORT_ID) missing.push('Cohort ID');

  return {
    configured: google !== null && Boolean(env.GOOGLE_SHEETS_EXTERNAL_COHORT_ID),
    serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null,
    expectedServiceAccount: 'outskill-hackathon-judge@outskill-hackathon-judge.iam.gserviceaccount.com',
    externalCohortId: env.GOOGLE_SHEETS_EXTERNAL_COHORT_ID ?? null,
    cohortName: env.GOOGLE_SHEETS_COHORT_NAME ?? env.GOOGLE_SHEETS_EXTERNAL_COHORT_ID ?? null,
    tabName: env.GOOGLE_SHEETS_TAB_NAME ?? null,
    spreadsheetIdMasked: mask(env.GOOGLE_SHEETS_SPREADSHEET_ID),
    missing,
  };
}

export interface ConnectionResult extends ConnectivitySummary {
  checkedAt: string;
  missingHeaders: string[];
}

/**
 * Can we reach the sheet at all?
 *
 * Reads header names and a row count and nothing else — no cell values, so no
 * password and no learner record can surface here. Creates nothing: no
 * submission, no job, no AI call, no worker.
 */
export async function testConnectionAction(): Promise<ConnectionResult | { error: string }> {
  await requireAdmin();
  const env = getEnvConfig();
  const config = readGoogleConfig(env as unknown as Record<string, string | undefined>);
  if (!config) {
    return { error: 'Google Sheets is not configured yet. See the configuration panel above.' };
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
 * Read and validate the sheet, writing nothing.
 *
 * Safe to run during the submission window, as often as the operator likes.
 */
export async function dryRunAction(csv?: string): Promise<IntakeRunResult> {
  return runIntake({ dryRun: true, csv });
}

/**
 * Import the validated submissions and queue judging jobs.
 *
 * `expectedFingerprint` is what the operator was shown at dry run. The sheet is
 * read and parsed again here, and a mismatch refuses the import — otherwise a
 * dry run showing 118 submissions could be followed by a sync importing
 * something else, and nobody would know until the scores came out.
 */
export async function syncAction(
  expectedFingerprint: string,
  csv?: string,
): Promise<IntakeRunResult> {
  return runIntake({ dryRun: false, expectedFingerprint, csv });
}

async function runIntake(input: {
  dryRun: boolean;
  expectedFingerprint?: string;
  csv?: string;
}): Promise<IntakeRunResult> {
  await requireAdmin();
  const ranAt = new Date().toISOString();
  const env = getEnvConfig();
  const externalCohortId = env.GOOGLE_SHEETS_EXTERNAL_COHORT_ID ?? '';
  const cohortName = env.GOOGLE_SHEETS_COHORT_NAME ?? externalCohortId;

  if (!externalCohortId) {
    return {
      ranAt,
      error:
        'No cohort is configured for this sheet. Set the cohort ID before importing — intake will not guess it.',
    };
  }

  let source;
  if (input.csv) {
    source = csvSource(input.csv, 'manual-upload.csv');
  } else {
    const config = readGoogleConfig(env as unknown as Record<string, string | undefined>);
    if (!config) return { ranAt, error: 'Google Sheets is not configured yet.' };
    source = googleSheetsSource(config);
  }

  const store = await getStoreAsync();
  const report = await syncSheet({
    store,
    source,
    externalCohortId,
    cohortName,
    dryRun: input.dryRun,
    ...(input.expectedFingerprint ? { expectedFingerprint: input.expectedFingerprint } : {}),
  });

  if (!input.dryRun && !report.fatalError) {
    // Importing a cohort's submissions is consequential and audited. The report
    // holds counts and row numbers — never a credential or learner contact.
    await auditAdminAction({
      action: 'intake.sheet_synced',
      entityType: 'cohort',
      entityId: report.judgeCohortId,
      cohortId: report.judgeCohortId,
      after: {
        externalCohortId: report.externalCohortId,
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
