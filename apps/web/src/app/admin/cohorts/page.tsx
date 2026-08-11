import Link from 'next/link';
import { formatInTimezone } from '@ohj/shared';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { Card, CardHeader, EmptyState, PageHeading, StatusPill } from '@/components/ui';
import { CreateCohortFlow } from './create-cohort-flow';
import { LifecycleControls } from './lifecycle-controls';

export const dynamic = 'force-dynamic';

/**
 * Cohorts.
 *
 * Cards rather than a dense table, and creation lives behind a guided
 * three-step flow instead of a permanent form. Lifecycle changes explain their
 * effect before they happen — "Close submissions" means something specific to
 * every team holding an invite link.
 */
export default async function CohortsPage() {
  const session = await requireAdmin();
  const store = getStore();
  const cohorts = await store.cohorts.listCohorts();

  const summaries = await Promise.all(
    cohorts.map(async (cohort) => {
      const [submissions, teams] = await Promise.all([
        store.submissions.listSubmissions(cohort.id),
        store.teams.listTeams(cohort.id),
      ]);
      return {
        cohort,
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

      {summaries.length === 0 ? (
        <EmptyState
          title="No cohorts yet"
          description="Create one to configure ideas, import teams and start accepting submissions."
        />
      ) : (
        <div className="space-y-6">
          {summaries.map(({ cohort, teamCount, finalCount, draftCount }) => (
            <Card key={cohort.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-xl font-bold text-ink">{cohort.name}</h2>
                    <StatusPill status={cohort.status} />
                  </div>
                  <p className="mt-1 font-mono text-sm text-muted">{cohort.code}</p>
                  {cohort.description && (
                    <p className="mt-2 max-w-2xl text-sm text-muted">{cohort.description}</p>
                  )}
                </div>

                <Link
                  href={`/admin/cohorts/${cohort.id}/ideas`}
                  className="shrink-0 rounded-[10px] bg-brand px-4 py-2.5 text-sm font-bold text-black transition-colors hover:bg-brand-hover"
                >
                  Manage cohort
                </Link>
              </div>

              <dl className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  [
                    'Submissions close',
                    formatInTimezone(cohort.day13DeadlineAt, cohort.timezone, {
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
                  cohortId={cohort.id}
                  currentStatus={cohort.status}
                  csrfToken={session.csrfToken}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
