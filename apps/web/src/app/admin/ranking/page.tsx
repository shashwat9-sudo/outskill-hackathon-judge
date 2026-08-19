import Link from 'next/link';
import {
  JUDGING_UNAVAILABLE_MESSAGE,
  RUBRIC_CATEGORIES,
  storeCapabilities,
} from '@ohj/shared';
import { getStoreAsync } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import {
  exportShortlistAction,
  generateRankingAction,
  runConsistencyPassAction,
} from '@/server/admin-actions';
import { AdminForm, DownloadButton } from '@/components/admin-form';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  Disclosure,
  EmptyState,
  Field,
  Input,
  PageHeading,
  Table,
  Td,
  Th,
  cn,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Private shortlist.
 *
 * The top 10 is the working surface; the full eligible ranking sits below it,
 * visually secondary. Deliberately no winner language anywhere on this page —
 * winners are chosen on the Finalists page, by a person.
 */
export default async function ShortlistPage() {
  const session = await requireAdmin();
  const store = await getStoreAsync();

  // Judging is not available in this deployment (Phase B). Every read below
  // reaches a gated repository, which throws rather than returning an empty
  // result that would render as a real answer.
  if (!storeCapabilities(store).ranking) {
    return (
      <div>
        <PageHeading title="Shortlist" description="The private top 10, generated from assessment scores." />
        <Alert tone="info" testId="judging-unavailable">
          <p className="font-semibold">{JUDGING_UNAVAILABLE_MESSAGE}</p>
          <p className="mt-2">
            Teams can still submit, and cohorts, access codes and submissions all work normally.
            Nothing is lost by waiting.
          </p>
        </Alert>
      </div>
    );
  }
  const cohorts = await store.cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging') ?? cohorts[0];

  if (!cohort) return <EmptyState title="No cohorts yet" />;

  const [snapshot, snapshots] = await Promise.all([
    store.ranking.getCurrentSnapshot(cohort.id),
    store.ranking.listSnapshots(cohort.id),
  ]);

  const shortlisted = snapshot?.entries.filter((e) => e.entry.inShortlist) ?? [];
  const remainder = snapshot?.entries.filter((e) => !e.entry.inShortlist) ?? [];

  return (
    <div>
      <PageHeading
        title="Private shortlist"
        description="The strongest submissions by evidence-backed score, for internal review only."
        actions={
          snapshot ? (
            <DownloadButton
              label="Export shortlist"
              filename={`shortlist-${cohort.code}.csv`}
              action={exportShortlistAction}
              arg={cohort.id}
            />
          ) : undefined
        }
      />

      <Alert tone="warning" title="Private — never visible to participants" className="mb-8">
        Ranking, scores and shortlist membership are never shown to participants, in any cohort
        status. The platform produces a shortlist; the final decision is made by the Outskill team on the Finalists page.
      </Alert>

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Generate a shortlist"
            description="Ranks every eligible submission — completed, fully scored, and not disqualified. Previous versions are kept."
            level={3}
          />
          <AdminForm
            action={generateRankingAction}
            csrfToken={session.csrfToken}
            submitLabel="Generate shortlist"
          >
            <input type="hidden" name="cohortId" value={cohort.id} />
            <Field id="notes" label="Note" hint="Why you regenerated — e.g. “after resolving group 33”.">
              {(aria) => <Input {...aria} name="notes" />}
            </Field>
          </AdminForm>
        </Card>

        <Card>
          <CardHeader
            title="Second scoring pass"
            description="Runs only where a disagreement would change an outcome: the top 20, low-confidence cases, open reviews, anything near the cutoff, close ties and disputed scores."
            level={3}
          />
          <AdminForm
            action={runConsistencyPassAction}
            csrfToken={session.csrfToken}
            submitLabel="Run second pass"
            submitVariant="secondary"
          >
            <input type="hidden" name="cohortId" value={cohort.id} />
          </AdminForm>
        </Card>
      </div>

      {!snapshot ? (
        <EmptyState
          title="No shortlist yet"
          description="Generate one once assessment has completed for the cohort."
        />
      ) : (
        <>
          <Card className="mb-8">
            <CardHeader
              title={`Top ${shortlisted.length}`}
              description={`From ${snapshot.eligibleCount} eligible submissions · generated ${new Date(
                snapshot.generatedAt,
              ).toLocaleString()}${snapshot.notes ? ` · ${snapshot.notes}` : ''}`}
            />

            <ol className="space-y-3" data-testid="shortlist-entries">
              {shortlisted.map((entry) => (
                <li
                  key={entry.submissionId}
                  className="rounded-[10px] border border-brand-edge bg-brand-tint p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="flex min-w-0 gap-4">
                      <span
                        aria-hidden="true"
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-lg font-bold text-on-accent"
                      >
                        {entry.entry.rank}
                      </span>
                      <div className="min-w-0">
                        <p className="font-bold text-ink">
                          {entry.productName ?? 'Untitled'}{' '}
                          <span className="font-mono text-sm font-normal text-muted">
                            · Group {entry.groupNumber}
                          </span>
                        </p>
                        <p className="text-sm text-muted">{entry.ideaTitle ?? '—'}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {entry.lowConfidence && <Badge tone="warning">Low confidence</Badge>}
                          {entry.hasOpenManualReview && <Badge tone="warning">Review open</Badge>}
                          {!entry.lowConfidence && !entry.hasOpenManualReview && (
                            <Badge tone="success">No unresolved flags</Badge>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-start gap-4">
                      <div className="text-right">
                        <p className="text-2xl font-bold tabular-nums text-ink">
                          {entry.entry.totalScore.toFixed(1)}
                        </p>
                        <p className="text-xs text-muted">
                          confidence {entry.entry.meanConfidence.toFixed(2)}
                        </p>
                      </div>
                      <Link
                        href={`/admin/submissions/${entry.submissionId}`}
                        className="rounded-[10px] border border-line bg-surface-soft px-3 py-1.5 text-sm font-semibold text-ink hover:border-brand-edge"
                      >
                        Review evidence
                      </Link>
                    </div>
                  </div>

                  {/* Category breakdown, so a rank is never just a number. */}
                  <div className="mt-4 grid grid-cols-2 gap-2 border-t border-brand-edge pt-3 sm:grid-cols-4">
                    {(
                      ['core_workflow', 'solution_usefulness', 'ai_usefulness', 'two_day_execution'] as const
                    ).map((key) => {
                      const category = RUBRIC_CATEGORIES.find((c) => c.key === key);
                      const value = entry.entry.tiebreakVector[key] ?? 0;
                      return (
                        <div key={key}>
                          <p className="text-xs text-muted">{category?.title}</p>
                          <p className="font-mono text-sm font-semibold text-ink">
                            {value.toFixed(1)}
                            <span className="text-muted"> / {category?.maxPoints}</span>
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {/* Everything else — available, visually secondary. */}
          <Disclosure summary={`Full eligible ranking (${snapshot.entries.length})`}>
            <Table caption="Full private ranking">
              <thead>
                <tr>
                  <Th className="w-12">#</Th>
                  <Th>Group</Th>
                  <Th>Product</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Confidence</Th>
                  <Th>Flags</Th>
                </tr>
              </thead>
              <tbody>
                {[...shortlisted, ...remainder].map((entry) => (
                  <tr
                    key={entry.submissionId}
                    className={cn(entry.entry.inShortlist && 'bg-brand-tint')}
                  >
                    <Td className="font-mono font-bold">{entry.entry.rank}</Td>
                    <Td className="font-mono">
                      <Link
                        href={`/admin/submissions/${entry.submissionId}`}
                        className="text-brand-text underline underline-offset-4"
                      >
                        {entry.groupNumber}
                      </Link>
                    </Td>
                    <Td>{entry.productName ?? '—'}</Td>
                    <Td className="text-right font-mono font-semibold">
                      {entry.entry.totalScore.toFixed(2)}
                    </Td>
                    <Td className="text-right font-mono">{entry.entry.meanConfidence.toFixed(2)}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {entry.entry.inShortlist && <Badge tone="success">shortlist</Badge>}
                        {entry.lowConfidence && <Badge tone="warning">low confidence</Badge>}
                        {entry.hasOpenManualReview && <Badge tone="warning">review open</Badge>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="mt-4 text-xs text-muted">
              Ties break on core workflow, then solution_usefulness, AI usefulness, learning and execution, then
              fewer unresolved risks. The tie-break chain is internal.
            </p>
          </Disclosure>

          {snapshots.length > 1 && (
            <div className="mt-4">
              <Disclosure summary={`Previous versions (${snapshots.length})`}>
                <Table caption="Previous shortlist versions">
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
                <p className="mt-3 text-xs text-muted">
                  Versions are immutable, so the shortlist a decision was made against stays
                  reconstructable.
                </p>
              </Disclosure>
            </div>
          )}
        </>
      )}
    </div>
  );
}
