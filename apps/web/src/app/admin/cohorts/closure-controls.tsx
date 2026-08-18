'use client';

import * as React from 'react';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { closeSubmissionsAction, reopenSubmissionsAction } from '@/server/admin-actions';

/**
 * Closing and reopening submissions.
 *
 * Deliberately separate from the generic lifecycle transitions, because neither
 * of these is a status change to the person pressing it:
 *
 *   - Closing is the moment several hundred teams lose the ability to edit. It
 *     takes a typed confirmation rather than a dialog, so a stray double-click
 *     on deadline evening cannot cause it.
 *
 *   - Reopening after the deadline needs an explicit acceptance time. Without
 *     one the cohort would read as open while rejecting every save, which is the
 *     worst possible state for a team that has just been told they may resubmit.
 *     The server refuses it; this form asks for it up front so nobody meets that
 *     refusal by surprise.
 */

const CONFIRMATION = 'CLOSE SUBMISSIONS';

export function ClosureControls({
  cohortId,
  status,
  csrfToken,
  deadlinePassed,
  deadlineLabel,
  acceptingUntilLabel,
}: {
  cohortId: string;
  status: string;
  csrfToken: string;
  deadlinePassed: boolean;
  deadlineLabel: string;
  acceptingUntilLabel: string | null;
}) {
  const canClose = status === 'open' || status === 'paused';
  const canReopen = status === 'closed' || status === 'paused';

  /**
   * The outcome lives here, not inside the two forms.
   *
   * Closing changes the cohort's status, which unmounts the close form — so a
   * confirmation owned by that form disappears at the exact moment it becomes
   * useful, and the operator is left wondering whether the button worked.
   */
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  if (!canClose && !canReopen) return null;

  return (
    <Card testId="closure-controls">
      <h2 className="text-lg font-bold">Submission window</h2>
      <p className="mt-1 text-sm text-muted">
        Submissions close automatically at {deadlineLabel}. Nothing here needs to run for that to
        happen — the deadline is enforced on every save, not by a scheduled job.
        {acceptingUntilLabel && (
          <>
            {' '}
            This cohort is currently accepting late edits until{' '}
            <strong className="text-ink">{acceptingUntilLabel}</strong>.
          </>
        )}
      </p>

      <div className="mt-5 grid gap-5 border-t border-line pt-5 lg:grid-cols-2">
        {canClose && (
          <CloseForm cohortId={cohortId} csrfToken={csrfToken} onResult={setResult} />
        )}
        {canReopen && (
          <ReopenForm
            cohortId={cohortId}
            csrfToken={csrfToken}
            deadlinePassed={deadlinePassed}
            onResult={setResult}
          />
        )}
      </div>

      {result && (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mt-5" testId="closure-result">
          {result.message}
        </Alert>
      )}
    </Card>
  );
}

type ResultHandler = (result: { ok: boolean; message: string }) => void;

function CloseForm({
  cohortId,
  csrfToken,
  onResult,
}: {
  cohortId: string;
  csrfToken: string;
  onResult: ResultHandler;
}) {
  const [typed, setTyped] = React.useState('');
  const [pending, setPending] = React.useState(false);

  const armed = typed.trim() === CONFIRMATION;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const formData = new FormData(event.currentTarget);
    formData.set('csrf', csrfToken);
    const outcome = await closeSubmissionsAction(formData);
    onResult({
      ok: outcome.ok,
      message: outcome.ok ? (outcome.message ?? 'Done.') : (outcome.error ?? 'That did not work.'),
    });
    setPending(false);
    if (outcome.ok) setTyped('');
  };

  return (
    <form onSubmit={submit} data-testid="close-submissions-form">
      <h3 className="text-sm font-bold">Close submissions now</h3>
      <p className="mt-1 text-sm text-muted">
        Ends the window immediately, before the deadline. Every team loses the ability to edit or
        submit the moment you press this.
      </p>

      <input type="hidden" name="cohortId" value={cohortId} />

      <div className="mt-3">
        <Field
          id="closeConfirmation"
          label={`Type ${CONFIRMATION} to confirm`}
          hint="Deliberately awkward. This is not an action to take by accident."
        >
          {(aria) => (
            <Input
              {...aria}
              name="confirmation"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="max-w-[22rem] font-mono"
            />
          )}
        </Field>
      </div>

      <Button type="submit" variant="danger" size="sm" className="mt-3" disabled={!armed} loading={pending}>
        Close submissions
      </Button>
    </form>
  );
}

function ReopenForm({
  cohortId,
  csrfToken,
  deadlinePassed,
  onResult,
}: {
  cohortId: string;
  csrfToken: string;
  deadlinePassed: boolean;
  onResult: ResultHandler;
}) {
  const [pending, setPending] = React.useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const formData = new FormData(event.currentTarget);
    formData.set('csrf', csrfToken);
    const outcome = await reopenSubmissionsAction(formData);
    onResult({
      ok: outcome.ok,
      message: outcome.ok ? (outcome.message ?? 'Done.') : (outcome.error ?? 'That did not work.'),
    });
    setPending(false);
  };

  return (
    <form onSubmit={submit} data-testid="reopen-submissions-form">
      <h3 className="text-sm font-bold">Reopen submissions</h3>
      <p className="mt-1 text-sm text-muted">
        Lets teams edit and submit again. The reason is recorded in the audit log.
      </p>

      <input type="hidden" name="cohortId" value={cohortId} />

      <div className="mt-3 space-y-4">
        <Field
          id="reopenReason"
          label="Why are you reopening?"
          hint="For example: platform outage during the final hour."
          required
        >
          {(aria) => <Input {...aria} name="reason" autoComplete="off" />}
        </Field>

        <Field
          id="acceptingUntil"
          label="Accept edits until"
          hint={
            deadlinePassed
              ? 'Required — the official deadline has passed, so without this the cohort would look open while rejecting every save.'
              : 'Optional. Leave empty to run to the existing deadline.'
          }
          required={deadlinePassed}
        >
          {(aria) => (
            <Input
              {...aria}
              name="acceptingUntil"
              type="datetime-local"
              className="max-w-[16rem]"
              required={deadlinePassed}
            />
          )}
        </Field>
      </div>

      <Button type="submit" variant="secondary" size="sm" className="mt-3" loading={pending}>
        Reopen submissions
      </Button>
    </form>
  );
}
