import Link from 'next/link';
import {
  evaluateShortlistWindow,
  formatDuration,
  formatInTimezone,
  JUDGING_UNAVAILABLE_MESSAGE,
  type AssessmentStage,
} from '@ohj/shared';
import { describeProviderStatus } from '@ohj/ai';
import { getCapabilities, getEnvConfig, getStoreAsync } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { retryMissingFeedbackAction, startJudgingAction } from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  Disclosure,
  EmptyState,
  PageHeading,
  Progress,
  Stat,
  Table,
  Td,
  Th,
  cn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Judging progress.
 *
 * Answers three questions in order: what is happening, what needs a person,
 * and what should I do next. Consumption figures are real and useful, but they
 * are not what an operator opens this page for — so they live in a disclosure.
 */

/** The pipeline, in operator language rather than raw stage identifiers. */
const PIPELINE: { label: string; stages: AssessmentStage[] }[] = [
  { label: 'Submitted', stages: ['queued'] },
  { label: 'Pre-flight', stages: ['preflight'] },
  { label: 'Artifact review', stages: ['artifact_analysis'] },
  { label: 'Test plan', stages: ['test_plan_generation'] },
  { label: 'Browser testing', stages: ['browser_testing'] },
  { label: 'Scoring', stages: ['evidence_review', 'scoring', 'consistency_review'] },
  { label: 'Completed', stages: ['completed'] },
];

export default async function JudgingPage() {
  const session = await requireAdmin();
  const store = await getStoreAsync();
  const env = getEnvConfig();
  const cohorts = await store.cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging') ?? cohorts[0];

  if (!cohort) return <EmptyState title="No cohorts yet" />;

  // Every read below reaches the assessment repository. A deployment where it
  // is unavailable would throw rather than return an empty queue that reads as
  // "nothing to judge", so the page stops here and says so plainly instead.
  if (!getCapabilities().assessment) {
    return (
      <div>
        <PageHeading
          title="Judging"
          description="Automated assessment for this cohort."
        />
        <Alert tone="info" testId="judging-unavailable">
          <p className="font-semibold">{JUDGING_UNAVAILABLE_MESSAGE}</p>
          <p className="mt-2">
            Everything else works normally: teams can submit, and you can manage cohorts, access
            codes and submissions. Nothing is lost by waiting.
          </p>
        </Alert>
      </div>
    );
  }

  const [stats, flags, submissions, feedback] = await Promise.all([
    store.assessment.getQueueStats(cohort.id),
    store.assessment.listManualReviewFlags(cohort.id),
    store.submissions.listSubmissions(cohort.id),
    store.assessment.getFeedbackCoverage(cohort.id),
  ]);
  const feedbackOutstanding = feedback.pending + feedback.generating + feedback.failed;

  const window = evaluateShortlistWindow(cohort.day13DeadlineAt, stats.projectedCompletionAt);

  /**
   * Has anything actually picked this work up?
   *
   * The repository being available is not the same as a worker existing. With
   * jobs queued and nothing claimed, the honest reading is "nothing is running"
   * — and an operator who believes judging is progressing when it is not will
   * discover it at the deadline rather than now.
   *
   * Derived from the queue itself rather than a worker registry: a job that has
   * ever been claimed has a started_at, so "queued but never started" is
   * exactly the condition worth surfacing.
   */
  const nothingStarted = stats.total > 0 && stats.byStage.queued === stats.total;

  /**
   * What judging is actually configured to do.
   *
   * Read from the worker's own report, not from this application's environment.
   * Judging does not run here — this tier never constructs an AI client and
   * has no AI key, correctly — so `AI_PROVIDER` and `AI_API_KEY` as seen from
   * here describe a process that does not judge anything. Reading them is how
   * a cohort being judged against real Gemini came to be captioned "Demo
   * fixtures — no AI provider".
   *
   * The local values are still passed for single-process demo mode, where
   * there is no separate worker to hear from.
   */
  const workers = await store.workers.list();
  const provider = describeProviderStatus({
    provider: env.AI_PROVIDER,
    model: env.AI_MODEL,
    hasApiKey: Boolean(env.AI_API_KEY),
    evaluationMode: env.AI_EVALUATION_MODE,
    demoMode: env.DEMO_MODE,
    worker: workers[0] ?? null,
  });
  const resolved = stats.completed + stats.failed + stats.manualReview;
  const openFlags = flags.filter((f) => f.status === 'open');
  const failed = submissions.filter((s) => s.stage === 'failed');

  const budgetMinutes = Math.round(cohort.assessmentConfig.browserBudgetMs / 60_000);

  return (
    <div>
      <PageHeading
        title="Judging progress"
        description="Track automated product testing, evidence review and cases that need human attention."
        actions={<Badge tone={cohort.status === 'judging' ? 'accent' : 'neutral'}>{cohort.status}</Badge>}
      />

      <Alert tone={provider.tone} title={provider.label} className="mb-8" testId="provider-status">
        <p>{provider.detail}</p>
        {!provider.canJudgeRealCohort && (
          <p className="mt-2 font-semibold">
            Real learner submissions will not be sent to an AI provider in this configuration.
          </p>
        )}
      </Alert>

      {nothingStarted && (
        <Alert tone="warning" title="Nothing is processing this queue" className="mb-8" testId="no-worker">
          <p>
            {stats.total} submission{stats.total === 1 ? ' is' : 's are'} queued and none has been
            picked up. Judging does not run inside this application — a separate worker process
            claims the queue, and it will not start without a database and an AI provider
            configured.
          </p>
          <p className="mt-2">
            Queued work is safe and nothing is lost. It stays here until a worker starts.
          </p>
        </Alert>
      )}

      <Alert tone={window.onTrack ? 'success' : 'warning'} title="Shortlist window" className="mb-8">
        {window.label} Private shortlist due{' '}
        {formatInTimezone(window.dueAt, cohort.timezone, { dateStyle: 'medium', timeStyle: 'short' })}.
      </Alert>

      <Card className="mb-8">
        <CardHeader
          title="Overall progress"
          description={`${resolved} of ${stats.total} submissions resolved.`}
        />
        <Progress value={resolved} max={Math.max(stats.total, 1)} label="Assessment progress" />

        {/* Visual pipeline. */}
        <ol className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {PIPELINE.map((phase) => {
            const count = phase.stages.reduce((sum, stage) => sum + (stats.byStage[stage] ?? 0), 0);
            const active = count > 0 && phase.label !== 'Completed';
            return (
              <li
                key={phase.label}
                className={cn(
                  'rounded-[10px] border p-3 text-center',
                  active ? 'border-brand-edge bg-brand-tint' : 'border-line bg-canvas',
                )}
              >
                <p className="text-2xl font-bold tabular-nums text-ink">{count}</p>
                <p className="mt-0.5 text-xs font-medium text-muted">{phase.label}</p>
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Currently processing" value={stats.running} hint="Held by a worker right now" />
        <Stat
          label="Average per submission"
          value={stats.averageDurationMs ? formatDuration(stats.averageDurationMs) : '—'}
          hint="Queued to completed, across all stages"
        />
        <Stat
          label="Estimated finish"
          value={
            stats.projectedCompletionAt
              ? formatInTimezone(stats.projectedCompletionAt, cohort.timezone, {
                  timeStyle: 'short',
                  dateStyle: 'short',
                })
              : 'Nothing pending'
          }
          hint={`${cohort.assessmentConfig.workerConcurrency} concurrent assessments`}
        />
        <Stat
          label="Needs human review"
          value={openFlags.length + failed.length}
          tone={openFlags.length + failed.length > 0 ? 'attention' : 'default'}
        />
      </div>

      {/* Needs attention comes before any technical detail. */}
      <Card className="mb-8">
        <CardHeader
          title="Needs attention"
          description="The system routes rather than penalises. Everything here waits for a person."
        />
        {openFlags.length === 0 && failed.length === 0 ? (
          <p className="text-sm text-muted">Nothing outstanding. ✓</p>
        ) : (
          <ul className="space-y-2">
            {openFlags.map((flag) => (
              <li
                key={flag.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line border-l-4 border-l-warning bg-warning-tint p-3.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">
                    Group {flag.groupNumber} — {flag.reasonCode.replace(/_/g, ' ')}
                  </p>
                  <p className="text-sm text-muted">{flag.detail}</p>
                </div>
                <Link
                  href={`/admin/submissions/${flag.submissionId}`}
                  className="shrink-0 rounded-[10px] border border-line bg-surface-soft px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand-edge"
                >
                  Review evidence
                </Link>
              </li>
            ))}
            {failed.map((item) => (
              <li
                key={item.submission.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line border-l-4 border-l-danger bg-danger-tint p-3.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">
                    Group {item.team.groupNumber} — assessment failed
                  </p>
                  <p className="text-sm text-muted">
                    Check the pre-flight attempts before deciding anything. A temporary outage is not
                    a failed product.
                  </p>
                </div>
                <Link
                  href={`/admin/submissions/${item.submission.id}`}
                  className="shrink-0 rounded-[10px] border border-line bg-surface-soft px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand-edge"
                >
                  Retry failed assessment
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Feedback is downstream of judging and separately retryable; say where it stands. */}
      <Card className="mb-8" testId="feedback-coverage">
        <CardHeader
          title="Participant feedback coverage"
          description="Every completed assessment is owed a private feedback report, whether or not it is shortlisted. Judging results are never affected by a missing report."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Completed assessments" value={feedback.completed} />
          <Stat label="Feedback ready" value={feedback.ready} />
          <Stat label="Feedback pending" value={feedback.pending} tone={feedback.pending > 0 ? 'attention' : 'default'} />
          <Stat label="Feedback generating" value={feedback.generating} />
          <Stat label="Feedback failed" value={feedback.failed} tone={feedback.failed > 0 ? 'attention' : 'default'} />
        </div>
        {feedback.completed > 0 && feedbackOutstanding === 0 && (
          <p className="mt-4 text-sm text-muted">Every completed assessment has a feedback report. ✓</p>
        )}
        {feedbackOutstanding > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <AdminForm
              action={retryMissingFeedbackAction}
              csrfToken={session.csrfToken}
              submitLabel="Request missing feedback"
              submitVariant="secondary"
              confirm="Request every missing feedback report for this cohort? This only marks them for the worker — scores, ranking and evidence are not touched, and existing reports are kept."
            >
              <input type="hidden" name="cohortId" value={cohort.id} />
              <p className="text-sm text-muted">
                Re-requests {feedbackOutstanding} report{feedbackOutstanding === 1 ? '' : 's'} for this
                cohort only. The worker produces them when its queue is idle. Safe to press again.
              </p>
            </AdminForm>
          </div>
        )}
      </Card>

      <Card className="mb-8">
        <CardHeader
          title="Actions"
          description="Queueing is safe to run more than once — nothing is duplicated."
        />
        <AdminForm
          action={startJudgingAction}
          csrfToken={session.csrfToken}
          submitLabel="Start judging"
        >
          <input type="hidden" name="cohortId" value={cohort.id} />
          <p className="text-sm text-muted">
            Queues every final submission for assessment. Drafts are skipped.
          </p>
        </AdminForm>
      </Card>

      {/* Technical detail, available but not in the way. */}
      <Disclosure summary="Usage and system details" testId="usage-details">
        <Table caption="Assessment usage and configuration">
          <tbody>
            <tr>
              <Th scope="row">Browser testing time used</Th>
              <Td className="text-right font-mono">{stats.browserMinutesUsed.toFixed(1)} minutes</Td>
            </tr>
            <tr>
              <Th scope="row">AI calls made</Th>
              <Td className="text-right font-mono">{stats.aiCallCount}</Td>
            </tr>
            <tr>
              <Th scope="row">Estimated tokens used</Th>
              <Td className="text-right font-mono">{stats.estimatedTokensUsed.toLocaleString()}</Td>
            </tr>
            <tr>
              <Th scope="row">Concurrent assessments</Th>
              <Td className="text-right font-mono">{cohort.assessmentConfig.workerConcurrency}</Td>
            </tr>
            <tr>
              <Th scope="row">Maximum browser-testing time</Th>
              <Td className="text-right font-mono">{budgetMinutes} minutes per submission</Td>
            </tr>
            <tr>
              <Th scope="row">Maximum retries</Th>
              <Td className="text-right font-mono">{cohort.assessmentConfig.maxAttempts}</Td>
            </tr>
          </tbody>
        </Table>

        <p className="mt-4 text-sm text-muted">
          &ldquo;Average per submission&rdquo; measures the whole pipeline from queued to completed,
          across every stage — pre-flight retries, artifact analysis, test planning, browser testing
          and scoring. The {budgetMinutes}-minute limit above applies only to the browser-testing
          stage, so the average is expected to be larger than it. Token counts are reported as raw
          numbers; pricing is applied wherever Outskill tracks cost.
        </p>
      </Disclosure>
    </div>
  );
}
