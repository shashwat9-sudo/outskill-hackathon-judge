import Link from 'next/link';
import { JUDGING_UNAVAILABLE_MESSAGE, ordinalPosition, storeCapabilities } from '@ohj/shared';
import { getStoreAsync } from '@/lib/store';
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
 * Final selection.
 *
 * The only page in the product that records a winner, and the only writer to
 * `final_selections` (ADR-018). The slots start empty and stay empty until a
 * person fills them — nothing pre-populates them, by design.
 *
 * How many slots there are is the cohort's own setting
 * (`finalSelectionTarget`): three for AIAP C14, four for the cohorts recorded
 * before it. The page renders that number and says so in words; it never
 * assumes "four".
 */
export default async function FinalistsPage() {
  const session = await requireAdmin();
  const store = await getStoreAsync();

  // Judging is not available in this deployment (Phase B). Every read below
  // reaches a gated repository, which throws rather than returning an empty
  // result that would render as a real answer.
  if (!storeCapabilities(store).ranking) {
    return (
      <div>
        <PageHeading title="Final selection" description="The winners, chosen by a person." />
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
  const cohort =
    cohorts.find((c) => c.status === 'judging' || c.status === 'finalised') ?? cohorts[0];

  if (!cohort) return <EmptyState title="No cohorts yet" />;

  const [snapshot, selections] = await Promise.all([
    store.ranking.getCurrentSnapshot(cohort.id),
    store.ranking.listFinalSelections(cohort.id),
  ]);

  const target = cohort.finalSelectionTarget;
  const positions = Array.from({ length: target }, (_, index) => index + 1);
  const candidates = snapshot?.entries ?? [];
  const complete = selections.length === target;

  return (
    <div>
      <PageHeading
        title="Final selection"
        description={`Select exactly ${target} winner${target === 1 ? '' : 's'} for ${cohort.name}. The automated judge provides evidence and a private shortlist. The Outskill team makes the final decision.`}
        actions={
          <span data-testid="final-selection-count">
            <Badge tone={complete ? 'success' : 'neutral'}>
              {selections.length} of {target} selected
            </Badge>
          </span>
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
          description="Generate a private shortlist before choosing winners."
          action={
            <Link
              href="/admin/ranking"
              className="rounded-[10px] bg-brand px-4 py-2.5 text-sm font-bold text-on-accent"
            >
              Go to shortlist
            </Link>
          }
        />
      ) : (
        <Card className="mb-8">
          <CardHeader
            title={`${target} winner position${target === 1 ? '' : 's'}`}
            description={`Choose a submission for each position, ${positions.map(ordinalPosition).join(', ')}. All ${target} are required — a partial selection is refused.`}
          />

          <AdminForm
            action={setFinalSelectionAction}
            csrfToken={session.csrfToken}
            submitLabel="Confirm final selection"
            confirm={`Record these ${target} winner${target === 1 ? '' : 's'}? This is logged, and nothing is announced automatically.`}
          >
            <input type="hidden" name="cohortId" value={cohort.id} />

            <div className="space-y-4" data-testid="finalist-slots" data-target={target}>
              {positions.map((position) => {
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
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-brand text-sm font-bold text-brand-text"
                      >
                        {position}
                      </span>
                      <h3 className="font-bold text-ink">{ordinalPosition(position)} place</h3>
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
                        className="mt-3 inline-block text-sm font-semibold text-brand-text underline underline-offset-4"
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
          <Table caption="Selected winners">
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
                  <Td className="font-mono font-bold">{ordinalPosition(selection.position)}</Td>
                  <Td className="font-mono">
                    <Link
                      href={`/admin/submissions/${selection.submissionId}`}
                      className="text-brand-text underline underline-offset-4"
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
              confirm="Clear the recorded winners? This is logged."
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
            description="Open any submission to read the evidence behind its score before deciding. Winners may be chosen from anywhere in the current ranking, not only the shortlist."
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
                        className="text-sm font-semibold text-brand-text underline underline-offset-4"
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
