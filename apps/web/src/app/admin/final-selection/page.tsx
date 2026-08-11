import Link from 'next/link';
import { getStore } from '@/lib/store';
import { requireAdmin } from '@/server/admin-auth';
import { clearFinalSelectionAction, setFinalSelectionAction } from '@/server/admin-actions';
import { AdminForm } from '@/components/admin-form';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Field,
  PageHeading,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Finalist selection.
 *
 * The only page in the product that records a winner, and the only writer to
 * `final_selections` (ADR-018). The four slots start empty and stay empty until
 * a person fills them — nothing pre-populates them, by design.
 */
export default async function FinalistsPage() {
  const session = await requireAdmin();
  const store = getStore();
  const cohorts = await store.cohorts.listCohorts();
  const cohort =
    cohorts.find((c) => c.status === 'judging' || c.status === 'finalised') ?? cohorts[0];

  if (!cohort) return <EmptyState title="No cohorts yet" />;

  const [snapshot, selections] = await Promise.all([
    store.ranking.getCurrentSnapshot(cohort.id),
    store.ranking.listFinalSelections(cohort.id),
  ]);

  const candidates = snapshot?.entries ?? [];

  return (
    <div>
      <PageHeading
        title="Select the final four"
        description="The automated judge provides evidence and a private shortlist. The Outskill team makes the final decision."
        actions={
          <Badge tone={selections.length === 4 ? 'success' : 'neutral'}>
            {selections.length} of 4 selected
          </Badge>
        }
      />

      <Alert tone="accent" title="Humans choose, not the system" className="mb-8">
        No worker, job stage or model response can write to this page. Every position needs a
        recorded reason — that reason is what you will rely on if the outcome is questioned. Nothing
        is announced automatically.
      </Alert>

      {candidates.length === 0 ? (
        <EmptyState
          title="No ranked candidates yet"
          description="Generate a private shortlist before choosing finalists."
          action={
            <Link
              href="/admin/ranking"
              className="rounded-[10px] bg-brand px-4 py-2.5 text-sm font-bold text-black"
            >
              Go to shortlist
            </Link>
          }
        />
      ) : (
        <Card className="mb-8">
          <CardHeader
            title="Four finalist slots"
            description="Choose a submission for each position. All four are required — a partial selection is refused."
          />

          <AdminForm
            action={setFinalSelectionAction}
            csrfToken={session.csrfToken}
            submitLabel="Confirm final four"
            confirm="Record these four finalists? This is logged, and nothing is announced automatically."
          >
            <input type="hidden" name="cohortId" value={cohort.id} />

            <div className="space-y-4" data-testid="finalist-slots">
              {[1, 2, 3, 4].map((position) => {
                const current = selections.find((s) => s.position === position);
                return (
                  <div
                    key={position}
                    className="rounded-[10px] border border-line bg-canvas p-4"
                    data-testid={`finalist-slot-${position}`}
                  >
                    <div className="mb-4 flex items-center gap-3">
                      <span
                        aria-hidden="true"
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-brand text-sm font-bold text-brand"
                      >
                        {position}
                      </span>
                      <h3 className="font-bold text-ink">Position {position}</h3>
                      {current && <Badge tone="success">Selected</Badge>}
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <Field id={`position-${position}`} label="Submission" required>
                        {(aria) => (
                          <Select
                            {...aria}
                            name={`position-${position}`}
                            defaultValue={current?.submissionId ?? ''}
                          >
                            <option value="">Choose a submission…</option>
                            {candidates.map((candidate) => (
                              <option key={candidate.submissionId} value={candidate.submissionId}>
                                #{candidate.entry.rank} · Group {candidate.groupNumber} ·{' '}
                                {candidate.productName} ({candidate.entry.totalScore.toFixed(1)})
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field
                        id={`reason-${position}`}
                        label="Internal note"
                        required
                        hint="Why this team, in your words."
                      >
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

                    {current && (
                      <Link
                        href={`/admin/submissions/${current.submissionId}`}
                        className="mt-3 inline-block text-sm font-semibold text-brand underline underline-offset-4"
                      >
                        Review evidence for Group {current.groupNumber}
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </AdminForm>
        </Card>
      )}

      {selections.length > 0 && (
        <Card className="mb-8">
          <CardHeader
            title="Recorded selection"
            description={`Recorded by ${selections[0]?.selectedBy ?? 'shared-admin'} on ${
              selections[0] ? new Date(selections[0].selectedAt).toLocaleString() : ''
            }`}
          />
          <Table caption="Selected finalists">
            <thead>
              <tr>
                <Th className="w-20">Position</Th>
                <Th>Group</Th>
                <Th>Product</Th>
                <Th>Internal note</Th>
              </tr>
            </thead>
            <tbody>
              {selections.map((selection) => (
                <tr key={selection.id}>
                  <Td className="font-mono font-bold">{selection.position}</Td>
                  <Td className="font-mono">
                    <Link
                      href={`/admin/submissions/${selection.submissionId}`}
                      className="text-brand underline underline-offset-4"
                    >
                      {selection.groupNumber}
                    </Link>
                  </Td>
                  <Td>{selection.productName ?? '—'}</Td>
                  <Td className="text-muted">{selection.selectionReason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <div className="mt-5 border-t border-line pt-4">
            <AdminForm
              action={clearFinalSelectionAction}
              csrfToken={session.csrfToken}
              submitLabel="Clear selection"
              submitVariant="secondary"
              confirm="Clear the recorded finalists? This is logged."
            >
              <input type="hidden" name="cohortId" value={cohort.id} />
            </AdminForm>
          </div>
        </Card>
      )}

      {snapshot && (
        <Card>
          <CardHeader
            title={`Shortlist for reference (top ${snapshot.shortlistTarget})`}
            description="Open any submission to read the evidence behind its score before deciding."
          />
          <Table caption="Shortlisted submissions">
            <thead>
              <tr>
                <Th className="w-12">#</Th>
                <Th>Group</Th>
                <Th>Product</Th>
                <Th className="text-right">Score</Th>
                <Th>Flags</Th>
                <Th><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.entries
                .filter((entry) => entry.entry.inShortlist)
                .map((entry) => (
                  <tr key={entry.submissionId}>
                    <Td className="font-mono">{entry.entry.rank}</Td>
                    <Td className="font-mono">{entry.groupNumber}</Td>
                    <Td>{entry.productName ?? '—'}</Td>
                    <Td className="text-right font-mono font-semibold">
                      {entry.entry.totalScore.toFixed(2)}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {entry.lowConfidence && <Badge tone="warning">low confidence</Badge>}
                        {entry.hasOpenManualReview && <Badge tone="warning">review open</Badge>}
                      </div>
                    </Td>
                    <Td>
                      <Link
                        href={`/admin/submissions/${entry.submissionId}`}
                        className="text-sm font-semibold text-brand underline underline-offset-4"
                      >
                        View evidence
                      </Link>
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
