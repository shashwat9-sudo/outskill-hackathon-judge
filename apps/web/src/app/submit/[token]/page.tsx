import { notFound } from 'next/navigation';
import {
  evaluateDeadline,
  formatInTimezone,
  getPublicRubric,
  timezoneLabel,
} from '@ohj/shared';
import { getStore } from '@/lib/store';
import { Alert, Badge, Card, CardHeader, Table, Td, Th } from '@/components/ui';
import { SubmissionForm } from './submission-form';

export const dynamic = 'force-dynamic';

/**
 * The participant portal.
 *
 * This route resolves an invite token to exactly one submission. It reads only
 * from `store.participant`, which has no method capable of reaching an
 * assessment table — so no judging information can appear here even by mistake
 * (ADR-010).
 */
export default async function SubmitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const store = getStore();
  const view = await store.participant.resolveInvite(token);

  // Unknown, revoked and expired tokens are indistinguishable from here.
  if (!view) notFound();

  const resources = await store.participant.listParticipantResources(view.cohort.id);
  const deadline = evaluateDeadline(view.cohort.day13DeadlineAt);
  const rubric = getPublicRubric();
  const isSubmitted = view.submission.status === 'locked' || view.submission.status === 'submitted';

  return (
    <div className="min-h-screen bg-surface-alt">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-brand">Outskill</p>
            <h1 className="text-xl font-bold">{view.cohort.name}</h1>
          </div>
          <Badge tone="neutral">Group {view.team.groupNumber}</Badge>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {/* Deadline, in the participant's own timezone alongside the official one. */}
        <Card>
          <CardHeader
            title="Submission deadline"
            description={view.cohort.description}
            actions={
              <Badge tone={deadline.hasPassed ? 'danger' : 'success'}>
                {deadline.hasPassed ? 'Closed' : `${deadline.remainingLabel} left`}
              </Badge>
            }
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm font-semibold text-muted">Official deadline</p>
              <p className="text-sm">
                {formatInTimezone(view.cohort.day13DeadlineAt, view.cohort.timezone)}{' '}
                <span className="text-muted">
                  ({timezoneLabel(view.cohort.day13DeadlineAt, view.cohort.timezone)})
                </span>
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-muted">Your local time</p>
              <LocalDeadline iso={view.cohort.day13DeadlineAt.toISOString()} />
            </div>
          </div>
          {view.cohort.submissionInstructions && (
            <p className="mt-4 max-w-prose border-t border-line pt-4 text-sm text-muted">
              {view.cohort.submissionInstructions}
            </p>
          )}
        </Card>

        {isSubmitted && view.submission.receiptId && (
          <Alert tone="success" title="Your submission is in">
            <p>
              Receipt <strong className="font-mono">{view.submission.receiptId}</strong>. Keep this
              reference — it identifies your submission if you need to contact the Outskill team.
            </p>
            <p className="mt-2">
              Your submission is now locked and can no longer be edited. If something is genuinely
              wrong, contact the Outskill team and they can reopen it for you.
            </p>
          </Alert>
        )}

        {view.submission.status === 'reopened' && (
          <Alert tone="warning" title="Your submission was reopened">
            The Outskill team reopened your submission so you can make a change.
            {view.submission.reopenedReason && <> Reason: {view.submission.reopenedReason}</>} Press
            Final Submit again when you are done.
          </Alert>
        )}

        {/* Dates cross the server/client boundary as ISO strings and back. */}
        <SubmissionForm token={token} view={JSON.parse(JSON.stringify(view))} />

        {/* Public rubric — categories and weights only. No scoring guidance. */}
        <Card>
          <CardHeader
            title="How submissions are assessed"
            description="Every submission is assessed against the same 100-point rubric. Results are not shared with participants."
          />
          <Table caption="Scoring rubric categories and weights">
            <thead>
              <tr>
                <Th>Category</Th>
                <Th className="w-20 text-right">Points</Th>
              </tr>
            </thead>
            <tbody>
              {rubric.map((category) => (
                <tr key={category.key}>
                  <Td>
                    <p className="font-semibold">{category.title}</p>
                    <p className="mt-0.5 text-muted">{category.description}</p>
                  </Td>
                  <Td className="text-right font-mono font-semibold">{category.maxPoints}</Td>
                </tr>
              ))}
              <tr>
                <Td className="font-bold">Total</Td>
                <Td className="text-right font-mono font-bold">100</Td>
              </tr>
            </tbody>
          </Table>
        </Card>

        {resources.length > 0 && (
          <Card>
            <CardHeader title="Resources" description="Templates and instructions for your submission." />
            <ul className="space-y-2">
              {resources.map((resource) => (
                <li key={resource.id} className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <a
                      href={`/api/resources/${resource.id}`}
                      className="font-semibold text-brand underline"
                    >
                      {resource.title}
                    </a>
                    <p className="text-sm text-muted">{resource.description}</p>
                  </div>
                  <span className="text-xs text-muted">
                    {(resource.byteSize / 1024 / 1024).toFixed(1)} MB
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </main>

      <footer className="border-t border-line bg-surface py-6">
        <p className="mx-auto max-w-5xl px-6 text-sm text-muted">
          Assessment results, scores and rankings are internal to Outskill and are not shared with
          participants.
        </p>
      </footer>
    </div>
  );
}

/** Renders the deadline in the viewer's own timezone, client-side. */
function LocalDeadline({ iso }: { iso: string }) {
  return (
    <p className="text-sm" suppressHydrationWarning>
      <time dateTime={iso}>{new Date(iso).toLocaleString()}</time>
    </p>
  );
}
