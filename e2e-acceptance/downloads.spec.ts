import { expect, test } from '@playwright/test';
import { signInAs } from './support';

/**
 * The two download paths, against the real acceptance server.
 *
 * Both were found broken by pressing the buttons on real submitted data, and
 * both had never worked:
 *
 *   "Download deck" redirected to a cross-origin signed URL, so the browser
 *   opened a PDF viewer and the operator lost the submission page. View and
 *   Download did the same thing.
 *
 *   "Download receipt" always returned "No receipt is available for this
 *   session", because the route sat outside the path the session cookie is
 *   scoped to and never received it.
 *
 * These tests exercise the real HTTP responses rather than the source, because
 * what went wrong was the response, not the intent.
 */

test.describe.configure({ mode: 'serial' });

test('a learner can download their own receipt', async ({ browser }) => {
  const context = await browser.newContext();
  await signInAs(context, 901, 'Receipt Downloader');

  // Through the context's request API, which shares the browser's cookie jar
  // and therefore honours the `path=/submit` scope that broke this. `page.goto`
  // cannot be used: the response is an attachment, and navigating to one aborts
  // with "Download is starting" — which is itself the behaviour under test.
  const response = await context.request.get('/submit/receipt');

  expect(response.status(), 'the receipt must be reachable from the portal').toBe(200);
  expect(response.headers()['content-type']).toContain('application/pdf');
  expect(response.headers()['content-disposition']).toContain('attachment');
  expect(response.headers()['cache-control']).toContain('no-store');

  const bytes = await response.body();
  expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  expect(bytes.byteLength).toBeGreaterThan(500);

  await context.close();
});

test('pressing the button on the portal actually downloads a file', async ({ browser }) => {
  // The end-to-end behaviour a learner sees: a file arrives, and the page they
  // were on is still there.
  const context = await browser.newContext({ acceptDownloads: true });
  await signInAs(context, 901, 'Receipt Clicker');
  const page = await context.newPage();
  await page.goto('/submit/portal');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /receipt/i }).first().click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(page.url(), 'the portal must still be open').toContain('/submit/portal');

  await context.close();
});

test('the receipt is refused without a session', async ({ browser }) => {
  const context = await browser.newContext();

  const response = await context.request.get('/submit/receipt');
  expect(response.status()).toBe(404);
  expect(await response.text()).toContain('No receipt is available');

  await context.close();
});

test('another team cannot obtain it by asking differently', async ({ browser }) => {
  // 902 has no final submission, so there is no receipt for it — and nothing it
  // can add to the request changes whose receipt it gets, because the route
  // reads only the cookie.
  const context = await browser.newContext();
  await signInAs(context, 902, 'Other Team');

  for (const path of ['/submit/receipt', '/submit/receipt?group=901', '/submit/receipt?id=901']) {
    const response = await context.request.get(path);
    expect(response.status(), path).toBe(404);
  }

  await context.close();
});

test('an unusable session cookie is refused cleanly', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'ohj_team_session', value: 'not-a-real-token', domain: 'localhost', path: '/submit' },
  ]);
  const response = await context.request.get('/submit/receipt');
  expect(response.status()).toBe(404);

  await context.close();
});

test.describe('the admin deck routes', () => {
  // Driven without an admin session, because the operator holds the password.
  // What is provable here is the refusal, which is the security-relevant half.
  test('refuse an unauthenticated caller, and say nothing about the submission', async ({
    browser,
  }) => {
    const context = await browser.newContext();

    const real = await context.request.get(
      '/api/admin/submissions/00000000-0000-4000-8000-000000000000/deck',
    );
    expect(real.status()).toBe(404);
    expect(await real.text()).toBe('Not found');

    await context.close();
  });

  test('refuse a participant session too', async ({ browser }) => {
    // A team holding a valid participant cookie must not reach an admin route.
    const context = await browser.newContext();
    await signInAs(context, 901, 'Curious Learner');

    const response = await context.request.get(
      '/api/admin/submissions/00000000-0000-4000-8000-000000000000/deck?download=1',
    );
    expect(response.status()).toBe(404);

    await context.close();
  });
});
