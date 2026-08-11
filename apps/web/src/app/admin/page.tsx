import Link from 'next/link';
import {
  demoTeamId,
  evaluateDeadline,
  evaluateShortlistWindow,
  formatInTimezone,
  type Cohort,
} from '@ohj/shared';
import { getDemoStore, getStore, isDemo } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeading,
  Stat,
  StatusPill,
  cn,
} from '@/components/ui';
import { OnboardingPanel } from './onboarding';

export const dynamic = 'force-dynamic';

/**
 * Operations overview.
 *
 * Built around the five questions an operator actually has:
 * what stage is the cohort in, what is done, what needs attention, what should
 * I do next, and will the shortlist be ready on time.
 */
export default async function AdminOverviewPage() {
  await requireAdmin();
  const store = getStore();
  const demo = getDemoStore();
  const cohorts = await store.cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging' || c.status === 'open') ?? cohorts[0];

  if (!cohort) {
    return (
      <EmptyState
        title="No cohorts yet"
        description="Create a cohort to configure ideas, import teams and start accepting submissions."
        action={
          <Link
            href="/admin/cohorts"
            className="rounded-[10px] bg-brand px-4 py-2.5 text-sm font-bold text-black"
          >
            Create your first cohort
          </Link>
        }
      />
    );
  }

  const [submissions, stats, snapshot, flags, disqualifications, teams, ideas, selections] =
    await Promise.all([
      store.submissions.listSubmissions(cohort.id),
      store.assessment.getQueueStats(cohort.id),
      store.ranking.getCurrentSnapshot(cohort.id),
      store.assessment.listManualReviewFlags(cohort.id),
      store.assessment.listDisqualifications(cohort.id),
      store.teams.listTeams(cohort.id),
      store.cohorts.listIdeas(cohort.id),
      store.ranking.listFinalSelections(cohort.id),
    ]);

  const deadline = evaluateDeadline(cohort.day13DeadlineAt);
  const shortlistWindow = evaluateShortlistWindow(cohort.day13DeadlineAt, stats.projectedCompletionAt);

  const finalSubmissions = submissions.filter(
    (s) => s.submission.status === 'locked' || s.submission.status === 'submitted',
  );
  const drafts = submissions.filter((s) => s.submission.status === 'draft');
  const openFlags = flags.filter((f) => f.status === 'open');
  const proposedDqs = disqualifications.filter((d) => d.status === 'proposed');
  const failed = submissions.filter((s) => s.stage === 'failed');

  const checklist = buildChecklist({
    cohort,
    ideaCount: ideas.length,
    teamCount: teams.length,
    finalSubmissionCount: finalSubmissions.length,
    completedAssessments: stats.completed,
    hasSnapshot: Boolean(snapshot),
    finalistCount: selections.length,
  });

  const currentStep = checklist.find((item) => item.state === 'current');
  const previewToken = demo?.getDemoInviteToken(demoTeamId(27)) ?? null;

  return (
    <div>
      {isDemo() && (
        <OnboardingPanel
          cohortId={cohort.id}
          previewHref={previewToken ? `/submit/${previewToken}` : null}
        />
      )}

      <PageHeading
        eyebrow="AI Accelerator"
        title={cohort.name}
        description={
          <>
            Submissions close{' '}
            <strong className="text-ink">
              {formatInTimezone(cohort.day13DeadlineAt, cohort.timezone, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </strong>
            . Private shortlist due{' '}
            <strong className="text-ink">
              {formatInTimezone(shortlistWindow.dueAt, cohort.timezone, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </strong>
            .
          </>
        }
        actions={<StatusPill status={cohort.status} />}
      />

      {/* The single most useful sentence on the page. */}
      <Card
        tone={shortlistWindow.onTrack ? 'accent' : 'default'}
        className={cn('mb-8', !shortlistWindow.onTrack && 'border-warning/40 bg-warning-tint')}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted">
              {deadline.hasPassed ? 'Judging window' : 'Submissions open'}
            </p>
            <p className="mt-1.5 text-lg font-bold text-ink">
              {deadline.hasPassed
                ? shortlistWindow.label
                : `${deadline.remainingLabel} until submissions close`}
            </p>
            {currentStep && (
              <p className="mt-2 text-sm text-muted">
                Next: <span className="font-semibold text-ink">{currentStep.title}</span>
              </p>
            )}
          </div>
          {currentStep?.href && (
            <Link
              href={currentStep.href}
              className="rounded-[10px] bg-brand px-5 py-2.5 text-sm font-bold text-black transition-colors hover:bg-brand-hover"
            >
              {currentStep.cta}
            </Link>
          )}
        </div>
      </Card>

      {/* Run this cohort — the operational sequence, made explicit. */}
      <Card className="mb-8" testId="cohort-checklist">
        <CardHeader
          title="Run this cohort"
          description="The sequence from an empty cohort to four finalists. Each step unlocks the next."
        />
        <ol className="space-y-2">
          {checklist.map((item, index) => (
            <li
              key={item.title}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-[10px] border p-3.5',
                item.state === 'current'
                  ? 'border-brand-edge bg-brand-tint'
                  : item.state === 'blocked'
                    ? 'border-line bg-surface/40'
                    : 'border-line bg-canvas',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  item.state === 'complete'
                    ? 'bg-brand text-black'
                    : item.state === 'current'
                      ? 'border border-brand text-brand'
                      : 'border border-line text-muted',
                )}
              >
                {item.state === 'complete' ? '✓' : index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'font-semibold',
                    item.state === 'blocked' ? 'text-muted' : 'text-ink',
                  )}
                >
                  {item.title}
                </p>
                <p className="text-sm text-muted">{item.detail}</p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Badge
                  tone={
                    item.state === 'complete'
                      ? 'success'
                      : item.state === 'current'
                        ? 'accent'
                        : 'neutral'
                  }
                >
                  {STATE_LABEL[item.state]}
                </Badge>
                {item.href && item.state !== 'blocked' && (
                  <Link
                    href={item.href}
                    className="rounded-[10px] border border-line bg-surface-soft px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
                  >
                    {item.cta}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat label="Teams invited" value={teams.length} />
        <Stat label="Drafts" value={drafts.length} />
        <Stat label="Final submissions" value={finalSubmissions.length} tone="accent" />
        <Stat label="Assessments done" value={stats.completed} hint={`of ${stats.total} queued`} />
        <Stat
          label="Needs attention"
          value={openFlags.length + proposedDqs.length + failed.length}
          tone={openFlags.length + proposedDqs.length + failed.length > 0 ? 'attention' : 'default'}
        />
        <Stat
          label="Shortlist"
          value={snapshot ? `Top ${Math.min(snapshot.shortlistTarget, snapshot.entries.length)}` : '—'}
          hint={snapshot ? `${snapshot.eligibleCount} eligible` : 'Not generated'}
        />
      </div>

      {/* Attention required — actionable issues only. */}
      <Card className="mb-8" testId="attention-required">
        <CardHeader
          title="Attention required"
          description="Only things a person must decide. The system proposes; it never resolves these itself."
        />
        {openFlags.length === 0 && proposedDqs.length === 0 && failed.length === 0 ? (
          <p className="text-sm text-muted">Nothing outstanding. ✓</p>
        ) : (
          <ul className="space-y-2">
            {openFlags.map((flag) => (
              <AttentionRow
                key={flag.id}
                tone="warning"
                title={`Group ${flag.groupNumber} — ${humanise(flag.reasonCode)}`}
                detail={flag.detail}
                href={`/admin/submissions/${flag.submissionId}`}
                cta="Review case"
              />
            ))}
            {proposedDqs.map((dq) => (
              <AttentionRow
                key={dq.id}
                tone="danger"
                title={`Group ${groupFor(submissions, dq.submissionId)} — proposed disqualification, ${humanise(dq.reasonCode)}`}
                detail={dq.reasonDetail}
                href={`/admin/submissions/${dq.submissionId}`}
                cta="Confirm or dismiss"
              />
            ))}
            {failed.map((item) => (
              <AttentionRow
                key={item.submission.id}
                tone="danger"
                title={`Group ${item.team.groupNumber} — assessment failed`}
                detail="The product could not be assessed. Check the preflight attempts before deciding anything."
                href={`/admin/submissions/${item.submission.id}`}
                cta="Open submission"
              />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Quick actions" description="Only what applies at this stage." />
        <div className="flex flex-wrap gap-3">
          {previewToken && (
            <Link
              href={`/submit/${previewToken}`}
              className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
            >
              Preview learner portal
            </Link>
          )}
          <Link
            href={`/admin/cohorts/${cohort.id}/teams`}
            className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
          >
            Download invite links
          </Link>
          {cohort.status === 'open' && (
            <Link
              href="/admin/cohorts"
              className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
            >
              Close submissions
            </Link>
          )}
          {(cohort.status === 'closed' || cohort.status === 'judging') && (
            <Link
              href="/admin/assessment-queue"
              className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
            >
              Judging progress
            </Link>
          )}
          {snapshot && (
            <Link
              href="/admin/ranking"
              className="rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
            >
              Review shortlist
            </Link>
          )}
        </div>
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------------

type ChecklistState = 'complete' | 'current' | 'blocked' | 'not_started';

const STATE_LABEL: Record<ChecklistState, string> = {
  complete: 'Complete',
  current: 'Do this next',
  blocked: 'Blocked',
  not_started: 'Not started',
};

interface ChecklistItem {
  title: string;
  detail: string;
  state: ChecklistState;
  href?: string;
  cta: string;
}

/**
 * The operational sequence.
 *
 * Exactly one item is `current` — the thing to do next. Everything before it is
 * complete; everything after is blocked until it is done.
 */
function buildChecklist(input: {
  cohort: Cohort;
  ideaCount: number;
  teamCount: number;
  finalSubmissionCount: number;
  completedAssessments: number;
  hasSnapshot: boolean;
  finalistCount: number;
}): ChecklistItem[] {
  const { cohort } = input;
  const configured = Boolean(cohort.name && cohort.day13DeadlineAt);

  const done = [
    configured,
    input.ideaCount > 0,
    input.teamCount > 0,
    ['open', 'paused', 'closed', 'judging', 'finalised'].includes(cohort.status),
    ['judging', 'finalised'].includes(cohort.status) || input.completedAssessments > 0,
    input.hasSnapshot,
    input.finalistCount === 4,
  ];

  const definitions: Omit<ChecklistItem, 'state'>[] = [
    {
      title: 'Configure cohort',
      detail: 'Name, code, timezone and the Day 12 to Day 13 schedule.',
      href: '/admin/cohorts',
      cta: 'Open cohorts',
    },
    {
      title: 'Review approved ideas',
      detail: `${input.ideaCount} idea${input.ideaCount === 1 ? '' : 's'} configured. Teams may only build from these.`,
      href: `/admin/cohorts/${cohort.id}/ideas`,
      cta: 'Review ideas',
    },
    {
      title: 'Import teams and generate invite links',
      detail: `${input.teamCount} team${input.teamCount === 1 ? '' : 's'} imported. One private link each.`,
      href: `/admin/cohorts/${cohort.id}/teams`,
      cta: 'Manage teams',
    },
    {
      title: 'Open submissions',
      detail: 'Teams with valid invite links can edit and submit.',
      href: '/admin/cohorts',
      cta: 'Change status',
    },
    {
      title: 'Close submissions and start judging',
      detail: `${input.finalSubmissionCount} final submission${input.finalSubmissionCount === 1 ? '' : 's'} ready to assess.`,
      href: '/admin/assessment-queue',
      cta: 'Judging progress',
    },
    {
      title: 'Review the top 10',
      detail: 'Read the evidence behind the private shortlist, not just the scores.',
      href: '/admin/ranking',
      cta: 'Open shortlist',
    },
    {
      title: 'Select four finalists',
      detail: 'The final decision is yours. Each choice needs a recorded reason.',
      href: '/admin/final-selection',
      cta: 'Select finalists',
    },
  ];

  const firstIncomplete = done.findIndex((d) => !d);

  return definitions.map((definition, index) => {
    let state: ChecklistState;
    if (done[index]) state = 'complete';
    else if (index === firstIncomplete) state = 'current';
    else state = 'blocked';
    return { ...definition, state };
  });
}

function AttentionRow({
  tone,
  title,
  detail,
  href,
  cta,
}: {
  tone: 'warning' | 'danger';
  title: string;
  detail: string;
  href: string;
  cta: string;
}) {
  return (
    <li
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-[10px] border-l-4 border border-line p-3.5',
        tone === 'warning' ? 'border-l-warning bg-warning-tint' : 'border-l-danger bg-danger-tint',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-ink">{title}</p>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      <Link
        href={href}
        className="shrink-0 rounded-[10px] border border-line bg-surface-soft px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
      >
        {cta}
      </Link>
    </li>
  );
}

function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

/** Every attention row names a group, so the list scans consistently. */
function groupFor(
  submissions: { submission: { id: string }; team: { groupNumber: number } }[],
  submissionId: string,
): string {
  const match = submissions.find((s) => s.submission.id === submissionId);
  return match ? String(match.team.groupNumber) : '—';
}
