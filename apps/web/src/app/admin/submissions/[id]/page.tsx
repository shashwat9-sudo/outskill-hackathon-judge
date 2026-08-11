import { notFound } from 'next/navigation';
import Link from 'next/link';
import { formatInTimezone } from '@ohj/shared';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { Badge } from '@/components/ui';
import { SubmissionDetail } from './submission-detail';

export const dynamic = 'force-dynamic';

/**
 * The full internal record for one submission.
 *
 * Everything a reviewer needs to defend a decision is on this page: compliance,
 * preflight attempts, the generated test plan, browser evidence, scores with
 * their evidence and confidence, feedback, review flags, and the audit trail.
 */
export default async function SubmissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireAdmin();
  const store = getStore();

  const detail = await store.submissions.getSubmissionDetail(id);
  if (!detail) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/admin/cohorts/${detail.cohort.id}/submissions`}
          className="text-sm text-brand underline"
        >
          ← All submissions
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              Group {detail.team.groupNumber} — {detail.submission.productName ?? 'Untitled'}
            </h1>
            <p className="text-sm text-muted">
              {detail.idea?.title ?? 'No idea selected'} ·{' '}
              {detail.submission.submittedAt
                ? `Submitted ${formatInTimezone(detail.submission.submittedAt, detail.cohort.timezone, { dateStyle: 'medium', timeStyle: 'short' })}`
                : 'Never finally submitted'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={detail.submission.status === 'locked' ? 'success' : 'neutral'}>
              {detail.submission.status}
            </Badge>
            {detail.job && <Badge tone="info">{detail.job.stage.replace(/_/g, ' ')}</Badge>}
            {detail.rank && <Badge tone="brand">rank {detail.rank}</Badge>}
            {detail.inShortlist && <Badge tone="success">top 10</Badge>}
            {detail.summary?.lowConfidence && <Badge tone="warning">low confidence</Badge>}
          </div>
        </div>
      </div>

      {/* Dates cross the server/client boundary as ISO strings and back. */}
      <SubmissionDetail detail={JSON.parse(JSON.stringify(detail))} csrfToken={session.csrfToken} />
    </div>
  );
}
