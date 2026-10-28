'use client';

import * as React from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { updateCohortIntakeAction } from '@/server/admin-actions';
import { testConnectionAction, type ConnectionResult } from '@/server/intake-actions';

/**
 * Where this cohort's submissions come from — editable by an admin, so a new
 * cohort and its tab never need a deployment (0016).
 *
 * Saving validates on the server and refuses an external id or a tab another
 * cohort already uses. "Test tab" is read-only: it opens the tab, reads the
 * header row and the row count, and nothing else.
 */
export function IntakeSettings({
  cohortId,
  csrfToken,
  initial,
  locked,
}: {
  cohortId: string;
  csrfToken: string;
  initial: {
    intakeMode: 'portal' | 'sheet';
    externalCohortId: string | null;
    intakeTabName: string | null;
    intakeTimezone: string | null;
    timezone: string;
  };
  /** True once the cohort holds imported submissions: the external id may not change. */
  locked: boolean;
}) {
  const [mode, setMode] = React.useState<'portal' | 'sheet'>(initial.intakeMode);
  const [externalId, setExternalId] = React.useState(initial.externalCohortId ?? '');
  const [tab, setTab] = React.useState(initial.intakeTabName ?? '');
  const [zone, setZone] = React.useState(initial.intakeTimezone ?? initial.timezone);
  const [pending, setPending] = React.useState<'save' | 'test' | null>(null);
  const [result, setResult] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [connection, setConnection] = React.useState<ConnectionResult | { error: string } | null>(null);

  const save = async () => {
    setPending('save');
    setResult(null);
    try {
      const formData = new FormData();
      formData.set('csrf', csrfToken);
      formData.set('cohortId', cohortId);
      formData.set('intakeMode', mode);
      formData.set('externalCohortId', externalId);
      formData.set('intakeTabName', tab);
      formData.set('intakeTimezone', zone);
      const outcome = await updateCohortIntakeAction(formData);
      setResult({ ok: outcome.ok, text: outcome.ok ? (outcome.message ?? 'Saved.') : (outcome.error ?? 'Could not save.') });
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' });
    } finally {
      setPending(null);
    }
  };

  const test = async () => {
    setPending('test');
    setConnection(null);
    try {
      setConnection(await testConnectionAction(cohortId));
    } finally {
      setPending(null);
    }
  };

  return (
    <div data-testid="intake-settings" className="space-y-4">
      <Field id={`intake-mode-${cohortId}`} label="Where submissions come from">
        {(aria) => (
          <select
            {...aria}
            className="w-full rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-ink"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'portal' | 'sheet')}
          >
            <option value="portal">Judge participant portal</option>
            <option value="sheet">External Google Sheet intake</option>
          </select>
        )}
      </Field>
      {mode === 'sheet' && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            id={`intake-external-${cohortId}`}
            label="External cohort ID"
            required
            hint={locked ? 'Locked: this cohort already holds imported submissions.' : 'e.g. AIAP-C15-IST'}
          >
            {(aria) => (
              <Input {...aria} value={externalId} onChange={(e) => setExternalId(e.target.value)} disabled={locked} />
            )}
          </Field>
          <Field id={`intake-tab-${cohortId}`} label="Google Sheet tab" required hint="e.g. Submissions - AIAP C15 IST">
            {(aria) => <Input {...aria} value={tab} onChange={(e) => setTab(e.target.value)} />}
          </Field>
          <Field id={`intake-zone-${cohortId}`} label="Sheet timestamps are in" hint="IANA zone, e.g. America/New_York">
            {(aria) => <Input {...aria} value={zone} onChange={(e) => setZone(e.target.value)} />}
          </Field>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Button onClick={save} disabled={pending !== null}>
          {pending === 'save' ? 'Saving…' : 'Save intake settings'}
        </Button>
        {mode === 'sheet' && (
          <Button onClick={test} variant="secondary" disabled={pending !== null || !tab.trim()}>
            {pending === 'test' ? 'Checking…' : 'Test tab (read-only)'}
          </Button>
        )}
      </div>
      {result && (
        <Alert tone={result.ok ? 'success' : 'danger'} title={result.ok ? 'Saved' : 'Not saved'}>
          {result.text}
        </Alert>
      )}
      {connection && 'error' in connection && (
        <Alert tone="danger" title="Could not connect">
          {connection.error}
        </Alert>
      )}
      {connection && !('error' in connection) && (
        <Alert tone={connection.ok ? 'success' : 'danger'} title={connection.ok ? 'Tab reachable' : 'Could not read the tab'}>
          {connection.ok
            ? `Found ${connection.rowCount} data row${connection.rowCount === 1 ? '' : 's'} in “${connection.tabName}” as ${connection.serviceAccountEmail}.${
                connection.missingHeaders.length ? ` Missing columns: ${connection.missingHeaders.join(', ')}.` : ' All expected columns present.'
              }`
            : connection.error}
        </Alert>
      )}
    </div>
  );
}
