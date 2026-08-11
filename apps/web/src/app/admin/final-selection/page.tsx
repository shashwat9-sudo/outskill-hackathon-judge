import Link from 'next/link';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { clearFinalSelectionAction, setFinalSelectionAction } from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import { Alert, Badge, Card, CardHeader, EmptyState, Field, Select, Table, Td, Textarea, Th } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Final four selection.
 *
 * This page is the only way a winner is ever recorded. No worker, job stage, or
 * AI response has a write path to `final_selections` (ADR-018) — the system
 * ranks and shortlists, and a human chooses.
 */
export default async function FinalSelectionPage() {
  const session = await requireAdmin();
  const store = getStore();
  const cohorts = await store.cohorts.listCohorts();
  const cohort = cohorts.find((c) => c.status === 'judging' || c.status === 'finalised') ?? cohorts[0];

  if (!cohort) return <EmptyState title="No cohorts yet" />;

  const [snapshot, selections] = await Promise.all([
    store.ranking.getCurrentSnapshot(cohort.id),
    store.ranking.listFinalSelections(cohort.id),
  ]);

  const candidates = snapshot?.entries ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Final four</h1>
        <p className="text-sm text-muted">{cohort.name}</p>
      </div>

      <Alert tone="info" title="Humans choose, not the system">
        The platform ranks eligible submissions and highlights a private top {snapshot?.shortlistTarget ?? 10}.
        Selecting the four winners is a decision the Outskill team makes here. Nothing is announced
        automatically, and nothing is shown to participants.
      </Alert>

      {selections.length > 0 && (
        <Card>
          <CardHeader
            title="Current selection"
            description={`Recorded by ${selections[0]?.selectedBy ?? 'shared-admin'} on ${
              selections[0] ? new Date(selections[0].selectedAt).toLocaleString() : ''
            }`}
          />
          <Table caption="Selected winners">
            <thead>
              <tr>
                <Th className="w-16">Position</Th>
                <Th>Group</Th>
                <Th>Product</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {selections.map((selection) => (
                <tr key={selection.id}>
                  <Td className="font-mono font-bold">{selection.position}</Td>
                  <Td className="font-mono">
                    <Link href={`/admin/submissions/${selection.submissionId}`} className="text-brand underline">
                      {selection.groupNumber}
                    </Link>
                  </Td>
                  <Td>{selection.productName ?? '—'}</Td>
                  <Td className="text-muted">{selection.selectionReason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-4 border-t border-line pt-4">
            <AdminForm
              action={clearFinalSelectionAction}
              csrfToken={session.csrfToken}
              submitLabel="Clear selection"
              submitVariant="secondary"
              confirm="Clear the recorded final four? This is logged."
            >
              <input type="hidden" name="cohortId" value={cohort.id} />
            </AdminForm>
          </div>
        </Card>
      )}

      {candidates.length === 0 ? (
        <EmptyState
          title="No ranked candidates yet"
          description="Generate a ranking snapshot before choosing winners."
          action={
            <Link href="/admin/ranking" className="font-semibold text-brand underline">
              Go to ranking
            </Link>
          }
        />
      ) : (
        <Card>
          <CardHeader
            title="Choose exactly four"
            description="Every position needs a reason. That reason is what makes the decision defensible afterwards."
          />
          <AdminForm
            action={setFinalSelectionAction}
            csrfToken={session.csrfToken}
            submitLabel="Record final four"
            confirm="Record these four winners? Nothing is announced automatically."
          >
            <input type="hidden" name="cohortId" value={cohort.id} />
            <div className="space-y-5">
              {[1, 2, 3, 4].map((position) => {
                const current = selections.find((s) => s.position === position);
                return (
                  <div key={position} className="rounded-md border border-line p-4">
                    <h3 className="mb-3 text-sm font-bold">Position {position}</h3>
                    <div className="grid gap-4 md:grid-cols-2">
                      <Field id={`position-${position}`} label="Submission" required>
                        {(aria) => (
                          <Select
                            {...aria}
                            name={`position-${position}`}
                            defaultValue={current?.submissionId ?? ''}
                          >
                            <option value="">Choose…</option>
                            {candidates.map((candidate) => (
                              <option key={candidate.submissionId} value={candidate.submissionId}>
                                #{candidate.entry.rank} · Group {candidate.groupNumber} ·{' '}
                                {candidate.productName} ({candidate.entry.totalScore.toFixed(1)})
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field id={`reason-${position}`} label="Reason" required>
                        {(aria) => (
                          <Textarea
                            {...aria}
                            name={`reason-${position}`}
                            rows={2}
                            defaultValue={current?.selectionReason ?? ''}
                          />
                        )}
                      </Field>
                    </div>
                  </div>
                );
              })}
            </div>
          </AdminForm>
        </Card>
      )}

      {snapshot && (
        <Card>
          <CardHeader title={`Private shortlist (top ${snapshot.shortlistTarget})`} />
          <Table caption="Shortlisted submissions">
            <thead>
              <tr>
                <Th className="w-12">#</Th>
                <Th>Group</Th>
                <Th>Product</Th>
                <Th className="text-right">Score</Th>
                <Th>Flags</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.entries
                .filter((entry) => entry.entry.inShortlist)
                .map((entry) => (
                  <tr key={entry.submissionId}>
                    <Td className="font-mono">{entry.entry.rank}</Td>
                    <Td className="font-mono">
                      <Link href={`/admin/submissions/${entry.submissionId}`} className="text-brand underline">
                        {entry.groupNumber}
                      </Link>
                    </Td>
                    <Td>{entry.productName ?? '—'}</Td>
                    <Td className="text-right font-mono">{entry.entry.totalScore.toFixed(2)}</Td>
                    <Td>
                      {entry.lowConfidence && <Badge tone="warning">low confidence</Badge>}
                      {entry.hasOpenManualReview && <Badge tone="warning">review open</Badge>}
                    </Td>
                  </tr>
                ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
