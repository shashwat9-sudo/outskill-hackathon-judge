import Link from 'next/link';
import { getAdminSession } from '@/server/admin-auth';
import { logoutAction } from '@/server/admin-actions';
import { getStore, isDemo } from '@/lib/store';
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

  const cohorts = await getStore().cohorts.listCohorts();
  const activeCohort = cohorts.find((c) => c.status === 'judging' || c.status === 'open') ?? cohorts[0];

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
        className="sr-only focus:not-sr-only focus:fixed focus:bottom-4 focus:left-4 focus:z-50 focus:rounded focus:bg-brand focus:px-3 focus:py-2 focus:font-bold focus:text-black"
      >
        Back to home
      </Link>
    </div>
  );
}
