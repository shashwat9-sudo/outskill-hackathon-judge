import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import {
  PARTICIPANT_SESSION_COOKIE,
  describeActivity,
  evaluateDeadline,
  formatInTimezone,
  getPublicRubric,
  timezoneLabel,
  type ParticipantView,
} from '@ohj/shared';
import { getStoreAsync } from '@/lib/store';
import { Alert, Badge, Button, Card, Disclosure, Table, Td, Th, Wordmark } from '@/components/ui';
import { endSessionAction } from '@/server/participant-actions';
import { SubmissionForm } from '../_components/submission-form';
import { LocalTime } from '../_components/local-time';
import { LearnerGuidanceProvider } from '../_components/walkthrough';
import { HelpMenu } from '../_components/help-menu';

export const dynamic = 'force-dynamic';

/**
 * The learner portal.
 *
 * Resolves the session cookie to exactly one submission and reads only from
 * `store.participant`, which has no method capable of reaching an assessment
 * table. No score, rank, evidence, shortlist or feedback can appear here even by
 * mistake (ADR-010).
 *
 * Two distinct pages behind one URL: the six-step form while the submission is
 * open, and a dedicated receipt page once it is locked.
 */
export default async function PortalPage() {
  const token = (await cookies()).get(PARTICIPANT_SESSION_COOKIE)?.value;
  if (!token) redirect('/submit');

  const store = await getStoreAsync();
  const view = await store.participant.resolveSession(token);
  // Expired, revoked, and rotated-code sessions all land back at the entry page.
  if (!view) redirect('/submit');

  const resources = await store.participant.listParticipantResources(view.cohort.id);
  const isSubmitted = view.submission.status === 'locked' || view.submission.status === 'submitted';

  const serialisable = JSON.parse(JSON.stringify(view)) as ParticipantView;

  return (
    <div className="min-h-screen bg-canvas">
      <LearnerHeader
        cohortName={view.cohort.name}
        groupNumber={view.team.groupNumber}
        editorName={view.editorName}
        status={isSubmitted ? 'Submitted' : 'Draft'}
      />

      {isSubmitted && view.submission.receiptId ? (
        <ReceiptPage
          receiptId={view.submission.receiptId}
          groupNumber={view.team.groupNumber}
          productName={view.submission.productName}
          submittedAt={view.submission.submittedAt}
          submittedByName={view.submission.submittedByName}
          timezone={view.cohort.timezone}
          reopened={view.submission.status === 'reopened'}
        />
      ) : (
        <LearnerGuidanceProvider cohortId={view.cohort.id} groupNumber={view.team.groupNumber}>
          <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
            <div className="mb-5 sm:mb-8">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-text">
                {view.cohort.name}
              </p>
              <h1 className="mt-1.5 text-2xl font-bold text-ink sm:mt-2 sm:text-4xl">
                Submit your hackathon product
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted sm:mt-3 sm:text-base">
                There are 6 simple steps. Your work saves as you go, and you can come back before the
                deadline.
              </p>
            </div>

            <DeadlinePanel view={view} />

            {!view.canEdit && (
              <Alert
                tone={view.submission.status === 'locked' ? 'info' : 'warning'}
                className="mb-8"
                testId="window-closed-notice"
              >
                {view.windowMessage}
              </Alert>
            )}

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

            <TeamActivity view={view} />

            <SubmissionForm view={serialisable} />

            <HelpAndResources />
          </main>

          {/*
            One way in to help, reachable at every scroll position. It renders
            beside the form rather than inside it so the tour, the step it is
            explaining and the menu itself all share one owner.
          */}
          <HelpMenu
            resources={resources.map(({ id, title, description }) => ({ id, title, description }))}
          />
        </LearnerGuidanceProvider>
      )}

      <footer className="mt-12 border-t border-line py-8">
        {/* The paragraph keeps a reading measure; only its rail is page-wide.
            A single sentence stretched across 1,152px is a line nobody's eye
            can return from. */}
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="max-w-prose text-sm text-muted">
            Assessment results are internal to Outskill and are not shared with participants.
          </p>
        </div>
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------

function LearnerHeader({
  cohortName,
  groupNumber,
  editorName,
  status,
}: {
  cohortName: string;
  groupNumber: number;
  editorName: string;
  status: string;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-6 sm:py-4">
        <Wordmark subtitle="AI Accelerator" />
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden text-sm text-muted sm:inline">{cohortName}</span>
          <Badge tone="neutral">Group {groupNumber}</Badge>
          <Badge tone={status === 'Submitted' ? 'success' : 'accent'}>{status}</Badge>
          <span className="text-sm text-muted" data-testid="editing-as">
            Editing as <span className="font-semibold text-ink">{editorName}</span>
          </span>
          <form action={endSessionAction}>
            <Button type="submit" variant="ghost" size="sm" className="px-2! text-sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}

/** The deadline, in the official timezone and the participant's own. */
function DeadlinePanel({ view }: { view: ParticipantView }) {
  const deadline = evaluateDeadline(view.effectiveDeadline);

  return (
    <Card tone="raised" padding="compact" className="mb-5 sm:mb-8">
      <div className="grid gap-3 sm:grid-cols-3 sm:gap-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            {view.effectiveDeadline.getTime() === view.cohort.day13DeadlineAt.getTime()
              ? 'Official deadline'
              : 'Extended deadline'}
          </p>
          <p className="mt-0.5 text-sm text-ink sm:mt-1.5">
            {formatInTimezone(view.effectiveDeadline, view.cohort.timezone, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}{' '}
            <span className="text-muted">
              {timezoneLabel(view.effectiveDeadline, view.cohort.timezone)}
            </span>
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Your local time
          </p>
          <LocalTime iso={view.effectiveDeadline.toISOString()} />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">
            Time remaining
          </p>
          <p className="mt-0.5 text-sm font-semibold sm:mt-1.5">
            {deadline.hasPassed ? (
              <span className="text-danger">The deadline has passed</span>
            ) : (
              <span className="text-brand-text">{deadline.remainingLabel}</span>
            )}
          </p>
        </div>
      </div>
      {view.cohort.submissionInstructions && (
        <p className="mt-4 max-w-prose border-t border-line pt-4 text-sm text-muted sm:mt-5 sm:pt-5">
          {view.cohort.submissionInstructions}
        </p>
      )}
    </Card>
  );
}

/**
 * What teammates have been doing.
 *
 * Several people hold the same access code, so someone opening the portal needs
 * to know whether a teammate is already halfway through. The entries are a
 * closed learner-safe set — nothing from the internal audit log appears here.
 */
function TeamActivity({ view }: { view: ParticipantView }) {
  if (view.recentActivity.length === 0) return null;

  return (
    <Card padding="compact" className="mb-5 sm:mb-8" testId="team-activity">
      <h2 className="text-sm font-bold uppercase tracking-wider text-muted">Your team&rsquo;s recent activity</h2>
      <ul className="mt-3 space-y-1.5 text-sm text-muted">
        {view.recentActivity.slice(0, 3).map((entry) => (
          <li key={entry.id} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand" />
            {describeActivity({
              kind: entry.kind,
              editorName: entry.editorName,
              section: entry.section,
              at: new Date(entry.createdAt),
            })}
          </li>
        ))}
      </ul>
    </Card>
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
  submittedByName,
  timezone,
  reopened,
}: {
  receiptId: string;
  groupNumber: number;
  productName: string | null;
  submittedAt: Date | null;
  submittedByName: string | null;
  timezone: string;
  reopened: boolean;
}) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-16 sm:px-6" data-testid="submission-receipt">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-brand text-xl font-bold text-on-accent"
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

          <dt className="text-sm font-semibold text-muted">Submitted by</dt>
          <dd className="text-sm text-ink">{submittedByName ?? '—'}</dd>

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
          <dd className="font-mono text-base font-bold text-brand-text">{receiptId}</dd>
        </dl>

        <div className="mt-6 border-t border-line pt-5">
          <a
            href="/submit/receipt"
            className="inline-flex items-center gap-2 rounded-[10px] border border-brand-edge bg-brand-tint px-4 py-2 text-sm font-semibold text-brand-text"
            data-testid="download-receipt"
          >
            Download receipt (PDF)
          </a>
          <p className="mt-2 text-xs text-muted">
            The PDF contains the same details. It carries no access code and no login.
          </p>
        </div>
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
          <p className="mt-3 text-sm text-brand-text">
            This submission has been reopened. Reload the page to continue editing.
          </p>
        )}
      </Card>
    </main>
  );
}

function HelpAndResources() {
  const rubric = getPublicRubric();

  return (
    <section className="mt-10 space-y-4" aria-labelledby="help-heading">
      <h2 id="help-heading" className="text-lg font-bold text-ink">
        Help and resources
      </h2>

      {/*
        Two links and the rubric. Everything else a learner might want — the
        checklist, the tour, the per-step help, the resource downloads — lives
        behind the one "Need help?" button, because help scattered across a page
        is help nobody can find twice.
      */}
      <Card>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <div>
            <a
              href="/submit/guide"
              className="font-semibold text-brand-text underline underline-offset-4"
              data-testid="guide-link"
            >
              Hackathon Submission Guide
            </a>
            <p className="mt-1 text-sm text-muted">
              The six steps, with examples. Also available as a PDF.
            </p>
          </div>
          <div>
            <a
              href="/submit/example"
              className="font-semibold text-brand-text underline underline-offset-4"
              data-testid="example-link"
            >
              See a completed example
            </a>
            <p className="mt-1 text-sm text-muted">
              One finished submission, so you can see what we are asking for.
            </p>
          </div>
        </div>
      </Card>

      {/* Public rubric only: categories and weights. No scoring guidance. */}
      <Disclosure summary="How submissions are assessed">
        <p className="mb-4 max-w-prose text-sm text-muted">
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
                  <p className="mt-0.5 max-w-prose text-muted">{category.description}</p>
                </Td>
                <Td className="text-right font-mono font-semibold">{category.maxPoints}</Td>
              </tr>
            ))}
            <tr>
              <Td className="font-bold">Total</Td>
              <Td className="text-right font-mono font-bold text-brand-text">100</Td>
            </tr>
          </tbody>
        </Table>
      </Disclosure>
    </section>
  );
}
