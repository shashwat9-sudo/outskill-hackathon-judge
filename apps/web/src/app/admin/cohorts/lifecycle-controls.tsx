'use client';

import * as React from 'react';
import { Alert, Badge, Button, cn } from '@/components/ui';
import { setCohortStatusAction, startJudgingAction } from '@/server/admin-actions';

/**
 * Cohort lifecycle controls.
 *
 * Every transition states its effect on participants before it happens, and the
 * consequential ones ask for confirmation. "Close submissions" is not a
 * technical state change to the person pressing it — it is the moment several
 * hundred teams lose the ability to edit.
 */

interface Transition {
  status: string;
  label: string;
  effect: string;
  confirm?: string;
  tone?: 'primary' | 'secondary' | 'danger';
}

const TRANSITIONS: Record<string, Transition[]> = {
  draft: [
    {
      status: 'open',
      label: 'Open submissions',
      effect: 'Teams with valid invite links can edit and submit.',
      tone: 'primary',
    },
  ],
  open: [
    {
      status: 'paused',
      label: 'Pause submissions',
      effect: 'Learners can view their entries but cannot edit or submit.',
      confirm: 'Pause submissions? Teams will be able to view but not edit their entries.',
    },
    {
      status: 'closed',
      label: 'Close submissions',
      effect: 'No further participant changes. Judging can begin.',
      confirm:
        'Close submissions? Every team loses the ability to edit immediately. You can reopen the cohort afterwards if needed.',
      tone: 'danger',
    },
  ],
  paused: [
    {
      status: 'open',
      label: 'Reopen submissions',
      effect: 'Teams can edit and submit again.',
      tone: 'primary',
    },
    {
      status: 'closed',
      label: 'Close submissions',
      effect: 'No further participant changes. Judging can begin.',
      confirm: 'Close submissions? Every team loses the ability to edit immediately.',
      tone: 'danger',
    },
  ],
  closed: [
    {
      status: 'judging',
      label: 'Start judging',
      effect: 'Final submissions are queued for assessment.',
      confirm: 'Start judging? Every final submission will be queued for automated assessment.',
      tone: 'primary',
    },
    {
      status: 'open',
      label: 'Reopen submissions',
      effect: 'Teams can edit and submit again.',
    },
  ],
  judging: [
    {
      status: 'finalised',
      label: 'Finalise cohort',
      effect: 'Marks judging complete. Demo credentials are destroyed under the retention policy.',
      confirm:
        'Finalise this cohort? This marks judging complete and destroys stored demo credentials.',
      tone: 'danger',
    },
    {
      status: 'closed',
      label: 'Back to closed',
      effect: 'Stops judging so assessment can be re-run.',
    },
  ],
  finalised: [
    { status: 'judging', label: 'Reopen judging', effect: 'Allows scores and shortlist to change again.' },
    {
      status: 'archived',
      label: 'Archive cohort',
      effect: 'Read-only forever. This cannot be undone.',
      confirm: 'Archive this cohort? Archived cohorts are read-only and cannot be reopened.',
      tone: 'danger',
    },
  ],
  archived: [],
};

export function LifecycleControls({
  cohortId,
  currentStatus,
  csrfToken,
}: {
  cohortId: string;
  currentStatus: string;
  csrfToken: string;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  const transitions = TRANSITIONS[currentStatus] ?? [];

  const run = async (transition: Transition) => {
    if (transition.confirm && !window.confirm(transition.confirm)) return;

    setPending(transition.status);
    setResult(null);

    const formData = new FormData();
    formData.set('csrf', csrfToken);
    formData.set('cohortId', cohortId);
    formData.set('status', transition.status);

    try {
      // Starting judging both moves the status and queues the work.
      const outcome =
        transition.status === 'judging'
          ? await startJudgingAction(formData)
          : await setCohortStatusAction(formData);

      setResult({
        ok: outcome.ok,
        message: outcome.ok ? (outcome.message ?? 'Done.') : (outcome.error ?? 'That did not work.'),
      });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Something went wrong.',
      });
    } finally {
      setPending(null);
    }
  };

  if (transitions.length === 0) {
    return (
      <p className="text-sm text-muted">
        This cohort is archived and read-only. <Badge tone="neutral">No actions available</Badge>
      </p>
    );
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {transitions.map((transition) => (
          <div
            key={transition.status}
            className={cn(
              'rounded-[10px] border p-4',
              transition.tone === 'danger' ? 'border-danger/40' : 'border-line',
            )}
          >
            <p className="font-semibold text-ink">{transition.label}</p>
            <p className="mt-1 mb-3 text-sm text-muted">{transition.effect}</p>
            <Button
              size="sm"
              variant={
                transition.tone === 'primary'
                  ? 'primary'
                  : transition.tone === 'danger'
                    ? 'danger'
                    : 'secondary'
              }
              loading={pending === transition.status}
              onClick={() => run(transition)}
            >
              {transition.label}
            </Button>
          </div>
        ))}
      </div>

      {result && (
        <Alert tone={result.ok ? 'success' : 'danger'} className="mt-4">
          {result.message}
        </Alert>
      )}
    </div>
  );
}
