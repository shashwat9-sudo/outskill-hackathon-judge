import type { Cohort, CohortStatus } from '@ohj/shared';

/**
 * Which cohort an admin page is about.
 *
 * Every cohort-scoped admin page takes `?cohort=<id>`; that is the only
 * routing input (0016, ADR-035). The id is validated against the cohort list
 * on the server before anything is read, and an id that matches nothing is a
 * "not found", never a fallback to some other cohort — a page that silently
 * showed a different cohort than the URL named would invite changes to the
 * wrong one.
 *
 * Without a `?cohort=`, the page still has to show something. The default is
 * the one cohort that is currently judging or open when there is exactly one;
 * otherwise the most recently created non-archived cohort. The page always
 * renders the switcher, so the operator sees which cohort it is and can
 * change it, and every action on the page carries that cohort's id.
 */

export const COHORT_QUERY = 'cohort';

export interface CohortSelection {
  /** The cohort to show, or null when there are no cohorts or the requested one is unknown. */
  cohort: Cohort | null;
  /** All cohorts, newest first, for the switcher. */
  cohorts: Cohort[];
  /** True when the URL named the cohort. */
  explicit: boolean;
  /** The id the URL named that matched nothing. */
  notFound: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function selectAdminCohort(
  cohorts: Cohort[],
  requested: string | string[] | undefined | null,
  prefer: readonly CohortStatus[] = ['judging', 'open'],
): CohortSelection {
  const id = (Array.isArray(requested) ? requested[0] : requested)?.trim() ?? '';
  if (id) {
    const match = UUID.test(id) ? cohorts.find((c) => c.id.toLowerCase() === id.toLowerCase()) : undefined;
    return { cohort: match ?? null, cohorts, explicit: true, notFound: match ? null : id };
  }
  const preferred = cohorts.filter((c) => prefer.includes(c.status));
  if (preferred.length === 1) return { cohort: preferred[0]!, cohorts, explicit: false, notFound: null };
  const live = cohorts.filter((c) => c.status !== 'archived');
  const fallback = live[0] ?? cohorts[0] ?? null;
  return { cohort: fallback, cohorts, explicit: false, notFound: null };
}

/** `/admin/ranking?cohort=<id>` */
export function cohortHref(path: string, cohortId: string | null | undefined): string {
  if (!cohortId) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}${COHORT_QUERY}=${encodeURIComponent(cohortId)}`;
}

/** The `?cohort=` value from a raw query string, or null. */
export function cohortIdFromSearch(search: string | null | undefined): string | null {
  if (!search) return null;
  const value = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(COHORT_QUERY);
  return value && UUID.test(value) ? value.toLowerCase() : null;
}
