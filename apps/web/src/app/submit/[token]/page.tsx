import { notFound } from 'next/navigation';
import {
  evaluateDeadline,
  formatInTimezone,
  getPublicRubric,
  timezoneLabel,
} from '@ohj/shared';
import { getStore } from '@/lib/store';
import { Badge, Card, Disclosure, Table, Td, Th, Wordmark } from '@/components/ui';
import { SubmissionForm } from './submission-form';
import { LocalTime } from './local-time';

export const dynamic = 'force-dynamic';

/**
 * The learner portal.
 *
 * This route resolves an invite token to exactly one submission and reads only
 * from `store.participant`, which has no method capable of reaching an
 * assessment table. No score, rank, evidence, shortlist or feedback can appear
 * here even by mistake (ADR-010).
 *
 * Two distinct pages behind one URL: the six-step form while the submission is
 * open, and a dedicated receipt page once it is locked.
 */
export default async function SubmitPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const store = getStore();
  const view = await store.participant.resolveInvite(token);

  // Unknown, revoked and expired tokens are indistinguishable from here.
  if (!view) notFound();

  const resources = await store.participant.listParticipantResources(view.cohort.id);
  const deadline = evaluateDeadline(view.cohort.day13DeadlineAt);
  const isSubmitted = view.submission.status === 'locked' || view.submission.status === 'submitted';

  const serialisable = JSON.parse(JSON.stringify(view));

  return (
    <div className="min-h-screen bg-canvas">
      <LearnerHeader
        cohortName={view.cohort.name}
        groupNumber={view.team.groupNumber}
        status={isSubmitted ? 'Submitted' : 'Draft'}
      />

      {isSubmitted && view.submission.receiptId ? (
        <ReceiptPage
          receiptId={view.submission.receiptId}
          groupNumber={view.team.groupNumber}
          productName={view.submission.productName}
          submittedAt={view.submission.submittedAt}
          timezone={view.cohort.timezone}
          reopened={view.submission.status === 'reopened'}
        />
      ) : (
        <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <div className="mb-8">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">
              {view.cohort.name}
            </p>
            <h1 className="mt-2 text-3xl font-bold text-ink sm:text-4xl">
              Submit your hackathon product
            </h1>
            <p className="mt-3 max-w-2xl text-base text-muted">
              Complete the six steps below. Your progress is saved automatically until you make your
              final submission.
            </p>
          </div>

          {/* Deadline, in the official timezone and the participant's own. */}
          <Card tone="raised" className="mb-8">
            <div className="grid gap-5 sm:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Official deadline
                </p>
                <p className="mt-1.5 text-sm text-ink">
                  {formatInTimezone(view.cohort.day13DeadlineAt, view.cohort.timezone, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}{' '}
                  <span className="text-muted">
                    {timezoneLabel(view.cohort.day13DeadlineAt, view.cohort.timezone)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Your local time
                </p>
                <LocalTime iso={view.cohort.day13DeadlineAt.toISOString()} />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                  Time remaining
                </p>
                <p className="mt-1.5 text-sm font-semibold">
                  {deadline.hasPassed ? (
                    <span className="text-danger">The deadline has passed</span>
                  ) : (
                    <span className="text-brand">{deadline.remainingLabel}</span>
                  )}
                </p>
              </div>
            </div>
            {view.cohort.submissionInstructions && (
              <p className="mt-5 max-w-prose border-t border-line pt-5 text-sm text-muted">
                {view.cohort.submissionInstructions}
              </p>
            )}
          </Card>

          {view.submission.status === 'reopened' && (
            <Card tone="accent" className="mb-8">
              <p className="font-bold text-ink">Your submission was reopened</p>
              <p className="mt-1 text-sm text-muted">
                The Outskill team reopened your submission so you can make a change.
                {view.submission.reopenedReason && <> Reason: {view.submission.reopenedReason}</>}{' '}
                Press Final Submit again when you are done.
              </p>
            </Card>
          )}

          <SubmissionForm token={token} view={serialisable} />

          <HelpAndResources resources={resources} />
        </main>
      )}

      <footer className="mt-12 border-t border-line py-8">
        <p className="mx-auto max-w-6xl px-6 text-sm text-muted">
          Assessment results are internal to Outskill and are not shared with participants.
        </p>
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------

function LearnerHeader({
  cohortName,
  groupNumber,
  status,
}: {
  cohortName: string;
  groupNumber: number;
  status: string;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Wordmark subtitle="AI Accelerator" />
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden text-sm text-muted sm:inline">{cohortName}</span>
          <Badge tone="neutral">Group {groupNumber}</Badge>
          <Badge tone={status === 'Submitted' ? 'success' : 'accent'}>{status}</Badge>
        </div>
      </div>
    </header>
  );
}

/**
 * Receipt.
 *
 * A deliberately quiet, complete page. It shows what was received and what
 * happens next — and no judging information of any kind.
 */
function ReceiptPage({
  receiptId,
  groupNumber,
  productName,
  submittedAt,
  timezone,
  reopened,
}: {
  receiptId: string;
  groupNumber: number;
  productName: string | null;
  submittedAt: Date | null;
  timezone: string;
  reopened: boolean;
}) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-16 sm:px-6" data-testid="submission-receipt">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-xl font-bold text-black"
        >
          ✓
        </span>
        <h1 className="text-3xl font-bold text-ink">Submission received</h1>
      </div>

      <p className="mt-4 text-base text-muted">
        Your entry is in. Keep the receipt below — it identifies your submission if you need to
        contact the Outskill team.
      </p>

      <Card tone="raised" className="mt-8">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-[10rem_1fr]">
          <dt className="text-sm font-semibold text-muted">Team</dt>
          <dd className="text-sm text-ink">Group {groupNumber}</dd>

          <dt className="text-sm font-semibold text-muted">Product</dt>
          <dd className="text-sm text-ink">{productName ?? '—'}</dd>

          <dt className="text-sm font-semibold text-muted">Submitted</dt>
          <dd className="text-sm text-ink">
            {submittedAt
              ? formatInTimezone(new Date(submittedAt), timezone, {
                  dateStyle: 'full',
                  timeStyle: 'short',
                })
              : '—'}
          </dd>

          <dt className="text-sm font-semibold text-muted">Receipt ID</dt>
          <dd className="font-mono text-base font-bold text-brand">{receiptId}</dd>
        </dl>
      </Card>

      <Card className="mt-6">
        <h2 className="text-lg font-bold text-ink">What happens next</h2>
        <ol className="mt-4 space-y-3 text-sm text-muted">
          {[
            'The Outskill team reviews every submission after the deadline.',
            'Your live product is checked against the test steps you provided.',
            'Outskill will be in touch about outcomes through the usual programme channels.',
          ].map((step, index) => (
            <li key={step} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-xs font-bold text-muted"
              >
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </Card>

      <Card className="mt-6">
        <h2 className="text-lg font-bold text-ink">Need to change something?</h2>
        <p className="mt-2 text-sm text-muted">
          Your submission is locked and cannot be edited. If something is genuinely wrong, contact
          the Outskill team — they can reopen it for you, and you will see it become editable here
          again.
        </p>
        {reopened && (
          <p className="mt-3 text-sm text-brand">
            This submission has been reopened. Reload the page to continue editing.
          </p>
        )}
      </Card>
    </main>
  );
}

function HelpAndResources({
  resources,
}: {
  resources: { id: string; title: string; description: string; byteSize: number }[];
}) {
  const rubric = getPublicRubric();

  return (
    <section className="mt-10 space-y-4" aria-labelledby="help-heading">
      <h2 id="help-heading" className="text-lg font-bold text-ink">
        Help and resources
      </h2>

      {resources.length > 0 && (
        <Card>
          <ul className="space-y-3">
            {resources.map((resource) => (
              <li key={resource.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <a
                    href={`/api/resources/${resource.id}`}
                    className="font-semibold text-brand underline underline-offset-4"
                  >
                    {resource.title}
                  </a>
                  <p className="text-sm text-muted">{resource.description}</p>
                </div>
                <span className="font-mono text-xs text-muted">
                  {(resource.byteSize / 1024 / 1024).toFixed(1)} MB
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Public rubric only: categories and weights. No scoring guidance. */}
      <Disclosure summary="How submissions are assessed">
        <p className="mb-4 text-sm text-muted">
          Every submission is assessed against the same 100-point rubric. Results are internal to
          Outskill and are not shared with participants.
        </p>
        <Table caption="Scoring rubric categories and weights">
          <thead>
            <tr>
              <Th>Category</Th>
              <Th className="w-20 text-right">Points</Th>
            </tr>
          </thead>
          <tbody>
            {rubric.map((category) => (
              <tr key={category.key}>
                <Td>
                  <p className="font-semibold text-ink">{category.title}</p>
                  <p className="mt-0.5 text-muted">{category.description}</p>
                </Td>
                <Td className="text-right font-mono font-semibold">{category.maxPoints}</Td>
              </tr>
            ))}
            <tr>
              <Td className="font-bold">Total</Td>
              <Td className="text-right font-mono font-bold text-brand">100</Td>
            </tr>
          </tbody>
        </Table>
      </Disclosure>
    </section>
  );
}
