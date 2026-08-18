import { request } from '@playwright/test';

/**
 * Warm the routes before the suite runs.
 *
 * The acceptance server is `next dev`, which compiles a route on its first
 * request. That first hit can take tens of seconds, and a test that happens to
 * be the first to touch `/submit/portal` fails on a timeout that has nothing to
 * do with what it was checking — which is exactly what happened to the code
 * rotation test, twice, for different reasons each time.
 */
export default async function globalSetup(): Promise<void> {
  const baseURL = process.env.ACCEPTANCE_BASE_URL ?? 'http://localhost:3000';
  const context = await request.newContext({ baseURL });

  for (const path of ['/api/health', '/submit', '/submit/portal', '/submit/receipt', '/admin/login']) {
    // Status is irrelevant — a 404 or a redirect still compiles the route.
    await context.get(path, { timeout: 120_000 }).catch(() => undefined);
  }

  await context.dispose();
}
