import Link from 'next/link';
import { buildSubmissionGuide, formatInTimezone, timezoneLabel } from '@ohj/shared';
import { getStoreAsync } from '@/lib/store';
import { Alert, Card, Wordmark } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The two-day submission guide.
 *
 * Deliberately readable without signing in. A team looking this up at 2am on
 * Day 13 should not have to find their access code first, and there is nothing
 * here worth protecting — it is instructions, not results.
 *
 * The same content generates the PDF at /api/guide, from one source, so the two
 * cannot drift.
 */
export default async function GuidePage() {
  const cohort = await (await getStoreAsync()).cohorts.findActiveCohort();

  const guide = buildSubmissionGuide({
    cohortName: cohort?.name ?? 'AI Accelerator',
    deadlineLabel: cohort
      ? `${formatInTimezone(cohort.acceptingUntil ?? cohort.day13DeadlineAt, cohort.timezone, {
          dateStyle: 'full',
          timeStyle: 'short',
        })} ${timezoneLabel(cohort.day13DeadlineAt, cohort.timezone)}`
      : 'at the end of Day 13',
    submitUrl: '/submit',
  });

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Wordmark subtitle="AI Accelerator" />
          <Link href="/submit" className="text-sm font-semibold text-brand-text underline underline-offset-4">
            Go to the submission form
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-bold text-ink sm:text-4xl">{guide.title}</h1>
        <p className="mt-3 text-base text-muted">{guide.subtitle}</p>

        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href="/api/guide"
            className="inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-brand-edge bg-brand-tint px-4 py-2.5 text-sm font-semibold text-brand-text"
            data-testid="download-guide"
          >
            Download as PDF
          </a>
          <Link
            href="/submit/example"
            className="inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-line bg-surface-soft px-4 py-2.5 text-sm font-semibold text-ink hover:border-brand-edge"
            data-testid="guide-example-link"
          >
            See a completed example
          </Link>
        </div>

        {/* A contents list: this is long, and someone mid-build is looking for
            one section, not reading it through. */}
        <nav aria-label="Sections" className="mt-8 rounded-[10px] border border-line bg-surface-alt p-4">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {guide.sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-brand-text underline underline-offset-4">
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-10 space-y-10">
          {guide.sections.map((section) => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-heading`}>
              <h2 id={`${section.id}-heading`} className="text-xl font-bold text-ink">
                {section.title}
              </h2>
              {section.intro && <p className="mt-2 max-w-prose text-base text-muted">{section.intro}</p>}

              <Card className="mt-4">
                <ol className="space-y-4">
                  {section.items.map((item, index) => (
                    <li key={item.text}>
                      {item.kind === 'warning' ? (
                        <Alert tone="warning">{item.text}</Alert>
                      ) : (
                        <div className="flex gap-3">
                          <span
                            aria-hidden="true"
                            className={
                              item.kind === 'step'
                                ? 'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-brand text-xs font-bold text-brand-text'
                                : 'mt-2.5 h-1 w-1 shrink-0 rounded-full bg-brand'
                            }
                          >
                            {item.kind === 'step' ? stepNumber(section.items, index) : ''}
                          </span>
                          <div className="min-w-0">
                            <p className="text-base text-muted">{item.text}</p>
                            {/* The same worked answer the form offers on that
                                question — one source, so the two cannot say
                                different things. */}
                            {item.example && (
                              <div className="mt-2.5 rounded-[10px] border border-brand-edge bg-brand-tint px-3.5 py-3">
                                <p className="text-xs font-bold uppercase tracking-wider text-brand-text">
                                  Example
                                </p>
                                <p className="mt-1 text-sm font-medium text-ink">
                                  {item.example.question}
                                </p>
                                <p className="mt-1 text-sm text-muted">{item.example.answer}</p>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </Card>
            </section>
          ))}
        </div>
      </main>

      <footer className="mt-12 border-t border-line py-8">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <p className="max-w-prose text-sm text-muted">
            Assessment results are internal to Outskill and are not shared with participants.
          </p>
        </div>
      </footer>
    </div>
  );
}

/** Steps are numbered within their section, ignoring bullets and warnings. */
function stepNumber(items: { kind: string }[], index: number): number {
  return items.slice(0, index + 1).filter((item) => item.kind === 'step').length;
}
