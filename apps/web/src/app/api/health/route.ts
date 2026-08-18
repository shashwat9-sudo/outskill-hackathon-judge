import { getEnvConfig, getStoreAsync } from '@/lib/store';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness.
 *
 * Returns 200 only when the process can actually serve a learner: configuration
 * loaded, and the data store answering. A health check that reports healthy
 * because the process is running would keep a broken instance in the load
 * balancer through an entire deadline hour.
 *
 * Deliberately says almost nothing. It is reachable without authentication, so
 * it carries no version string, no hostname, no environment variable, no
 * database URL and no counts — anything here is public.
 */
export async function GET() {
  const checks: Record<string, 'ok' | 'failed'> = {};

  try {
    getEnvConfig();
    checks.config = 'ok';
  } catch {
    checks.config = 'failed';
  }

  try {
    // A real read, not a ping. The store can be constructed and still be unable
    // to answer, which is the failure worth catching.
    await (await getStoreAsync()).cohorts.findActiveCohort();
    checks.store = 'ok';
  } catch {
    checks.store = 'failed';
  }

  const healthy = Object.values(checks).every((value) => value === 'ok');

  return Response.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    {
      status: healthy ? 200 : 503,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
