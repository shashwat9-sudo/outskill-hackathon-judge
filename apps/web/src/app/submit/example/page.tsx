import type { Metadata } from 'next';
import Link from 'next/link';
import {
  COMPLETED_EXAMPLE,
  DECLARATION_KEYS,
  DECLARATION_TEXT,
  EXAMPLE_BANNER,
  EXAMPLE_BUGS,
  EXAMPLE_PRODUCT_NAME,
  EXAMPLE_TEAM,
  EXAMPLE_TEST_STEPS,
  FIELD_GUIDANCE,
} from '@ohj/shared/client';
import { Card, Wordmark } from '@/components/ui';

export const metadata: Metadata = {
  title: 'A completed example submission',
};

/**
 * One finished submission, so nobody has to imagine what "finished" looks like.
 *
 * Fitness Goal Tracker is invented. Using a real team's entry to teach the next
 * cohort would be showing somebody's work without asking, and it would be out
 * of date the moment that cohort closed.
 *
 * Read-only in the strongest sense available: this page renders no form control
 * at all. Not a disabled input — no input. There is nothing here to type into,
 * nothing to submit, and deliberately no way to copy an answer into the real
 * form. `example-page.test.ts` asserts that, because "read-only" enforced by
 * styling is one careless refactor from being editable.
 *
 * Public, like the guide. A team looking this up at 2am should not have to find
 * their access code first, and there is nothing here worth protecting.
 */
export default function ExamplePage() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Wordmark subtitle="AI Accelerator" />
          <Link
            href="/submit/portal"
            className="text-sm font-semibold text-brand-text underline underline-offset-4"
          >
            Back to your submission
          </Link>
        </div>
      </header>

      {/*
        Pinned. Someone who scrolls three sections in and reads a well-written
        answer needs to still know whose answer it is.
      */}
      <div
        className="sticky top-0 z-20 border-b border-brand-edge bg-brand-tint/95 backdrop-blur"
        data-testid="example-banner"
      >
        <div className="mx-auto max-w-3xl px-4 py-3 sm:px-6">
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-brand-text">
            {EXAMPLE_BANNER.label}
          </p>
          <p className="mt-0.5 text-sm text-ink">{EXAMPLE_BANNER.body}</p>
        </div>
      </div>

      <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-bold text-ink">{EXAMPLE_PRODUCT_NAME}</h1>
        <p className="mt-2.5 text-base text-muted">
          A made-up submission, filled in the way we are asking you to fill in yours. The answers are
          short on purpose — a clear sentence beats a long one.
        </p>

        <div className="mt-8 space-y-6">
          <ExampleSection title="Team" step="team">
            <Answer label="Team lead name" value={EXAMPLE_TEAM.leadName} />
            <Answer label="Team lead email" value={EXAMPLE_TEAM.leadEmail} />
            <div>
              <p className="text-sm font-semibold text-ink">
                {FIELD_GUIDANCE['team.members']!.label}
              </p>
              <ul className="mt-2 space-y-2">
                {EXAMPLE_TEAM.members.map((member) => (
                  <li
                    key={member.fullName}
                    className="rounded-[10px] border border-line bg-canvas px-3.5 py-3"
                  >
                    <p className="text-sm font-semibold text-ink">{member.fullName}</p>
                    <p className="mt-0.5 text-sm text-muted">{member.contribution}</p>
                  </li>
                ))}
              </ul>
            </div>
          </ExampleSection>

          <ExampleSection title="Product idea" step="product">
            {answersFor('product')}
          </ExampleSection>

          <ExampleSection title="Live product" step="live">
            {answersFor('live')}
            <div>
              <p className="text-sm font-semibold text-ink">
                {FIELD_GUIDANCE['live.coreTestSteps']!.label}
              </p>
              <p className="mt-1 text-sm text-muted">
                {FIELD_GUIDANCE['live.coreTestSteps']!.helper}
              </p>
              <ol className="mt-2 space-y-2">
                {EXAMPLE_TEST_STEPS.map((step, index) => (
                  <li
                    key={step.action}
                    className="rounded-[10px] border border-line bg-canvas px-3.5 py-3"
                  >
                    <p className="text-xs font-bold uppercase tracking-wider text-muted">
                      Step {index + 1}
                    </p>
                    <p className="mt-1 text-sm text-ink">{step.action}</p>
                    <p className="mt-1 text-sm text-muted">→ {step.expectedResult}</p>
                  </li>
                ))}
              </ol>
            </div>
          </ExampleSection>

          <ExampleSection title="Demo and deck" step="artifacts">
            {answersFor('artifacts')}
          </ExampleSection>

          <ExampleSection title="Learning evidence" step="learning">
            <div>
              <p className="text-sm font-semibold text-ink">
                {FIELD_GUIDANCE['learning.bugsFixed']!.label}
              </p>
              <ol className="mt-2 space-y-2">
                {EXAMPLE_BUGS.map((bug, index) => (
                  <li
                    key={bug.description}
                    className="rounded-[10px] border border-line bg-canvas px-3.5 py-3"
                  >
                    <p className="text-xs font-bold uppercase tracking-wider text-muted">
                      Bug {index + 1}
                    </p>
                    <p className="mt-1 text-sm text-ink">{bug.description}</p>
                    <p className="mt-1 text-sm text-muted">Fixed: {bug.howFixed}</p>
                  </li>
                ))}
              </ol>
            </div>
            {answersFor('learning')}
          </ExampleSection>

          <ExampleSection title="Review and submit" step="review">
            <p className="text-sm text-muted">
              The last step is a checklist. Every section shows as complete, the seven declarations
              are ticked, and only then does Final Submit unlock.
            </p>
            <div>
              <p className="text-sm font-semibold text-ink">The seven declarations</p>
              <ul className="mt-2 space-y-1.5">
                {DECLARATION_KEYS.map((key) => (
                  <li key={key} className="flex gap-2 text-sm text-muted">
                    <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-line" />
                    {DECLARATION_TEXT[key]}
                  </li>
                ))}
              </ul>
              {/*
                Listed, not ticked. A declaration is a statement someone makes;
                showing seven pre-ticked boxes here would teach exactly the wrong
                thing about what pressing them means.
              */}
              <p className="mt-3 text-sm text-muted">
                You tick these yourself, in your own submission. Nothing is ever ticked for you.
              </p>
            </div>
          </ExampleSection>
        </div>

        <Card tone="accent" className="mt-8">
          <p className="font-bold text-ink">Now write yours</p>
          <p className="mt-1.5 text-sm text-muted">
            Nothing on this page can be copied into your form, and that is deliberate — these answers
            are about a project that does not exist. Yours will be better, because yours is true.
          </p>
          <Link
            href="/submit/portal"
            className="mt-4 inline-flex min-h-11 items-center rounded-[10px] bg-brand px-4 py-2.5 text-sm font-semibold text-on-accent"
          >
            Back to your submission
          </Link>
        </Card>
      </main>

      <footer className="mt-12 border-t border-line py-8">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <p className="max-w-prose text-sm text-muted">
            Fitness Goal Tracker is not a real submission. Assessment results are internal to
            Outskill and are not shared with participants.
          </p>
        </div>
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------

function ExampleSection({
  title,
  step,
  children,
}: {
  title: string;
  step: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`example-${step}`}>
      <Card>
        <h2 id={`example-${step}`} className="text-lg font-bold text-ink">
          {title}
        </h2>
        <div className="mt-5 space-y-5">{children}</div>
      </Card>
    </section>
  );
}

/**
 * A question and its answer.
 *
 * The answer sits in a box shaped like the one the learner will type into, so
 * the page reads as the same form — but it is a paragraph, not a field.
 */
function Answer({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{label}</p>
      <p className="mt-1.5 rounded-[10px] border border-line bg-canvas px-3.5 py-2.5 text-base text-ink">
        {value}
      </p>
    </div>
  );
}

/** The answers for one step, labelled with the same questions the form asks. */
function answersFor(step: string) {
  const section = COMPLETED_EXAMPLE.find((entry) => entry.step === step);
  if (!section) return null;

  return section.answers.map((answer) => (
    <Answer
      key={answer.path}
      label={FIELD_GUIDANCE[answer.path]?.label ?? answer.path}
      value={answer.answer}
    />
  ));
}
