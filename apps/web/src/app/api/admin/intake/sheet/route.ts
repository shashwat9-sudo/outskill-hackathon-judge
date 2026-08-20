import { NextResponse } from 'next/server';
import {
  csvSource,
  googleSheetsSource,
  readGoogleConfig,
  syncSheet,
} from '@ohj/shared';
import { getEnvConfig, getStoreAsync } from '@/lib/store';
import { auditAdminAction, getAdminSession } from '@/server/admin-auth';

/** Reads a sheet and may ingest a cohort's worth of submissions. */
export const maxDuration = 120;

/**
 * The operator control behind Dry Run and Sync.
 *
 * Admin-only, and deliberately a thing a person presses. On hackathon day the
 * sheet is edited live — rows corrected, sorted, pasted over — and a poller
 * reacting to every change would start judging half-finished edits. Someone
 * runs this once submissions have closed.
 *
 * The cohort is server configuration, never a field in the request: a caller
 * able to name the cohort could route a whole sheet into another cohort's
 * ranking.
 */
export async function POST(request: Request) {
  const session = await getAdminSession();
  if (!session) return new NextResponse('Not found', { status: 404 });

  let body: { mode?: string; csv?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const dryRun = body.mode !== 'sync';
  const env = getEnvConfig();
  const externalCohortId = env.GOOGLE_SHEETS_EXTERNAL_COHORT_ID ?? '';
  const cohortName = env.GOOGLE_SHEETS_COHORT_NAME ?? externalCohortId;

  if (!externalCohortId) {
    return NextResponse.json(
      {
        error:
          'GOOGLE_SHEETS_EXTERNAL_COHORT_ID is not set. The cohort is server configuration, and ' +
          'intake will not guess it.',
      },
      { status: 422 },
    );
  }

  /*
   * CSV is the fallback for the day Google is unavailable, and it walks exactly
   * the same parsing, validation and ingest path — so it cannot behave
   * differently from the primary route on the one day we need it.
   */
  let source;
  if (typeof body.csv === 'string' && body.csv.length > 0) {
    source = csvSource(body.csv, 'manual-upload.csv');
  } else {
    const config = readGoogleConfig(env as unknown as Record<string, string | undefined>);
    if (!config) {
      return NextResponse.json(
        {
          error:
            'Google Sheets is not configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL, ' +
            'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_SHEETS_SPREADSHEET_ID and ' +
            'GOOGLE_SHEETS_TAB_NAME, or upload a CSV.',
        },
        { status: 422 },
      );
    }
    source = googleSheetsSource(config);
  }

  const store = await getStoreAsync();
  const report = await syncSheet({ store, source, externalCohortId, cohortName, dryRun });

  // Audited, because ingesting a cohort is a consequential operation. The
  // report holds counts and row numbers — no credentials, no learner PII.
  if (!dryRun) {
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
  }

  return NextResponse.json(report, {
    status: report.fatalError ? 422 : 200,
    headers: { 'cache-control': 'no-store' },
  });
}
