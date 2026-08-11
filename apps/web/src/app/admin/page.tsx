import Link from 'next/link';
import {
  evaluateShortlistWindow,
  formatInTimezone,
  isCohortAcceptingSubmissions,
} from '@ohj/shared';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { Alert, Badge, Card, CardHeader, EmptyState, Table, Td, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Operations overview.
 *
 * Written around the question an operator actually has on the night of Day 13:
 * "are we going to have a shortlist by 10:00 AM, and what needs a human?"
 */
export default async function AdminOverviewPage() {
  await requireAdmin();
  const store = getStore();
  const cohorts = await store.cohorts.listCohorts();
  const active = cohorts.find((c) => c.status === 'judging' || c.status === 'open') ?? cohorts[0];

  if (!active) {
    return (
      <EmptyState
        title="No cohorts yet"
        description="Create a cohort to configure ideas, import teams and start accepting submissions."
        action={
          <Link href="/admin/cohorts" className="font-semibold text-brand underline">
            Go to cohorts
          </Link>
        }
      />
    );
  }

  const [submissions, stats, snapshot, flags, disqualifications] = await Promise.all([
    store.submissions.listSubmissions(active.id),
    store.assessment.getQueueStats(active.id),
    store.ranking.getCurrentSnapshot(active.id),
    store.assessment.listManualReviewFlags(active.id),
    store.assessment.listDisqualifications(active.id),
  ]);

  const window = evaluateShortlistWindow(active.day13DeadlineAt, stats.projectedCompletionAt);
  const openFlags = flags.filter((f) => f.status === 'open');
  const proposedDqs = disqualifications.filter((d) => d.status === 'proposed');
  const finallySubmitted = submissions.filter(
    (s) => s.submission.status === 'locked' || s.submission.status === 'submitted',
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{active.name}</h1>
          <p className="text-sm text-muted">
            Deadline {formatInTimezone(active.day13DeadlineAt, active.timezone)} · Shortlist due{' '}
            {formatInTimezone(window.dueAt, active.timezone)}
          </p>
        </div>
        <Badge tone={isCohortAcceptingSubmissions(active.status) ? 'success' : 'neutral'}>
          {active.status}
        </Badge>
      </div>

      <Alert tone={window.onTrack ? 'success' : 'warning'} title="Shortlist window">
        {window.label}
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Teams" value={submissions.length} hint="Imported into this cohort" />
        <Stat
          label="Finally submitted"
          value={finallySubmitted.length}
          hint={`${submissions.length - finallySubmitted.length} still draft`}
        />
        <Stat
          label="Assessment complete"
          value={stats.completed}
          hint={`${stats.total} queued in total`}
        />
        <Stat
          label="Needs a human"
          value={openFlags.length + proposedDqs.length}
          hint={`${openFlags.length} review flags, ${proposedDqs.length} proposed disqualifications`}
          tone={openFlags.length + proposedDqs.length > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="What needs a human"
            description="The system proposes; a person decides. Nothing here resolves itself."
            actions={
              <Link href="/admin/assessment-queue" className="text-sm font-semibold text-brand underline">
                Open queue
              </Link>
            }
          />
          {openFlags.length === 0 && proposedDqs.length === 0 ? (
            <p className="text-sm text-muted">Nothing outstanding.</p>
          ) : (
            <ul className="space-y-3">
              {openFlags.map((flag) => (
                <li key={flag.id} className="border-l-4 border-warning pl-3">
                  <p className="text-sm font-semibold">
                    Group {flag.groupNumber} — {flag.reasonCode.replace(/_/g, ' ')}
                  </p>
                  <p className="text-sm text-muted">{flag.detail}</p>
                  <Link
                    href={`/admin/submissions/${flag.submissionId}`}
                    className="text-sm font-medium text-brand underline"
                  >
                    Review
                  </Link>
                </li>
              ))}
              {proposedDqs.map((dq) => (
                <li key={dq.id} className="border-l-4 border-danger pl-3">
                  <p className="text-sm font-semibold">
                    Proposed disqualification — {dq.reasonCode.replace(/_/g, ' ')}
                  </p>
                  <p className="text-sm text-muted">{dq.reasonDetail}</p>
                  <Link
                    href={`/admin/submissions/${dq.submissionId}`}
                    className="text-sm font-medium text-brand underline"
                  >
                    Review
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Private top 10"
            description="Never shown to participants, in any cohort status."
            actions={
              <Link href="/admin/ranking" className="text-sm font-semibold text-brand underline">
                Full ranking
              </Link>
            }
          />
          {!snapshot || snapshot.entries.length === 0 ? (
            <p className="text-sm text-muted">
              No ranking yet. Generate a snapshot once assessment has completed.
            </p>
          ) : (
            <Table caption="Private top ten">
              <thead>
                <tr>
                  <Th className="w-12">#</Th>
                  <Th>Group</Th>
                  <Th>Product</Th>
                  <Th className="text-right">Score</Th>
                </tr>
              </thead>
              <tbody>
                {snapshot.entries
                  .filter((e) => e.entry.inShortlist)
                  .slice(0, 10)
                  .map((entry) => (
                    <tr key={entry.submissionId}>
                      <Td className="font-mono">{entry.entry.rank}</Td>
                      <Td>
                        <Link
                          href={`/admin/submissions/${entry.submissionId}`}
                          className="font-medium text-brand underline"
                        >
                          {entry.groupNumber}
                        </Link>
                      </Td>
                      <Td>
                        {entry.productName}
                        {entry.lowConfidence && (
                          <Badge tone="warning" className="ml-2">
                            low confidence
                          </Badge>
                        )}
                      </Td>
                      <Td className="text-right font-mono">{entry.entry.totalScore.toFixed(2)}</Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Cohort shortcuts" />
        <div className="flex flex-wrap gap-3">
          {[
            ['Ideas', `/admin/cohorts/${active.id}/ideas`],
            ['Teams & invites', `/admin/cohorts/${active.id}/teams`],
            ['Submissions', `/admin/cohorts/${active.id}/submissions`],
            ['Assessment queue', '/admin/assessment-queue'],
            ['Final four', '/admin/final-selection'],
          ].map(([label, href]) => (
            <Link
              key={href}
              href={href as string}
              className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-alt"
            >
              {label}
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: 'neutral' | 'warning';
}) {
  return (
    <Card className={tone === 'warning' && value > 0 ? 'border-warning bg-warning-tint' : undefined}>
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  );
}
