import Link from 'next/link';
import { requireAdmin } from '@/server/admin-auth';
import { getIntakeConfig } from '@/server/intake-actions';
import { getStoreAsync } from '@/lib/store';
import { cohortHref, selectAdminCohort } from '@/lib/admin-cohort';
import { Alert, PageHeading } from '@/components/ui';
import { CohortSwitcher } from '@/components/cohort-switcher';
import { IntakeControl } from './intake-control';

export const dynamic = 'force-dynamic';

/**
 * The control room for Google Sheet → Judge, one cohort at a time.
 *
 * The operator picks the cohort; the cohort carries the tab it reads and the
 * external id it imports under (0016). Three things, in the order an operator
 * does them: check the connection, look at what is in that tab, then import
 * into that cohort. Nothing here polls, and changing the selection reads and
 * writes nothing.
 */
export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string }>;
}) {
  await requireAdmin();
  const { cohort: requested } = await searchParams;
  const store = await getStoreAsync();
  const all = await store.cohorts.listCohorts();
  const sheetCohorts = all.filter((c) => c.intakeMode === 'sheet');
  // Only sheet-fed cohorts are candidates; the default is the one that is
  // closed or judging when there is exactly one, never a guess between two.
  const selection = selectAdminCohort(sheetCohorts, requested, ['closed', 'judging', 'draft']);
  const config = await getIntakeConfig(selection.cohort?.id ?? null);

  return (
    <div className="space-y-6">
      <PageHeading
        title="Google Sheet intake"
        description="Choose the cohort, check its sheet tab, review what is in it, and import final submissions for judging. Each cohort reads only its own tab."
      />

      {selection.notFound && (
        <Alert tone="danger" title="Cohort not found">
          No cohort has the id in this link. Choose one below.
        </Alert>
      )}

      {sheetCohorts.length === 0 ? (
        <Alert tone="info" title="No sheet-fed cohort yet" testId="intake-no-cohorts">
          Create a cohort with intake mode “External Google Sheet intake”, give it its external cohort ID
          and sheet tab under <Link href="/admin/cohorts" className="underline">Cohorts</Link>, then come
          back here.
        </Alert>
      ) : (
        <CohortSwitcher
          path="/admin/intake"
          cohorts={sheetCohorts}
          selectedId={selection.cohort?.id ?? null}
          explicit={selection.explicit}
        />
      )}

      {selection.cohort && (
        <IntakeControl
          key={selection.cohort.id}
          config={config}
          links={{
            submissions: cohortHref('/admin/submissions', selection.cohort.id),
            judging: cohortHref('/admin/assessment-queue', selection.cohort.id),
            ranking: cohortHref('/admin/ranking', selection.cohort.id),
            cohorts: '/admin/cohorts',
          }}
        />
      )}
    </div>
  );
}
