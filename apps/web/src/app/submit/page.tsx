import { cookies } from 'next/headers';
import {
  PARTICIPANT_SESSION_COOKIE,
  computeSubmissionWindow,
  evaluateDeadline,
  formatInTimezone,
  timezoneLabel,
} from '@ohj/shared';
import { getDemoStore, getStoreAsync, isDemo } from '@/lib/store';
import { Alert, Card, Wordmark } from '@/components/ui';
import { TeamEntry } from './team-entry';
import { endSessionAction } from '@/server/participant-actions';

export const dynamic = 'force-dynamic';

/**
 * The one URL every learner uses.
 *
 * This is the address Outskill posts in Circle. It is deliberately a single
 * common link with no team identifier in it: a per-team URL would be forwarded,
 * screenshotted and pasted into group chats, and the first team to do so would
 * hand its submission to everyone reading.
 *
 * There is no Circle integration here and there should never be one — the URL is
 * placed in Circle by hand, and this page knows nothing about where a learner
 * came from.
 */
export default async function SubmitEntryPage() {
  const jar = await cookies();

  /**
   * Already signed in on this device.
   *
   * This used to redirect straight to the portal. That silently overrode
   * whatever the person in front of the screen was trying to do: entering a
   * different group number simply dropped them back into the team already
   * signed in, with no indication that their input had been ignored.
   *
   * On a shared laptop — which is normal at an in-person hackathon — that puts
   * one team inside another team's submission with edit rights. It also made
   * the entry form untestable, because there was no way to reach it.
   *
   * So the session is now named and offered, not assumed.
   */
  const sessionToken = jar.get(PARTICIPANT_SESSION_COOKIE)?.value;
  const activeSession = sessionToken
    ? await (await getStoreAsync()).participant.resolveSession(sessionToken)
    : null;

  const cohort = await (await getStoreAsync()).cohorts.findActiveCohort();

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center px-4 py-4 sm:px-6">
          <Wordmark subtitle="AI Accelerator" />
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-text">
          {cohort?.name ?? 'AI Accelerator'}
        </p>
        <h1 className="mt-2 text-3xl font-bold text-ink sm:text-4xl">
          Hackathon submission
        </h1>
        <p className="mt-3 max-w-prose text-base text-muted">
          Everything your team submits for the Day 12–13 hackathon goes in here. You can save as you
          go and come back as often as you like before the deadline.
        </p>

        {activeSession ? (
          <Alert tone="info" className="mt-6" testId="existing-session">
            <p className="font-semibold">
              This device is already signed in as Group {activeSession.team.groupNumber}
              {activeSession.editorName ? `, as ${activeSession.editorName}` : ''}.
            </p>
            <p className="mt-2">
              <a href="/submit/portal" className="text-brand-text underline">
                Continue to Group {activeSession.team.groupNumber}&rsquo;s submission
              </a>
            </p>
            <form action={endSessionAction} className="mt-2">
              <button type="submit" className="text-brand-text underline">
                Sign out to use a different group
              </button>
            </form>
            <p className="mt-2 text-sm">
              If this is not your team, sign out first. Entering a different group number below
              will not change who you are signed in as.
            </p>
          </Alert>
        ) : null}

        {cohort ? <WindowNotice cohort={cohort} /> : null}

        <TeamEntry demoHint={await demoHint()} />

        <section className="mt-10" aria-labelledby="entry-help">
          <h2 id="entry-help" className="text-lg font-bold text-ink">
            Before you start
          </h2>
          <Card className="mt-3">
            <ul className="space-y-3 text-sm text-muted">
              {[
                'Have your live product URL ready, working, and reachable from outside your machine.',
                'Export your pitch deck as a PDF.',
                'Have your demo video link ready, set so anyone with the link can view it.',
                'If your product needs a login, create a demo account for the judges — never use a real one.',
              ].map((item) => (
                <li key={item} className="flex gap-3">
                  <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-line pt-4 text-sm">
              <a
                href="/submit/guide"
                className="font-semibold text-brand-text underline underline-offset-4"
                data-testid="guide-link"
              >
                Read the two-day submission guide
              </a>{' '}
              <span className="text-muted">— what to build, what to prepare, and how to submit.</span>
            </p>
          </Card>
        </section>
      </main>

      <footer className="mt-12 border-t border-line py-8">
        <p className="mx-auto max-w-3xl px-4 text-sm text-muted sm:px-6">
          Assessment results are internal to Outskill and are not shared with participants.
        </p>
      </footer>
    </div>
  );
}

/**
 * The state of the window, said plainly, before anyone types a code.
 *
 * A team that arrives after closing should learn that here rather than after
 * filling in a form.
 */
function WindowNotice({
  cohort,
}: {
  cohort: {
    status: Parameters<typeof computeSubmissionWindow>[0]['status'];
    day12StartAt: Date;
    day13DeadlineAt: Date;
    acceptingUntil: Date | null;
    timezone: string;
  };
}) {
  const window = computeSubmissionWindow(cohort);
  const deadline = evaluateDeadline(window.effectiveDeadline);

  if (window.state === 'open') {
    return (
      <Alert tone="accent" className="mt-6" testId="window-notice">
        <p className="font-semibold">
          Submissions close{' '}
          {formatInTimezone(window.effectiveDeadline, cohort.timezone, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}{' '}
          {timezoneLabel(window.effectiveDeadline, cohort.timezone)}
        </p>
        <p className="mt-1">{deadline.remainingLabel} remaining.</p>
      </Alert>
    );
  }

  return (
    <Alert tone={window.state === 'paused' ? 'warning' : 'info'} className="mt-6" testId="window-notice">
      <p className="font-semibold">{window.message}</p>
      <p className="mt-1">
        You can still sign in to see what your team submitted.
      </p>
    </Alert>
  );
}

/**
 * Demo-only convenience.
 *
 * Real access codes are never retrievable — only their Argon2id hashes are
 * stored. This hint exists solely so the demo fixture is explorable, and it is
 * gated on DEMO_MODE at the source, not in the markup.
 */
async function demoHint(): Promise<string | undefined> {
  if (!isDemo()) return undefined;
  const demo = getDemoStore();
  if (!demo) return undefined;
  await demo.whenReady();
  // Group 27 is the fixture's draft team, so the demo lands on an editable form
  // rather than a receipt. Group 12 has already submitted.
  return `Demo mode: try group 27 with access code ${demo.getDemoAccessCode(27)}. Real cohorts use codes that are never displayed anywhere.`;
}
