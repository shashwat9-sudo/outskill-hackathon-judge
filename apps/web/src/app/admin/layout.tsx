import Link from 'next/link';
import { headers } from 'next/headers';
import { getAdminSession } from '@/server/admin-auth';
import { logoutAction } from '@/server/admin-actions';
import { Badge } from '@/components/ui';

/**
 * Admin shell.
 *
 * The login page renders bare; every other admin page gets the navigation
 * chrome. Individual pages still call `requireAdmin()` themselves — a layout is
 * a rendering concern, not an authorisation boundary.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers();
  const pathname = headerList.get('x-invoke-path') ?? headerList.get('x-pathname') ?? '';
  const session = await getAdminSession();

  if (!session) {
    return <div className="min-h-screen bg-surface-alt">{children}</div>;
  }

  return (
    <div className="min-h-screen bg-surface-alt">
      <header className="border-b border-line bg-ink text-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-sm font-bold uppercase tracking-widest text-brand-bright">
              Outskill Judge
            </Link>
            <Badge tone="brand" className="border-surface/30 bg-transparent text-surface">
              Internal
            </Badge>
          </div>
          <form action={logoutAction} className="flex items-center gap-3">
            <span className="text-sm text-surface/70">
              Signed in as <strong className="text-surface">{session.username}</strong> (shared)
            </span>
            <button type="submit" className="text-sm font-semibold text-brand-bright underline">
              Sign out
            </button>
          </form>
        </div>

        <nav aria-label="Admin sections" className="mx-auto max-w-7xl px-6">
          <ul className="flex flex-wrap gap-1 pb-1">
            {NAV.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className="inline-block rounded-t-md px-3 py-2 text-sm font-medium text-surface/80 hover:bg-surface/10 hover:text-surface aria-[current=page]:bg-surface-alt aria-[current=page]:text-ink"
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-7xl px-6 py-8">
        {children}
      </main>

      <footer className="border-t border-line bg-surface py-4 no-print">
        <p className="mx-auto max-w-7xl px-6 text-xs text-muted">
          Everything on these pages is internal. Scores, evidence, ranking and shortlist information
          are never shown to participants. Actions are logged as <code>shared-admin</code> and cannot
          be attributed to an individual.
        </p>
      </footer>
    </div>
  );
}

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/cohorts', label: 'Cohorts' },
  { href: '/admin/assessment-queue', label: 'Queue' },
  { href: '/admin/ranking', label: 'Ranking' },
  { href: '/admin/final-selection', label: 'Final four' },
  { href: '/admin/resources', label: 'Resources' },
  { href: '/admin/settings', label: 'Settings' },
];
