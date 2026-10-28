import Link from 'next/link';
import type { Cohort } from '@ohj/shared';
import { cohortHref } from '@/lib/admin-cohort';
import { StatusPill, cn } from '@/components/ui';

/**
 * The cohort this page is about, and the others it could be about.
 *
 * Plain links, one per cohort, carrying `?cohort=<id>` for the current path.
 * Nothing on the server changes when the selection changes: the page re-reads
 * for the cohort in the URL, and every form on it carries that cohort's id.
 * Archived cohorts are offered only when one is already selected.
 */
export function CohortSwitcher({
  path,
  cohorts,
  selectedId,
  explicit,
}: {
  path: string;
  cohorts: Cohort[];
  selectedId: string | null;
  explicit: boolean;
}) {
  const offered = cohorts.filter((c) => c.status !== 'archived' || c.id === selectedId);
  if (offered.length === 0) return null;
  const selected = offered.find((c) => c.id === selectedId) ?? null;

  return (
    <nav aria-label="Cohort" className="mb-6 rounded-[12px] border border-line bg-canvas p-3" data-testid="cohort-switcher">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="text-muted">Managing cohort</span>
        <span className="font-semibold text-ink" data-testid="cohort-switcher-current">
          {selected ? selected.name : 'None selected'}
        </span>
        {selected && !explicit && offered.length > 1 && (
          <span className="text-muted">(default — choose another below if this is not the one you mean)</span>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {offered.map((cohort) => {
          const current = cohort.id === selectedId;
          return (
            <li key={cohort.id}>
              <Link
                href={cohortHref(path, cohort.id)}
                aria-current={current ? 'page' : undefined}
                data-testid={`cohort-switch-${cohort.code.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors',
                  current
                    ? 'border-brand bg-brand/10 font-semibold text-ink'
                    : 'border-line text-muted hover:border-brand-edge hover:text-ink',
                )}
              >
                <span>{cohort.name}</span>
                <StatusPill status={cohort.status} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
