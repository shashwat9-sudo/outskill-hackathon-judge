'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  DescriptionList,
  EmptyState,
  Stat,
  Table,
  Td,
  Th,
} from '@/components/ui';
import {
  dryRunAction,
  syncAction,
  testConnectionAction,
  type ConnectionResult,
  type IntakeConfig,
  type IntakeRunResult,
} from '@/server/intake-actions';

/**
 * Three buttons, in the order they are used.
 *
 * Written for a programme operator, not an engineer: no status codes, no
 * request bodies, no mention of tokens or signing. A validation problem reads
 * "Group 14 — Missing MVP/Product Link", because the person fixing it will do
 * so by opening the spreadsheet and typing.
 *
 * Sync is deliberately awkward to reach. It needs a dry run first, then a
 * confirmation naming the cohort and the exact number of submissions — an
 * import is the moment a cohort's work becomes final, and it should not be one
 * stray click away.
 */

type Phase = 'idle' | 'testing' | 'dry-running' | 'syncing';

export function IntakeControl({ config }: { config: IntakeConfig }) {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [connection, setConnection] = React.useState<ConnectionResult | { error: string } | null>(null);
  const [dryRun, setDryRun] = React.useState<IntakeRunResult | null>(null);
  const [syncResult, setSyncResult] = React.useState<IntakeRunResult | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  const busy = phase !== 'idle';
  const report = dryRun?.report;

  // Only groups that are genuinely importable. Duplicates and invalid rows are
  // counted separately and shown, never quietly folded into "ready".
  const ready = report?.groups.filter((g) => g.status === 'ready').length ?? 0;
  const blocked = report?.groups.filter((g) => g.status === 'blocked').length ?? 0;
  const duplicates = report?.duplicateGroups.length ?? 0;
  const alreadySynced = report?.groups.filter((g) => g.status === 'already_synced').length ?? 0;
  const changed = report?.changedSinceSync.length ?? 0;

  const canSync = Boolean(report && !report.fatalError && ready > 0);

  async function onTest() {
    setPhase('testing');
    setConnection(await testConnectionAction());
    setPhase('idle');
  }

  async function onDryRun() {
    setPhase('dry-running');
    setSyncResult(null);
    setConfirming(false);
    setDryRun(await dryRunAction());
    setPhase('idle');
  }

  async function onSync() {
    if (!report) return;
    setPhase('syncing');
    setConfirming(false);
    // The fingerprint the operator was shown. The server re-reads the sheet and
    // refuses if it no longer matches.
    setSyncResult(await syncAction(report.fingerprint));
    setPhase('idle');
  }

  return (
    <div className="space-y-6">
      {/* ---------------------------------------------------------------- */}
      {/* Configuration                                                     */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader title="Connection settings" description="Configured on the server. Nothing here can be edited from this page." />

        {config.missing.length > 0 && (
          <Alert tone="warning" title="Not fully configured yet">
            Still needed: {config.missing.join(', ')}. Ask whoever manages the deployment to add
            these before the hackathon.
          </Alert>
        )}

        <DescriptionList
          items={[
            { term: 'Cohort', description: config.cohortName ?? 'Not set' },
            { term: 'Cohort ID', description: config.externalCohortId ?? 'Not set' },
            { term: 'Sheet tab', description: config.tabName ?? 'Not set' },
            { term: 'Spreadsheet', description: config.spreadsheetIdMasked ?? 'Not set' },
            {
              term: 'Reading as',
              description: config.serviceAccountEmail ?? 'Not set',
            },
          ]}
        />
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 1. Test connection                                                */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="1. Test connection"
          description="Checks that we can open the sheet and that the expected columns are there. Changes nothing."
        />
        <Button onClick={onTest} disabled={busy} variant="secondary">
          {phase === 'testing' ? 'Checking…' : 'Test connection'}
        </Button>

        {connection && 'error' in connection && (
          <Alert tone="danger" title="Could not connect" className="mt-4">
            {connection.error}
          </Alert>
        )}

        {connection && !('error' in connection) && (
          <div className="mt-4 space-y-3">
            {connection.ok ? (
              <Alert tone="success" title="Connected">
                Found {connection.rowCount} row{connection.rowCount === 1 ? '' : 's'} in “
                {connection.tabName}”.
                {connection.missingHeaders.length > 0 && (
                  <>
                    {' '}
                    <strong>
                      Missing columns: {connection.missingHeaders.join(', ')}.
                    </strong>{' '}
                    Add them to the sheet before importing.
                  </>
                )}
              </Alert>
            ) : (
              <Alert tone="danger" title="Could not read the sheet">
                {connection.error}
              </Alert>
            )}

            {!connection.matchesExpectedAccount && (
              <Alert tone="warning" title="Unexpected Google account">
                The sheet is being read as <code>{connection.serviceAccountEmail}</code>, which is
                not the account this system expects. Check the deployment settings before importing.
              </Alert>
            )}
          </div>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 2. Dry run                                                        */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="2. Check the sheet"
          description="Reads every row and tells you what would be imported. Safe to run at any time, as often as you like."
        />

        <Alert tone="info" title="Nothing is imported by this step">
          Checking only reads and validates the Sheet. It does not import submissions or start
          judging.
        </Alert>

        <div className="mt-4">
          <Button onClick={onDryRun} disabled={busy || !config.configured}>
            {phase === 'dry-running' ? 'Checking the sheet…' : 'Check the sheet'}
          </Button>
        </div>

        {report?.fatalError && (
          <Alert tone="danger" title="Could not read the sheet" className="mt-4">
            {report.fatalError}
          </Alert>
        )}
        {dryRun?.error && (
          <Alert tone="danger" title="Could not check the sheet" className="mt-4">
            {dryRun.error}
          </Alert>
        )}

        {report && !report.fatalError && (
          <>
            <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label="Rows found" value={String(report.rowsRead)} />
              <Stat label="Ready to import" value={String(ready)} tone={ready > 0 ? 'accent' : 'default'} />
              <Stat label="Blocked" value={String(blocked)} tone={blocked > 0 ? 'attention' : 'default'} />
              <Stat label="Duplicate groups" value={String(duplicates)} tone={duplicates > 0 ? 'attention' : 'default'} />
              <Stat label="Already imported" value={String(alreadySynced)} />
              <Stat label="Changed since import" value={String(changed)} tone={changed > 0 ? 'attention' : 'default'} />
              <Stat label="Blank rows skipped" value={String(report.blankRowsIgnored)} />
              <Stat label="Jobs this would create" value={String(ready)} />
            </div>

            {changed > 0 && (
              <Alert tone="warning" title="Some imported submissions have changed in the sheet" className="mt-4">
                {report.changedSinceSync.map((c) => `Group ${c.groupNumber}`).join(', ')} —{' '}
                {changed === 1 ? 'this group was' : 'these groups were'} already imported, and the
                sheet has been edited since. {changed === 1 ? 'It is' : 'They are'} not re-imported
                automatically. Decide with the team whether the original submission still stands.
              </Alert>
            )}

            <IntakeTable rows={report.groups} />
          </>
        )}
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 3. Sync                                                           */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader
          title="3. Import final submissions"
          description="Do this once submissions have closed. Imported submissions are queued for judging."
        />

        {!report && (
          <Alert tone="info" title="Check the sheet first">
            Run step 2 so you can see what would be imported before importing it.
          </Alert>
        )}

        {report && !canSync && !report.fatalError && (
          <Alert tone="info" title="Nothing new to import">
            The last check found no submissions ready to import.
          </Alert>
        )}

        {canSync && !confirming && (
          <Button onClick={() => setConfirming(true)} disabled={busy}>
            Import {ready} submission{ready === 1 ? '' : 's'}…
          </Button>
        )}

        {canSync && confirming && (
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
            <h3 className="text-base font-semibold">Import final submissions?</h3>
            <p className="mt-2 text-sm text-muted">
              This will import {ready} validated submission{ready === 1 ? '' : 's'} into the Judge
              for <strong>{config.cohortName}</strong> and queue{' '}
              {ready === 1 ? 'a judging job' : `${ready} judging jobs`}.
            </p>
            {(blocked > 0 || duplicates > 0) && (
              <p className="mt-2 text-sm text-muted">
                {blocked > 0 && <>{blocked} row{blocked === 1 ? '' : 's'} with problems </>}
                {blocked > 0 && duplicates > 0 && 'and '}
                {duplicates > 0 && <>{duplicates} duplicate group{duplicates === 1 ? '' : 's'} </>}
                will <strong>not</strong> be imported. Fix them in the sheet and check again to
                include them.
              </p>
            )}
            <p className="mt-2 text-sm text-muted">
              Re-running this is safe, but treat submissions as final once imported.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button onClick={onSync} disabled={busy}>
                {phase === 'syncing' ? 'Importing…' : `Confirm & import ${ready} submission${ready === 1 ? '' : 's'}`}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {syncResult?.error && (
          <Alert tone="danger" title="Could not import" className="mt-4">
            {syncResult.error}
          </Alert>
        )}
        {syncResult?.report?.fatalError && (
          <Alert tone="warning" title="Import stopped" className="mt-4">
            {syncResult.report.fatalError}
          </Alert>
        )}

        {syncResult?.report && !syncResult.report.fatalError && (
          <div className="mt-4 space-y-4">
            <Alert tone="success" title="Imported">
              {syncResult.report.newSubmissions} new submission
              {syncResult.report.newSubmissions === 1 ? '' : 's'} imported ·{' '}
              {syncResult.report.alreadyIngested} already imported ·{' '}
              {syncResult.report.jobsQueued} judging job
              {syncResult.report.jobsQueued === 1 ? '' : 's'} queued ·{' '}
              {syncResult.report.invalidRows} not imported.
            </Alert>

            <Alert tone="info" title="Judging has not started yet">
              Submissions have been queued. The judging worker must be online to process them.
            </Alert>

            <div className="flex flex-wrap gap-3">
              <Link href="/admin/submissions">
                <Button variant="secondary">View submissions</Button>
              </Link>
              <Link href="/admin/assessment-queue">
                <Button variant="secondary">View judging status</Button>
              </Link>
              <Link href="/admin/ranking">
                <Button variant="secondary">View shortlist</Button>
              </Link>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

const STATUS_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  ready: { label: 'Ready to import', tone: 'success' },
  already_synced: { label: 'Already imported', tone: 'neutral' },
  changed_since_sync: { label: 'Changed since import', tone: 'warning' },
  duplicate: { label: 'Duplicate group', tone: 'warning' },
  blocked: { label: 'Needs fixing', tone: 'danger' },
};

/**
 * The rows, as an operator needs them.
 *
 * Group, product, category, status and what to fix. Deliberately no team
 * leader, no members, no contact details and no login — none of it helps
 * someone decide whether to import, and all of it would be on screen in a
 * shared room.
 */
function IntakeTable({ rows }: { rows: { row: number; groupNumber: number; productName: string; category: string; status: string; issue?: string }[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No rows found" description="The sheet has no submissions in it yet." />;
  }

  return (
    <div className="mt-6 overflow-x-auto">
      <Table caption="Every row in the sheet, and whether it can be imported">
        <thead>
          <tr>
            <Th>Row</Th>
            <Th>Group</Th>
            <Th>Product</Th>
            <Th>Category</Th>
            <Th>Status</Th>
            <Th>What to do</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const status = STATUS_LABEL[row.status] ?? { label: row.status, tone: 'neutral' as const };
            return (
              <tr key={`${row.row}-${row.groupNumber}-${index}`}>
                <Td className="font-mono text-xs">{row.row}</Td>
                <Td className="font-medium">{row.groupNumber || '—'}</Td>
                <Td>{row.productName}</Td>
                <Td className="text-muted">{row.category}</Td>
                <Td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </Td>
                <Td className="text-muted">{row.issue ?? '—'}</Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
