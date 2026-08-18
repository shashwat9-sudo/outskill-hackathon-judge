'use client';

import * as React from 'react';
import { Alert, Badge, Button, cn } from '@/components/ui';
import {
  archiveCohortAction,
  setCohortStatusAction,
  startJudgingAction,
} from '@/server/admin-actions';

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
  /**
   * Archiving goes through its own action.
   *
   * A plain status change to `archived` sets the column and stops, leaving
   * every participant session live against a retired cohort. `archiveCohort`
   * revokes them and records what was archived, in one transaction.
   */
  viaArchiveAction?: boolean;
}

const TRANSITIONS: Record<string, Transition[]> = {
  draft: [
    {
      status: 'open',
      label: 'Open submissions',
      effect: 'Teams holding a valid access code can edit and submit.',
      tone: 'primary',
    },
    {
      status: 'archived',
      label: 'Archive cohort',
      effect: 'Retires a cohort that was never opened. This cannot be undone.',
      viaArchiveAction: true,
      tone: 'danger',
    },
  ],
  open: [
    {
      status: 'paused',
      label: 'Pause submissions',
      effect:
        'Learners can view their entries but cannot edit or submit. The deadline keeps running.',
      confirm: 'Pause submissions? Teams will be able to view but not edit their entries.',
    },
    {
      // Missing entirely until now, which left the lifecycle stuck: from `open`
      // the only offered move was `paused`, and `paused` only went back to
      // `open`. There was no way to close submissions from this screen at all,
      // and therefore no way to reach judging, finalising or archiving.
      status: 'closed',
      label: 'Close submissions',
      effect: 'Editing and final submission end for every team. Entries stay readable.',
      confirm:
        'Close submissions?\n\nEvery team loses the ability to edit or submit, immediately. Work already saved is kept and stays readable.\n\nYou can reopen afterwards if you need to.',
      tone: 'danger',
    },
  ],
  paused: [
    {
      status: 'open',
      label: 'Resume submissions',
      effect: 'Teams can edit and submit again. Nothing about the deadline changes.',
      tone: 'primary',
    },
    {
      status: 'closed',
      label: 'Close submissions',
      effect: 'Editing and final submission end for every team. Entries stay readable.',
      confirm:
        'Close submissions?\n\nEvery team loses the ability to edit or submit. Work already saved is kept and stays readable.\n\nYou can reopen afterwards if you need to.',
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
      effect: 'Teams can edit and submit again. Recorded in the audit trail.',
      confirm: 'Reopen submissions? Teams will be able to edit and submit again.',
    },
    {
      // The normal way to retire a cohort that will never be judged — a
      // rehearsal, a pilot, an acceptance test. Without this the only route to
      // `archived` ran through judging and finalising.
      status: 'archived',
      label: 'Archive cohort',
      effect:
        'Retires the cohort. Everything is kept and learner access ends. This cannot be undone.',
      viaArchiveAction: true,
      tone: 'danger',
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
      effect:
        'Retires the cohort. Everything is kept and learner access ends. This cannot be undone.',
      viaArchiveAction: true,
      tone: 'danger',
    },
  ],
  archived: [],
};

/**
 * What archiving this particular cohort would mean.
 *
 * Built from what it holds rather than written once, because the sentence that
 * matters is different for an empty cohort and for one carrying work nobody has
 * judged. A generic "this cannot be undone" tells an operator nothing they can
 * weigh.
 */
function archiveConfirmation(name: string, finalSubmissions: number, status: string): string {
  const lines = [`Archive "${name}"?`, ''];

  lines.push('Everything is kept: submissions, receipts, uploaded files, audit history');
  lines.push('and any judging results. This is not deletion.');
  lines.push('');
  lines.push('Learner access ends immediately — any team still signed in is signed out.');
  lines.push('');

  if (status === 'closed' && finalSubmissions > 0) {
    lines.push(
      `${finalSubmissions} final submission${finalSubmissions === 1 ? '' : 's'} in this cohort ` +
        'have not been judged, and archiving is permanent — they never will be.',
    );
    lines.push('If you intend to judge them, start judging instead.');
    lines.push('');
  }

  lines.push('An archived cohort cannot be reopened.');
  return lines.join('\n');
}

export function LifecycleControls({
  cohortId,
  cohortName,
  currentStatus,
  finalSubmissionCount = 0,
  csrfToken,
  judgingAvailable = true,
}: {
  cohortId: string;
  /** Named in the archive confirmation, so nobody retires the wrong cohort. */
  cohortName: string;
  currentStatus: string;
  /** Shapes the archive warning: unjudged work is the thing worth pausing over. */
  finalSubmissionCount?: number;
  csrfToken: string;
  /** False when the assessment repository is unavailable. */
  judgingAvailable?: boolean;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  // Hidden rather than shown-and-disabled: an operator should not be left
  // wondering whether they lack a permission. The page explains why elsewhere.
  const transitions = (TRANSITIONS[currentStatus] ?? []).filter(
    (t) => judgingAvailable || t.status !== 'judging',
  );

  const run = async (transition: Transition) => {
    // Archiving is irreversible and its confirmation depends on what the cohort
    // holds, so it is built here rather than declared in the table.
    const confirmText = transition.viaArchiveAction
      ? archiveConfirmation(cohortName, finalSubmissionCount, currentStatus)
      : transition.confirm;

    if (confirmText && !window.confirm(confirmText)) return;

    setPending(transition.status);
    setResult(null);

    const formData = new FormData();
    formData.set('csrf', csrfToken);
    formData.set('cohortId', cohortId);
    formData.set('status', transition.status);

    try {
      // Starting judging both moves the status and queues the work.
      const outcome = transition.viaArchiveAction
        ? // Its own action: revokes participant sessions and records what was
          // archived. A plain status change does neither.
          await archiveCohortAction(formData)
        : transition.status === 'judging'
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
