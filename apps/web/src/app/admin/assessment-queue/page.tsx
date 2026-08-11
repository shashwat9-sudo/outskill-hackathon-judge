import Link from 'next/link';
import {
  ASSESSMENT_STAGES,
  evaluateShortlistWindow,
  formatDuration,
  formatInTimezone,
} from '@ohj/shared';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { startJudgingAction } from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import { Alert, Badge, Card, CardHeader, EmptyState, Progress, Table, Td, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Queue monitor.
 *
 * Answers the operational questions: how much is left, how fast is it going,
 * will it finish before the shortlist is due, and what has it cost so far.
 * AI pricing is deliberately absent — token counts are reported and priced
 * wherever Outskill tracks cost.
 */
export default async function AssessmentQueuePage() {
  const session = await requireAdmin();
  const store = getStore();
  const cohorts = await store.cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging') ?? cohorts[0];

  if (!cohort) return <EmptyState title="No cohorts yet" />;

  const [stats, flags] = await Promise.all([
    store.assessment.getQueueStats(cohort.id),
    store.assessment.listManualReviewFlags(cohort.id),
  ]);
  const window = evaluateShortlistWindow(cohort.day13DeadlineAt, stats.projectedCompletionAt);
  const done = stats.completed + stats.failed + stats.manualReview;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Assessment queue</h1>
          <p className="text-sm text-muted">{cohort.name}</p>
        </div>
        <Badge tone={cohort.status === 'judging' ? 'success' : 'neutral'}>{cohort.status}</Badge>
      </div>

      <Alert tone={window.onTrack ? 'success' : 'warning'} title="Shortlist window">
        {window.label} Shortlist due {formatInTimezone(window.dueAt, cohort.timezone)}.
      </Alert>

      <Card>
        <CardHeader title="Progress" />
        <Progress value={done} max={Math.max(stats.total, 1)} label={`${done} of ${stats.total} resolved`} />

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="In flight" value={String(stats.running)} hint="Currently leased by a worker" />
          <Metric
            label="Average duration"
            value={stats.averageDurationMs ? formatDuration(stats.averageDurationMs) : '—'}
            hint="Per submission, end to end"
          />
          <Metric
            label="Projected finish"
            value={
              stats.projectedCompletionAt
                ? formatInTimezone(stats.projectedCompletionAt, cohort.timezone, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : 'Nothing pending'
            }
            hint={`At concurrency ${cohort.assessmentConfig.workerConcurrency}`}
          />
          <Metric
            label="Needs a human"
            value={String(flags.filter((f) => f.status === 'open').length)}
            hint="Open manual-review flags"
          />
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="By stage" />
          <Table caption="Jobs by pipeline stage">
            <thead>
              <tr>
                <Th>Stage</Th>
                <Th className="text-right">Jobs</Th>
              </tr>
            </thead>
            <tbody>
              {ASSESSMENT_STAGES.map((stage) => (
                <tr key={stage}>
                  <Td>{stage.replace(/_/g, ' ')}</Td>
                  <Td className="text-right font-mono">{stats.byStage[stage] ?? 0}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <CardHeader
            title="Consumption"
            description="Reported as raw counts. Pricing is never hard-coded — apply your own rate."
          />
          <Table caption="Resource consumption">
            <tbody>
              <tr>
                <Th scope="row">Browser minutes</Th>
                <Td className="text-right font-mono">{stats.browserMinutesUsed.toFixed(2)}</Td>
              </tr>
              <tr>
                <Th scope="row">AI calls</Th>
                <Td className="text-right font-mono">{stats.aiCallCount}</Td>
              </tr>
              <tr>
                <Th scope="row">Estimated tokens</Th>
                <Td className="text-right font-mono">{stats.estimatedTokensUsed.toLocaleString()}</Td>
              </tr>
              <tr>
                <Th scope="row">Worker concurrency</Th>
                <Td className="text-right font-mono">{cohort.assessmentConfig.workerConcurrency}</Td>
              </tr>
              <tr>
                <Th scope="row">Per-submission budget</Th>
                <Td className="text-right font-mono">
                  {formatDuration(cohort.assessmentConfig.browserBudgetMs)}
                </Td>
              </tr>
            </tbody>
          </Table>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Manual review"
          description="The system routes rather than penalises. Everything here needs a person."
        />
        {flags.filter((f) => f.status === 'open').length === 0 ? (
          <p className="text-sm text-muted">Nothing outstanding.</p>
        ) : (
          <ul className="space-y-3">
            {flags
              .filter((f) => f.status === 'open')
              .map((flag) => (
                <li key={flag.id} className="rounded-md border-l-4 border-warning bg-warning-tint p-3">
                  <p className="font-semibold">
                    Group {flag.groupNumber} — {flag.reasonCode.replace(/_/g, ' ')}
                  </p>
                  <p className="mt-1 text-sm">{flag.detail}</p>
                  <Link
                    href={`/admin/submissions/${flag.submissionId}`}
                    className="mt-2 inline-block text-sm font-semibold text-brand underline"
                  >
                    Open submission
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Queue more work" description="Safe to run repeatedly — nothing is duplicated." />
        <AdminForm action={startJudgingAction} csrfToken={session.csrfToken} submitLabel="Queue submissions">
          <input type="hidden" name="cohortId" value={cohort.id} />
        </AdminForm>
      </Card>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-bold">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
