import { redirect } from 'next/navigation';
import { getStoreAsync } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Top-level Submissions entry.
 *
 * Sends the operator to the active cohort's submission list, so "Submissions"
 * in the navigation means something without first asking which cohort.
 */
export default async function SubmissionsEntryPage() {
  await requireAdmin();
  const cohorts = await (await getStoreAsync()).cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging' || c.status === 'open') ?? cohorts[0];

  if (!cohort) {
    return (
      <EmptyState
        title="No cohorts yet"
        description="Create a cohort before there are submissions to review."
      />
    );
  }

  redirect(`/admin/cohorts/${cohort.id}/submissions`);
}
