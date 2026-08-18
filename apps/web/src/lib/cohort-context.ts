/**
 * Which cohort is an admin page actually about?
 *
 * Cohort-scoped routes look like `/admin/cohorts/<id>/ideas`. The shell needs
 * that id to name the right cohort in its header, and a layout cannot read the
 * params of a nested dynamic segment — so the path comes through a header set
 * by middleware.
 *
 * Kept as a pure function of the pathname — no `server-only` marker, no request
 * access — so it can be tested directly. That is the whole point: the failure it
 * prevents is a header that confidently names the wrong cohort, and a guard that
 * cannot be tested is a guard nobody trusts.
 */

/** Matches `/admin/cohorts/<uuid>` and anything below it. */
const COHORT_ROUTE = /^\/admin\/cohorts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/**
 * The cohort id this path is scoped to, or null.
 *
 * Null means "this page is not about one particular cohort" — the overview, the
 * cohort list, settings. Those may fall back to the active cohort, because
 * there is no specific one to be wrong about.
 */
export function cohortIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = COHORT_ROUTE.exec(pathname);
  return match ? (match[1] as string).toLowerCase() : null;
}

/** True when the path names a specific cohort. */
export function isCohortScopedPath(pathname: string | null | undefined): boolean {
  return cohortIdFromPath(pathname) !== null;
}
