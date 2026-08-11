import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { Badge, Card, CardHeader, Table, Td, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function SubmissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; stage?: string }>;
}) {
  const { id } = await params;
  const { q, stage } = await searchParams;
  await requireAdmin();
  const store = getStore();

  const cohort = await store.cohorts.getCohort(id);
  if (!cohort) notFound();

  const submissions = await store.submissions.listSubmissions(id, {
    search: q,
    ...(stage ? { stage: stage as never } : {}),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Submissions</h1>
        <p className="text-sm text-muted">{cohort.name}</p>
      </div>

      <Card>
        <CardHeader
          title={`${submissions.length} submission${submissions.length === 1 ? '' : 's'}`}
          description="Scores and ranks shown here are internal and never leave this dashboard."
        />

        <form method="get" className="mb-4 flex flex-wrap gap-3">
          <label htmlFor="q" className="sr-only">
            Search by group, product or email
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Search group, product or email"
            className="w-64 rounded-md border border-line px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-md border border-line px-3 py-2 text-sm font-medium">
            Filter
          </button>
        </form>

        <Table caption="All submissions in this cohort">
          <thead>
            <tr>
              <Th>Group</Th>
              <Th>Product</Th>
              <Th>Idea</Th>
              <Th>Submission</Th>
              <Th>Stage</Th>
              <Th className="text-right">Score</Th>
              <Th className="text-right">Rank</Th>
              <Th>Flags</Th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((item) => (
              <tr key={item.submission.id}>
                <Td className="font-mono font-semibold">
                  <Link href={`/admin/submissions/${item.submission.id}`} className="text-brand underline">
                    {item.team.groupNumber}
                  </Link>
                </Td>
                <Td>{item.submission.productName ?? <span className="text-muted">—</span>}</Td>
                <Td className="text-muted">{item.ideaTitle ?? '—'}</Td>
                <Td>
                  <Badge tone={item.submission.status === 'locked' ? 'success' : 'neutral'}>
                    {item.submission.status}
                  </Badge>
                  {item.submission.isLate && (
                    <Badge tone="warning" className="ml-1">
                      late
                    </Badge>
                  )}
                </Td>
                <Td>
                  {item.stage ? (
                    <Badge tone={STAGE_TONE[item.stage] ?? 'neutral'}>{item.stage.replace(/_/g, ' ')}</Badge>
                  ) : (
                    <span className="text-muted">not queued</span>
                  )}
                </Td>
                <Td className="text-right font-mono">
                  {item.totalScore !== null ? item.totalScore.toFixed(2) : '—'}
                </Td>
                <Td className="text-right font-mono">
                  {item.rank ?? '—'}
                  {item.inShortlist && (
                    <Badge tone="success" className="ml-1">
                      top 10
                    </Badge>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {item.lowConfidence && <Badge tone="warning">low confidence</Badge>}
                    {item.hasOpenManualReview && <Badge tone="warning">manual review</Badge>}
                    {item.disqualificationStatus === 'proposed' && <Badge tone="danger">DQ proposed</Badge>}
                    {item.disqualificationStatus === 'confirmed' && <Badge tone="danger">disqualified</Badge>}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

const STAGE_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  completed: 'success',
  failed: 'danger',
  disqualified: 'danger',
  manual_review: 'warning',
  queued: 'info',
};
