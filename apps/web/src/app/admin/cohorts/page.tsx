import Link from 'next/link';
import { computeSubmissionWindow, formatInTimezone, timezoneLabel } from '@ohj/shared';
import { getCapabilities, getStoreAsync } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { Card, CardHeader, EmptyState, PageHeading, StatusPill } from '@/components/ui';
import { CreateCohortFlow } from './create-cohort-flow';
import { LifecycleControls } from './lifecycle-controls';
import { ClosureControls } from './closure-controls';

export const dynamic = 'force-dynamic';

/**
 * Cohorts.
 *
 * Cards rather than a dense table, and creation lives behind a guided
 * three-step flow instead of a permanent form. Lifecycle changes explain their
 * effect before they happen — "Close submissions" means something specific to
 * every team holding an access code.
 */
export default async function CohortsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const session = await requireAdmin();
  const store = await getStoreAsync();
  const all = await store.cohorts.listCohorts();

  /*
   * Archived cohorts are hidden by default, not removed.
   *
   * Every rehearsal, pilot and acceptance run leaves one behind, and they
   * accumulate in front of the one cohort an operator is actually running. The
   * filter is a link, so it survives a reload and can be shared; nothing about
   * a cohort changes, and nothing is deleted — archived cohorts are still one
   * click away, and still open normally when selected.
   */
  const show = (await searchParams).show === 'archived' ? 'archived' : 'active';
  const archivedCount = all.filter((cohort) => cohort.status === 'archived').length;
  const cohorts = all.filter((cohort) =>
    show === 'archived' ? cohort.status === 'archived' : cohort.status !== 'archived',
  );

  const summaries = await Promise.all(
    cohorts.map(async (cohort) => {
      const [submissions, teams] = await Promise.all([
        store.submissions.listSubmissions(cohort.id),
        store.teams.listTeams(cohort.id),
      ]);
      return {
        cohort,
        window: computeSubmissionWindow(cohort),
        teamCount: teams.length,
        finalCount: submissions.filter(
          (s) => s.submission.status === 'locked' || s.submission.status === 'submitted',
        ).length,
        draftCount: submissions.filter((s) => s.submission.status === 'draft').length,
      };
    }),
  );

  return (
    <div>
      <PageHeading
        title="Cohorts"
        description="Each cohort freezes its own ideas, rubric version and judging configuration, so past decisions stay reproducible."
        actions={<CreateCohortFlow csrfToken={session.csrfToken} />}
      />

      <nav aria-label="Filter cohorts" className="mb-6 flex flex-wrap items-center gap-2" data-testid="cohort-filter">
        {(
          [
            ['active', 'Active', all.length - archivedCount],
            ['archived', 'Archived', archivedCount],
          ] as const
        ).map(([key, label, count]) => (
          <Link
            key={key}
            href={key === 'active' ? '/admin/cohorts' : '/admin/cohorts?show=archived'}
            data-testid={`cohort-filter-${key}`}
            aria-current={show === key ? 'page' : undefined}
            className={
              show === key
                ? 'rounded-[10px] border border-brand-edge bg-brand-tint px-3.5 py-2 text-sm font-semibold text-ink'
                : 'rounded-[10px] border border-line px-3.5 py-2 text-sm font-semibold text-muted hover:border-brand-edge hover:text-ink'
            }
          >
            {label} ({count})
          </Link>
        ))}
      </nav>

      {summaries.length === 0 ? (
        <EmptyState
          title={show === 'archived' ? 'No archived cohorts' : 'No active cohorts'}
          description={
            show === 'archived'
              ? 'Archived cohorts keep everything — submissions, receipts, uploads and history. None have been archived yet.'
              : 'Create one to configure ideas, import teams and start accepting submissions.'
          }
        />
      ) : (
        <div className="space-y-6">
          {summaries.map(({ cohort, window, teamCount, finalCount, draftCount }) => (
            <Card key={cohort.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-xl font-bold text-ink">{cohort.name}</h2>
                    <StatusPill status={cohort.status} />
                    {cohort.status === 'open' && window.state !== 'open' && (
                      <span className="text-xs font-semibold text-warning" data-testid="window-drift">
                        Deadline passed — no longer accepting saves
                      </span>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-sm text-muted">{cohort.code}</p>
                  {cohort.description && (
                    <p className="mt-2 max-w-2xl text-sm text-muted">{cohort.description}</p>
                  )}
                </div>

                <Link
                  href={`/admin/cohorts/${cohort.id}/ideas`}
                  className="shrink-0 rounded-[10px] bg-brand px-4 py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-brand-hover"
                >
                  Manage cohort
                </Link>
              </div>

              <dl className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  [
                    window.isExtended ? 'Accepting until' : 'Submissions close',
                    formatInTimezone(window.effectiveDeadline, cohort.timezone, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }),
                  ],
                  ['Teams invited', String(teamCount)],
                  ['Final submissions', String(finalCount)],
                  ['Still draft', String(draftCount)],
                ].map(([term, value]) => (
                  <div key={term}>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-muted">
                      {term}
                    </dt>
                    <dd className="mt-1 text-sm font-semibold text-ink">{value}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-5">
                {[
                  ['Ideas', `/admin/cohorts/${cohort.id}/ideas`],
                  ['Teams and invites', `/admin/cohorts/${cohort.id}/teams`],
                  ['Submissions', `/admin/cohorts/${cohort.id}/submissions`],
                  ['Judging', '/admin/assessment-queue'],
                  ['Results', '/admin/ranking'],
                ].map(([label, href]) => (
                  <Link
                    key={href}
                    href={href as string}
                    className="rounded-[10px] border border-line bg-surface-soft px-3.5 py-2 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
                  >
                    {label}
                  </Link>
                ))}
              </div>

              <div className="mt-6 border-t border-line pt-5">
                <CardHeader
                  title="Lifecycle"
                  description="Each change affects what teams can do right now."
                  level={3}
                />
                <LifecycleControls
                  judgingAvailable={getCapabilities().assessment}
                  cohortId={cohort.id}
                  cohortName={cohort.name}
                  currentStatus={cohort.status}
                  finalSubmissionCount={finalCount}
                  csrfToken={session.csrfToken}
                />
              </div>

              <div className="mt-6">
                <ClosureControls
                  cohortId={cohort.id}
                  status={cohort.status}
                  csrfToken={session.csrfToken}
                  deadlinePassed={new Date() > cohort.day13DeadlineAt}
                  deadlineLabel={`${formatInTimezone(cohort.day13DeadlineAt, cohort.timezone, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })} ${timezoneLabel(cohort.day13DeadlineAt, cohort.timezone)}`}
                  acceptingUntilLabel={
                    cohort.acceptingUntil
                      ? `${formatInTimezone(cohort.acceptingUntil, cohort.timezone, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })} ${timezoneLabel(cohort.acceptingUntil, cohort.timezone)}`
                      : null
                  }
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
