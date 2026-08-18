import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A receipt a team can actually download.
 *
 * The participant session cookie is scoped to `path=/submit`, so the browser
 * omits it from anything outside that path. The receipt route lived at
 * `/api/receipt`, which meant it never received a session — every learner who
 * pressed "Download receipt" was told "No receipt is available for this
 * session" while looking at their receipt on screen.
 *
 * It had never worked, for anybody. Found by pressing the button on a real
 * submitted submission.
 */

const SUBMIT = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(SUBMIT, 'receipt/route.ts');
const PORTAL = resolve(SUBMIT, 'portal/page.tsx');
const SESSION = resolve(SUBMIT, '../../../../../packages/shared/src/security/participant-session.ts');

describe('where the receipt route lives', () => {
  it('is inside the path the session cookie is scoped to', async () => {
    // The invariant, stated as a relationship rather than two constants that
    // can drift apart.
    const cookie = await readFile(SESSION, 'utf8');
    const scoped = /path: '([^']+)'/.exec(cookie)?.[1];
    expect(scoped, 'the cookie must declare a path').toBe('/submit');

    const routeUrl = '/submit/receipt';
    expect(routeUrl.startsWith(scoped!)).toBe(true);
  });

  it('exists at that path', async () => {
    const entries = await readdir(resolve(SUBMIT, 'receipt'));
    expect(entries).toContain('route.ts');
  });

  it('no longer exists outside it', async () => {
    const api = await readdir(resolve(SUBMIT, '../api')).catch(() => []);
    expect(api, 'a receipt route under /api can never receive the cookie').not.toContain('receipt');
  });

  it('is what the portal links to', async () => {
    const portal = await readFile(PORTAL, 'utf8');
    expect(portal).toMatch(/href="\/submit\/receipt"/);
    expect(portal).not.toMatch(/href="\/api\/receipt"/);
  });
});

describe('what the route accepts', () => {
  const route = () => readFile(ROUTE, 'utf8');

  it('takes nothing from the request but the cookie', async () => {
    // A submission id in the URL would let one team fetch another's receipt.
    const text = await route();
    expect(text).toMatch(/PARTICIPANT_SESSION_COOKIE/);
    expect(text).not.toMatch(/searchParams|params\./);
  });

  it('refuses without a session', async () => {
    const text = await route();
    expect(text).toMatch(/if \(!token\) return unauthorised\(\)/);
  });

  it('treats an unusable session and a draft identically', async () => {
    // Telling them apart would say whether a given session exists.
    const text = await route();
    expect(text).toMatch(/if \(!receipt\) return unauthorised\(\)/);
    expect(text).toMatch(/Null for an invalid session and for a submission that is still a draft/);
  });

  it('returns 404 rather than 401, and says nothing about why', async () => {
    const text = await route();
    expect(text).toMatch(/status: 404/);
    expect(text).toMatch(/No receipt is available for this session/);
  });
});

describe('the response', () => {
  const route = () => readFile(ROUTE, 'utf8');

  it('downloads rather than opening', async () => {
    const text = await route();
    expect(text).toMatch(/content-disposition['"]?\]?:\s*`attachment/);
  });

  it('is never cached, because it is per-team', async () => {
    expect(await route()).toMatch(/private, no-store/);
  });

  it('is checked for anything it must not carry before the bytes exist', async () => {
    const text = await route();
    expect(text).toMatch(/assertReceiptSafe/);
    const assertIndex = text.indexOf('assertReceiptSafe');
    const generateIndex = text.indexOf('generateReceiptPdf');
    expect(assertIndex, 'the check must precede generation').toBeLessThan(generateIndex);
  });

  it('generates the bytes in process, so no external service sees a team', async () => {
    const text = await route();
    expect(text).toMatch(/generateReceiptPdf/);
    expect(text).not.toMatch(/fetch\(/);
  });
});
