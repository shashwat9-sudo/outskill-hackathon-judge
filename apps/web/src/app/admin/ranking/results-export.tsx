'use client';

import * as React from 'react';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import type { ResultsExportRequest } from '@/server/admin-actions';

/**
 * The results-and-feedback export control.
 *
 * Every ranked product by default — the whole judged pool, not the shortlist —
 * because this is the file the programme team gives feedback from. The
 * shortlist and a bounded "top N" are offered for the narrower asks.
 *
 * The CSV is produced by a server action behind the admin session and handed
 * back with its filename; this component only turns it into a download.
 */
export function ResultsExportControls({
  cohortId,
  rankedCount,
  shortlistCount,
  action,
}: {
  cohortId: string;
  rankedCount: number;
  shortlistCount: number;
  action: (request: ResultsExportRequest) => Promise<{ filename: string; csv: string; rows: number }>;
}) {
  const [scope, setScope] = React.useState<ResultsExportRequest['scope']>('all');
  const [topN, setTopN] = React.useState(String(rankedCount));
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState<{ ok: boolean; text: string } | null>(null);

  const onExport = async () => {
    setPending(true);
    setMessage(null);
    try {
      const request: ResultsExportRequest = { cohortId, scope };
      if (scope === 'top') request.topN = Number(topN);
      const result = await action(request);

      const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({ ok: true, text: `Exported ${result.rows} row${result.rows === 1 ? '' : 's'} to ${result.filename}.` });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'Export failed.' });
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-testid="results-export">
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <Field id="results-export-scope" label="Rows to include">
          {(aria) => (
            <Select
              {...aria}
              value={scope}
              onChange={(event) => setScope(event.target.value as ResultsExportRequest['scope'])}
            >
              <option value="all">All ranked results ({rankedCount})</option>
              <option value="shortlist">Current shortlist only ({shortlistCount})</option>
              <option value="top">Top N by rank</option>
            </Select>
          )}
        </Field>
        <Field id="results-export-top-n" label="N" hint={scope === 'top' ? `Up to ${rankedCount}.` : undefined}>
          {(aria) => (
            <Input
              {...aria}
              type="number"
              min={1}
              max={Math.max(rankedCount, 1)}
              value={topN}
              disabled={scope !== 'top'}
              onChange={(event) => setTopN(event.target.value)}
            />
          )}
        </Field>
        <Button type="button" loading={pending} onClick={onExport}>
          Export results &amp; feedback CSV
        </Button>
      </div>
      {message && (
        <Alert tone={message.ok ? 'success' : 'danger'} className="mt-3">
          {message.text}
        </Alert>
      )}
    </div>
  );
}
