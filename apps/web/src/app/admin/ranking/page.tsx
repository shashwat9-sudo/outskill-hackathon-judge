import Link from 'next/link';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import {
  exportShortlistAction,
  generateRankingAction,
  runConsistencyPassAction,
} from '@/server/admin-actions';
import { AdminForm, DownloadButton } from '@/components/admin-form';
import { Alert, Badge, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Private ranking.
 *
 * The whole ranking and the highlighted shortlist are internal. Snapshots are
 * immutable (ADR-011): regenerating creates a new one and keeps the old, so the
 * ranking a decision was made against stays reconstructable.
 */
export default async function RankingPage() {
  const session = await requireAdmin();
  const store = getStore();
  const cohorts = await store.cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging') ?? cohorts[0];

  if (!cohort) return <EmptyState title="No cohorts yet" />;

  const [snapshot, snapshots] = await Promise.all([
    store.ranking.getCurrentSnapshot(cohort.id),
    store.ranking.listSnapshots(cohort.id),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Ranking</h1>
          <p className="text-sm text-muted">{cohort.name}</p>
        </div>
        {snapshot && (
          <DownloadButton
            label="Export shortlist CSV"
            filename={`shortlist-${cohort.code}.csv`}
            action={exportShortlistAction}
            arg={cohort.id}
          />
        )}
      </div>

      <Alert tone="warning" title="Internal only">
        Ranking, scores and shortlist membership are never shown to participants, in any cohort
        status. The system produces a ranking; it does not produce winners.
      </Alert>

      <Card>
        <CardHeader
          title="Generate a snapshot"
          description="Ranks every eligible submission — completed, fully scored, and not confirmed-disqualified. Previous snapshots are kept."
        />
        <AdminForm action={generateRankingAction} csrfToken={session.csrfToken} submitLabel="Generate snapshot">
          <input type="hidden" name="cohortId" value={cohort.id} />
          <Field id="notes" label="Note" hint="Why you regenerated — e.g. “after resolving group 33”.">
            {(aria) => <Input {...aria} name="notes" />}
          </Field>
        </AdminForm>
      </Card>

      {snapshot && (
        <Card>
          <CardHeader
            title="Second scoring pass"
            description="Runs only where a disagreement would change an outcome: the top 20, low-confidence cases, open manual reviews, submissions within two points of the cutoff, close ties, and disputed scores."
          />
          <AdminForm
            action={runConsistencyPassAction}
            csrfToken={session.csrfToken}
            submitLabel="Queue consistency pass"
            submitVariant="secondary"
          >
            <input type="hidden" name="cohortId" value={cohort.id} />
          </AdminForm>
        </Card>
      )}

      {!snapshot ? (
        <EmptyState
          title="No ranking yet"
          description="Generate a snapshot once assessment has completed for the cohort."
        />
      ) : (
        <Card>
          <CardHeader
            title={`Current ranking — ${snapshot.eligibleCount} eligible`}
            description={`Generated ${new Date(snapshot.generatedAt).toLocaleString()} · rubric ${snapshot.rubricVersion}${snapshot.notes ? ` · ${snapshot.notes}` : ''}`}
          />
          <Table caption="Full private ranking">
            <thead>
              <tr>
                <Th className="w-12">#</Th>
                <Th>Group</Th>
                <Th>Product</Th>
                <Th>Idea</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Workflow</Th>
                <Th className="text-right">Stability</Th>
                <Th className="text-right">Confidence</Th>
                <Th>Flags</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.entries.map((entry) => (
                <tr key={entry.submissionId} className={entry.entry.inShortlist ? 'bg-brand-tint' : undefined}>
                  <Td className="font-mono font-bold">
                    {entry.entry.rank}
                    {entry.entry.inShortlist && (
                      <span className="sr-only"> (in the private shortlist)</span>
                    )}
                  </Td>
                  <Td className="font-mono">
                    <Link href={`/admin/submissions/${entry.submissionId}`} className="text-brand underline">
                      {entry.groupNumber}
                    </Link>
                  </Td>
                  <Td>{entry.productName ?? '—'}</Td>
                  <Td className="text-muted">{entry.ideaTitle ?? '—'}</Td>
                  <Td className="text-right font-mono font-bold">{entry.entry.totalScore.toFixed(2)}</Td>
                  <Td className="text-right font-mono text-muted">
                    {(entry.entry.tiebreakVector.core_workflow ?? 0).toFixed(2)}
                  </Td>
                  <Td className="text-right font-mono text-muted">
                    {(entry.entry.tiebreakVector.stability ?? 0).toFixed(2)}
                  </Td>
                  <Td className="text-right font-mono">{entry.entry.meanConfidence.toFixed(2)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {entry.entry.inShortlist && <Badge tone="success">top {snapshot.shortlistTarget}</Badge>}
                      {entry.lowConfidence && <Badge tone="warning">low confidence</Badge>}
                      {entry.hasOpenManualReview && <Badge tone="warning">review open</Badge>}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-3 text-xs text-muted">
            Ties are broken by total score, then core workflow, stability, AI usefulness, learning and
            execution, then fewer unresolved risks. The tie-break chain is internal.
          </p>
        </Card>
      )}

      {snapshots.length > 1 && (
        <Card>
          <CardHeader title="Snapshot history" description="Immutable. Every decision stays reconstructable." />
          <Table caption="Previous ranking snapshots">
            <thead>
              <tr>
                <Th>Generated</Th>
                <Th className="text-right">Eligible</Th>
                <Th>Note</Th>
                <Th>Current</Th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((item) => (
                <tr key={item.id}>
                  <Td>{new Date(item.generatedAt).toLocaleString()}</Td>
                  <Td className="text-right font-mono">{item.eligibleCount}</Td>
                  <Td className="text-muted">{item.notes ?? '—'}</Td>
                  <Td>{item.isCurrent && <Badge tone="success">current</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
