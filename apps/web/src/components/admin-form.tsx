'use client';

import * as React from 'react';
import { Alert, Button } from '@/components/ui';

/**
 * Form wrapper for admin actions.
 *
 * Every admin mutation goes through here so three things are guaranteed at one
 * place rather than remembered at thirty: the CSRF token is attached, the
 * button reflects in-flight state, and the result is announced to assistive
 * technology instead of only appearing visually.
 */

export interface AdminActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export function AdminForm({
  action,
  csrfToken,
  submitLabel,
  submitVariant = 'primary',
  children,
  confirm,
  className,
  onDone,
}: {
  action: (formData: FormData) => Promise<AdminActionResult>;
  csrfToken: string;
  submitLabel: string;
  submitVariant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  children?: React.ReactNode;
  /** Text shown in a confirm dialog before a destructive or hard-to-undo action. */
  confirm?: string;
  className?: string;
  onDone?: (result: AdminActionResult) => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<AdminActionResult | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirm && !window.confirm(confirm)) return;

    setPending(true);
    setResult(null);
    const formData = new FormData(event.currentTarget);
    try {
      const outcome = await action(formData);
      setResult(outcome);
      onDone?.(outcome);
      if (outcome.ok) formRef.current?.reset();
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : 'Something went wrong.' });
    } finally {
      setPending(false);
    }
  };

  return (
    <form ref={formRef} onSubmit={onSubmit} className={className}>
      <input type="hidden" name="csrf" value={csrfToken} />
      {children}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} variant={submitVariant}>
          {submitLabel}
        </Button>
      </div>
      {result && (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mt-3">
          {result.ok ? (result.message ?? 'Done.') : (result.error ?? 'That did not work.')}
        </Alert>
      )}
    </form>
  );
}

/** Download helper for CSV exports produced by a server action. */
export function DownloadButton({
  filename,
  fetcher,
  label,
}: {
  filename: string;
  fetcher: () => Promise<string>;
  label: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onClick = async () => {
    setPending(true);
    setError(null);
    try {
      const csv = await fetcher();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" loading={pending} onClick={onClick}>
        {label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
