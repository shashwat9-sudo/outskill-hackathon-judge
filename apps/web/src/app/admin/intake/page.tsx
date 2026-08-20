import { requireAdmin } from '@/server/admin-auth';
import { getIntakeConfig } from '@/server/intake-actions';
import { PageHeading } from '@/components/ui';
import { IntakeControl } from './intake-control';

export const dynamic = 'force-dynamic';

/**
 * The control room for Google Sheet → Judge.
 *
 * Three things, in the order an operator does them: check the connection, look
 * at what is in the sheet, then import. Nothing here polls — learners keep
 * editing until the deadline, so the operator decides when to look and when to
 * import.
 */
export default async function IntakePage() {
  await requireAdmin();
  const config = await getIntakeConfig();

  return (
    <div className="space-y-6">
      <PageHeading
        title="Google Sheet intake"
        description="Check the submissions sheet, review what is in it, and import final submissions for judging."
      />
      <IntakeControl config={config} />
    </div>
  );
}
