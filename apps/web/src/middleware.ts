import { NextResponse, type NextRequest } from 'next/server';

/**
 * Expose the request path to server components.
 *
 * A layout does not receive the params of a nested dynamic segment, so
 * `app/admin/layout.tsx` cannot see the `[id]` in
 * `/admin/cohorts/<id>/ideas`. Without it the shell fell back to "the globally
 * active cohort", which meant an operator managing a paused cohort saw a
 * different, open one named in the header — while editing the first.
 *
 * That is a genuinely dangerous class of bug: every control on the page acts on
 * the cohort in the URL, so a header naming a different one invites changes
 * made to the wrong cohort.
 *
 * This adds no authorisation and no redirect. Pages still call `requireAdmin()`
 * themselves — a middleware is not an authorisation boundary.
 */
export const PATHNAME_HEADER = 'x-ohj-pathname';

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Admin pages only. Nothing on the learner surface needs this, and matching
  // fewer routes keeps the middleware off the participant hot path.
  matcher: ['/admin/:path*'],
};
