'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { StatusPill, Wordmark, cn } from '@/components/ui';
import { logoutAction } from '@/server/admin-actions';

/**
 * Admin navigation.
 *
 * A left sidebar on desktop, a collapsible drawer on tablet and mobile. Labels
 * are written for programme operators — the underlying routes are unchanged.
 */

interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Matches child routes too, so a submission detail keeps Submissions active. */
  match?: string[];
}

const NAV: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: '◈' },
  { href: '/admin/cohorts', label: 'Cohorts', icon: '▦' },
  { href: '/admin/intake', label: 'Google Sheet intake', icon: '⇩' },
  { href: '/admin/submissions', label: 'Submissions', icon: '▤', match: ['/admin/submissions'] },
  { href: '/admin/assessment-queue', label: 'Judging', icon: '◐' },
  { href: '/admin/ranking', label: 'Shortlist', icon: '★' },
  { href: '/admin/final-selection', label: 'Finalists', icon: '◆' },
  { href: '/admin/resources', label: 'Resources', icon: '❐' },
  { href: '/admin/settings', label: 'Settings', icon: '⚙' },
];

export function AdminNav({
  username,
  cohortName,
  cohortStatus,
  demo,
}: {
  username: string;
  cohortName: string | null;
  cohortStatus: string | null;
  demo: boolean;
}) {
  const pathname = usePathname() ?? '';
  const [open, setOpen] = React.useState(false);

  // Close the drawer whenever navigation lands somewhere new.
  React.useEffect(() => setOpen(false), [pathname]);

  const isActive = (item: NavItem) => {
    if (item.href === '/admin') return pathname === '/admin';
    if (item.match?.some((m) => pathname.startsWith(m))) return true;
    return pathname.startsWith(item.href);
  };

  const links = (
    <ul className="space-y-1">
      {NAV.map((item) => {
        const active = isActive(item);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-brand-tint text-ink ring-1 ring-inset ring-brand-edge'
                  : 'text-muted hover:bg-surface-alt hover:text-ink',
              )}
            >
              <span
                aria-hidden="true"
                className={cn('w-4 text-center text-base', active ? 'text-brand-text' : 'text-muted')}
              >
                {item.icon}
              </span>
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      {/* Mobile / tablet top bar. */}
      <div className="flex items-center justify-between border-b border-line px-4 py-3 lg:hidden">
        <Wordmark size="sm" subtitle="Hackathon Judge" />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="admin-nav-drawer"
          className="rounded-[10px] border border-line px-3 py-2 text-sm font-semibold text-ink"
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {open && (
        <div id="admin-nav-drawer" className="border-b border-line bg-surface px-4 py-4 lg:hidden">
          {cohortName && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">{cohortName}</span>
              {cohortStatus && <StatusPill status={cohortStatus} />}
            </div>
          )}
          <nav aria-label="Admin sections">{links}</nav>
          <form action={logoutAction} className="mt-4 border-t border-line pt-4">
            <p className="mb-2 text-xs text-muted">
              Signed in as <strong className="text-ink">{username}</strong> (shared)
            </p>
            <button
              type="submit"
              className="rounded-[10px] border border-line px-3 py-2 text-sm font-semibold text-ink"
            >
              Sign out
            </button>
          </form>
        </div>
      )}

      {/* Desktop sidebar. */}
      <aside className="hidden w-64 shrink-0 border-r border-line lg:block">
        <div className="sticky top-0 flex h-screen flex-col px-4 py-6">
          <Link href="/admin" className="mb-8 block px-2">
            <Wordmark subtitle="Hackathon Judge" />
          </Link>

          {cohortName && (
            <div className="mb-6 rounded-[10px] border border-line bg-surface p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                Active cohort
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-ink">{cohortName}</p>
              {cohortStatus && (
                <div className="mt-2">
                  <StatusPill status={cohortStatus} />
                </div>
              )}
            </div>
          )}

          <nav aria-label="Admin sections" className="flex-1">
            {links}
          </nav>

          {demo && (
            <div className="mt-4 rounded-[10px] border border-warning/40 bg-warning-tint p-3">
              <p className="text-xs font-semibold text-warning">Demo mode</p>
              <p className="mt-1 text-xs text-muted">Synthetic data only.</p>
              <Link
                href="/"
                className="mt-2 inline-block text-xs font-semibold text-brand-text underline underline-offset-4"
              >
                Preview learner journey
              </Link>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
