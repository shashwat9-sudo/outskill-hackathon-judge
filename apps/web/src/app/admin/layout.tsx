import Link from 'next/link';
import { headers } from 'next/headers';
import { getAdminSession } from '@/server/admin-auth';
import { logoutAction } from '@/server/admin-actions';
import { getStoreAsync, isDemo } from '@/lib/store';
import { cohortIdFromPath } from '@/lib/cohort-context';
import { PATHNAME_HEADER } from '@/middleware';
import { StatusPill } from '@/components/ui';
import { AdminNav } from './admin-nav';

/**
 * Admin shell.
 *
 * The login page renders bare; every other admin page gets the sidebar. Pages
 * still call `requireAdmin()` themselves — a layout is a rendering concern, not
 * an authorisation boundary.
 *
 * Navigation is labelled for programme operators: "Judging" rather than
 * "Queue", "Shortlist" rather than "Ranking", "Finalists" rather than
 * "Final four". Routes are unchanged.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();

  if (!session) {
    return <div className="min-h-screen bg-canvas">{children}</div>;
  }

  const cohorts = await (await getStoreAsync()).cohorts.listCohorts();

  // A cohort-scoped route names the cohort it is about. Falling back to "the
  // globally active cohort" there would put one cohort's name above another
  // cohort's controls — and every control on the page acts on the one in the
  // URL, so the header would be inviting changes to the wrong cohort.
  const scopedId = cohortIdFromPath((await headers()).get(PATHNAME_HEADER));
  const scopedCohort = scopedId ? cohorts.find((c) => c.id === scopedId) : undefined;

  // Only pages that are not about one particular cohort fall back — the
  // overview, the cohort list, settings. There is no specific cohort there to
  // be wrong about.
  const activeCohort =
    scopedCohort ??
    (scopedId
      ? undefined
      : (cohorts.find((c) => c.status === 'judging' || c.status === 'open') ?? cohorts[0]));

  return (
    <div className="min-h-screen bg-canvas lg:flex">
      <AdminNav
        username={session.username}
        cohortName={activeCohort?.name ?? null}
        cohortStatus={activeCohort?.status ?? null}
        demo={isDemo()}
      />

      <div className="min-w-0 flex-1">
        {/* Desktop header strip: cohort context and sign-out. */}
        <header className="hidden border-b border-line px-8 py-4 lg:block">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {activeCohort ? (
                <>
                  <span className="text-sm text-muted">Cohort</span>
                  <span className="font-semibold text-ink">{activeCohort.name}</span>
                  <StatusPill status={activeCohort.status} />
                </>
              ) : (
                <span className="text-sm text-muted">No cohort yet</span>
              )}
            </div>
            <form action={logoutAction} className="flex items-center gap-3">
              <span className="text-sm text-muted">
                Signed in as <strong className="text-ink">{session.username}</strong> (shared)
              </span>
              <button
                type="submit"
                className="rounded-[10px] border border-line px-3 py-1.5 text-sm font-semibold text-ink transition-colors hover:border-brand-edge"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          {children}
        </main>

        <footer className="border-t border-line px-4 py-6 no-print sm:px-6 lg:px-8">
          <p className="mx-auto max-w-6xl text-xs text-muted">
            Everything on these pages is internal. Scores, evidence, ranking and shortlist
            information are never shown to participants. Actions are logged as{' '}
            <code className="font-mono">shared-admin</code> and cannot be attributed to an
            individual.
          </p>
        </footer>
      </div>

      <Link
        href="/"
        className="sr-only focus:not-sr-only focus:fixed focus:bottom-4 focus:left-4 focus:z-50 focus:rounded focus:bg-brand focus:px-3 focus:py-2 focus:font-bold focus:text-on-accent"
      >
        Back to home
      </Link>
    </div>
  );
}
