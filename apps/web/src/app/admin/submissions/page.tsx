import { redirect } from 'next/navigation';
import { getStoreAsync } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { selectAdminCohort } from '@/lib/admin-cohort';
import { EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Top-level Submissions entry.
 *
 * Sends the operator to the selected cohort's submission list — `?cohort=` when
 * the link carries one, otherwise the single judging or open cohort — so
 * "Submissions" in the navigation means something without first asking which
 * cohort. The cohort list itself is scoped by the id in its own URL.
 */
export default async function SubmissionsEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string }>;
}) {
  await requireAdmin();
  const cohorts = await (await getStoreAsync()).cohorts.listCohorts();
  const selection = selectAdminCohort(cohorts, (await searchParams).cohort);

  if (selection.notFound) {
    return <EmptyState title="Cohort not found" description="No cohort has the id in this link. Open Cohorts and choose one." />;
  }
  if (!selection.cohort) {
    return (
      <EmptyState
        title="No cohorts yet"
        description="Create a cohort before there are submissions to review."
      />
    );
  }

  redirect(`/admin/cohorts/${selection.cohort.id}/submissions`);
}
