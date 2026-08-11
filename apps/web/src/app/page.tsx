import Link from 'next/link';
import {
  DEMO_SCENARIO_META,
  DEMO_TEAMS,
  demoSubmissionId,
  demoTeamId,
  evaluateDeadline,
  formatInTimezone,
} from '@ohj/shared';
import { getDemoStore, getStore, isDemo } from '@/lib/store';
import { Badge, Card, Wordmark } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Root page.
 *
 * Two completely different pages behind one route:
 *
 *   PRODUCTION — a participant-facing landing page. It reveals no demo
 *   credentials, no synthetic links, no assessment information and no admin
 *   detail. The admin entry is a restrained link, not the main call to action.
 *
 *   DEMO — an internal, clearly-marked exploration surface with the two things
 *   an Outskill operator wants: preview the learner experience, or open the
 *   admin workspace.
 */
export default async function HomePage() {
  return isDemo() ? <DemoHome /> : <ProductionHome />;
}

// --------------------------------------------------------------------------
// Production
// --------------------------------------------------------------------------

function ProductionHome() {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Wordmark subtitle="AI Accelerator" />
          <Link
            href="/admin"
            className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-ink hover:underline"
          >
            Outskill team sign in
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">
          AI Accelerator Hackathon
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] text-ink sm:text-6xl">
          Build it. Prove it. Submit it.
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted">
          Submit your team&apos;s final product, demo and learning evidence for the AI Accelerator
          Hackathon.
        </p>

        <Card tone="raised" className="mt-12 max-w-2xl">
          <h2 className="text-lg font-bold text-ink">Finding your submission</h2>
          <p className="mt-2 text-sm text-muted">
            You will access your submission through the private team link shared by Outskill. There
            is no account to create and no password to remember — the link is your team&apos;s way
            in.
          </p>
          <p className="mt-4 text-sm text-muted">
            Cannot find your link? Ask your team lead first, then contact the Outskill team.
          </p>
        </Card>

        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            ['Six guided steps', 'Team, product, live product, demo and deck, learning evidence, review.'],
            ['Saved as you go', 'Your progress saves automatically until you make your final submission.'],
            ['One final submit', 'Submitting locks your entry and gives you a receipt to keep.'],
          ].map(([title, body]) => (
            <div key={title} className="border-t border-line pt-4">
              <p className="font-semibold text-ink">{title}</p>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t border-line py-8">
        <p className="mx-auto max-w-5xl px-6 text-sm text-muted">
          Outskill AI Accelerator. Assessment results are internal to Outskill.
        </p>
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------
// Demo
// --------------------------------------------------------------------------

async function DemoHome() {
  const store = getStore();
  const demo = getDemoStore();
  const cohort = (await store.cohorts.listCohorts())[0];
  const submissions = cohort ? await store.submissions.listSubmissions(cohort.id) : [];

  // Feature-detected, not `instanceof` — the store survives module reloading
  // and a class-identity check silently emptied this list.
  const scenarios = DEMO_TEAMS.map((team) => {
    const submission = submissions.find((s) => s.team.groupNumber === team.groupNumber);
    return {
      ...team,
      meta: DEMO_SCENARIO_META[team.scenario],
      token: demo?.getDemoInviteToken(demoTeamId(team.groupNumber)) ?? null,
      submissionId: demoSubmissionId(team.groupNumber),
      status: submission?.submission.status ?? 'draft',
    };
  });

  const deadline = cohort ? evaluateDeadline(cohort.day13DeadlineAt) : null;
  // The draft team is the best preview: its form is still editable.
  const previewToken = scenarios.find((s) => s.scenario === 'incomplete')?.token ?? null;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-5">
          <Wordmark subtitle="Hackathon Judge" />
          <Badge tone="warning">Internal demo mode — synthetic data only</Badge>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-6 py-12">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">
          AI Accelerator Hackathon
        </p>
        <h1 className="mt-3 max-w-3xl text-3xl font-bold leading-tight text-ink sm:text-5xl">
          Hackathon Judge
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted">
          Explore both sides of the product. Every team, product and contact detail below is
          synthetic — no real participant data appears anywhere.
        </p>

        {cohort && deadline && (
          <p className="mt-4 text-sm text-muted">
            Demo cohort <span className="text-ink">{cohort.name}</span> · deadline{' '}
            <span className="text-ink">
              {formatInTimezone(cohort.day13DeadlineAt, cohort.timezone, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>{' '}
            · <span className="text-brand">{deadline.remainingLabel} remaining</span>
          </p>
        )}

        {/* The two things an operator actually wants to do. */}
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <Card tone="accent" className="flex flex-col justify-between">
            <div>
              <h2 className="text-xl font-bold text-ink">Preview the learner experience</h2>
              <p className="mt-2 text-sm text-muted">
                Open a team&apos;s private submission link and walk through the six steps exactly as
                a participant would. Learners never see scores, ranking or evidence.
              </p>
            </div>
            <div className="mt-6">
              {previewToken ? (
                <Link
                  href={`/submit/${previewToken}`}
                  className="inline-flex items-center gap-2 rounded-[10px] bg-brand px-6 py-3 text-base font-bold text-black transition-colors hover:bg-brand-hover"
                >
                  Preview learner journey →
                </Link>
              ) : (
                <p className="text-sm text-danger">
                  No demo invite is available — check the fixture seed.
                </p>
              )}
            </div>
          </Card>

          <Card tone="raised" className="flex flex-col justify-between">
            <div>
              <h2 className="text-xl font-bold text-ink">Open the admin workspace</h2>
              <p className="mt-2 text-sm text-muted">
                Run the cohort: configure ideas, invite teams, monitor judging, review evidence and
                choose four finalists.
              </p>
              <p className="mt-3 text-sm text-muted">
                Sign in with <code className="font-mono text-ink">outskill-admin</code> /{' '}
                <code className="font-mono text-ink">demo-admin-password</code>
              </p>
            </div>
            <div className="mt-6">
              <Link
                href="/admin"
                className="inline-flex items-center gap-2 rounded-[10px] border border-line bg-surface-soft px-6 py-3 text-base font-semibold text-ink transition-colors hover:border-brand-edge"
              >
                Open admin workspace →
              </Link>
            </div>
          </Card>
        </div>

        {/* Scenario cards — the six situations an operator needs to recognise. */}
        <section className="mt-14" aria-labelledby="scenarios-heading">
          <h2 id="scenarios-heading" className="text-xl font-bold text-ink">
            Six demo teams, six situations
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-muted">
            Each card opens a real invite link backed by the demo fixtures. Nothing here is
            hard-coded markup.
          </p>

          <ul
            className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3"
            data-testid="demo-scenario-list"
          >
            {scenarios.map((scenario) => (
              <li
                key={scenario.groupNumber}
                data-testid="demo-scenario-card"
                data-scenario={scenario.scenario}
                className="h-full"
              >
                <Card className="flex h-full flex-col" tone="default">
                  <div className="flex h-full flex-col">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-xs text-muted">
                          Group {scenario.groupNumber}
                        </p>
                        <p className="mt-1 font-bold text-ink">{scenario.productName}</p>
                      </div>
                      <Badge tone={scenario.meta.tone}>{scenario.meta.label}</Badge>
                    </div>

                    <p className="mt-3 flex-1 text-sm text-muted">{scenario.meta.summary}</p>

                    <p className="mt-4 text-xs text-muted">
                      Submission status:{' '}
                      <span className="font-semibold text-ink">
                        {scenario.status === 'locked' ? 'Final submission' : 'Draft'}
                      </span>
                    </p>

                    <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                      {scenario.token ? (
                        <Link
                          href={`/submit/${scenario.token}`}
                          className="inline-flex items-center rounded-[10px] bg-brand px-3.5 py-2 text-sm font-bold text-black transition-colors hover:bg-brand-hover"
                        >
                          Open learner portal
                        </Link>
                      ) : (
                        <span className="text-sm text-danger">Invite unavailable</span>
                      )}
                      {scenario.scenario !== 'incomplete' && (
                        <Link
                          href={`/admin/submissions/${scenario.submissionId}`}
                          className="inline-flex items-center rounded-[10px] border border-line bg-surface-soft px-3.5 py-2 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
                        >
                          View in admin
                        </Link>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="mt-8 border-t border-line py-8">
        <p className="mx-auto max-w-6xl px-6 text-sm text-muted">
          Demo mode runs on deterministic fixtures — no database, no AI key and no worker required.
          Assessment results, scores and rankings are never shown to participants.
        </p>
      </footer>
    </div>
  );
}
