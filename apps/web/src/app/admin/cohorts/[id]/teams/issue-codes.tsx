'use client';

import * as React from 'react';
import { Alert, Button } from '@/components/ui';
import type { CodeSheetResult } from '@/server/admin-actions';

/**
 * Issue codes and download the sheet, as one action.
 *
 * They cannot be separate buttons. A code exists in plaintext only while it is
 * being generated — nothing stores it and nothing can read it back — so an
 * "issue" that does not produce a file has created codes that no team can ever
 * be told, and the only recovery is to issue them again.
 *
 * The download therefore fires from the same result that reports success, and
 * the button says so.
 */
export function IssueCodesButton({
  action,
  cohortId,
  csrfToken,
  label,
  variant = 'primary',
  confirm,
  teamId,
}: {
  action: (formData: FormData) => Promise<CodeSheetResult>;
  cohortId: string;
  csrfToken: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
  confirm?: string;
  teamId?: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<CodeSheetResult | null>(null);

  const onClick = async () => {
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.set('csrf', csrfToken);
      formData.set('cohortId', cohortId);
      if (teamId) formData.set('teamId', teamId);

      const outcome = await action(formData);
      if (outcome.csv && outcome.filename) download(outcome.csv, outcome.filename);
      setResult(outcome);
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : 'Could not issue codes.',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant={variant} size="sm" loading={pending} onClick={onClick}>
        {label}
      </Button>
      {result && (
        <Alert tone={result.ok ? (result.issued === 0 ? 'info' : 'success') : 'danger'}>
          {result.ok ? result.message : result.error}
        </Alert>
      )}

      {/*
        One team, one paste.
        
        Shown only when a single code was issued — the reissue case, where a
        coordinator is about to open one thread. The message holds the same
        plaintext as the file that just downloaded, and it disappears with this
        component: nothing here is stored, and there is no way to ask for it
        again.
      */}
      {result?.ok && result.singleMessage && (
        <CopyMessage message={result.singleMessage} />
      )}
    </div>
  );
}

function CopyMessage({ message }: { message: string }) {
  const [copied, setCopied] = React.useState(false);

  return (
    <div className="rounded-[10px] border border-line bg-canvas p-3" data-testid="learner-message">
      <p className="text-xs font-bold uppercase tracking-wider text-muted">Message for this team</p>
      <pre className="mt-2 whitespace-pre-wrap break-words text-sm text-ink">{message}</pre>
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(message);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard access can be refused. The message is on screen and can
            // be selected by hand, so this is not worth an error.
          }
        }}
      >
        {copied ? 'Copied' : 'Copy message'}
      </Button>
    </div>
  );
}

function download(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
