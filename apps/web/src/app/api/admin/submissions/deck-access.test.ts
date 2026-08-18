import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Who may open a team's pitch deck.
 *
 * A deck is a learner's work, sitting in a private bucket. Judges need to read
 * it; nobody else does. The route that serves it therefore has to hold four
 * properties at once, and each of them is easy to lose in a refactor:
 *
 *   - an admin session is required
 *   - the URL it hands out expires
 *   - no permanent public link is ever created
 *   - access is recorded
 *
 * Behaviour that depends on a live Supabase signed URL is covered by the
 * acceptance suite against the real project; this file pins the decisions in
 * the route itself, which is where they would quietly change.
 */

const ROUTE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '[id]/deck/route.ts',
);

const source = () => readFile(ROUTE, 'utf8');

/** Statements only. A comment mentioning a rule is not the rule. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('authentication', () => {
  it('requires an admin session before anything else', async () => {
    const text = code(await source());
    const sessionCheck = text.indexOf('getAdminSession');
    const storeAccess = text.indexOf('getSubmissionDetail');

    expect(sessionCheck).toBeGreaterThan(-1);
    expect(sessionCheck, 'the session must be checked before the submission is read').toBeLessThan(
      storeAccess,
    );
  });

  it('answers an unauthenticated caller with 404, not 401', async () => {
    // Whether a submission id exists is not something an anonymous request
    // should be able to learn by comparing status codes.
    const text = code(await source());
    expect(text).toMatch(/getAdminSession\(\);\s*if \(!session\) return new NextResponse\('Not found', \{ status: 404 \}\)/);
  });

  it('has no participant path into it', async () => {
    // The participant surface has its own routes. A shared handler is one
    // refactor away from serving a team somebody else's deck.
    const text = code(await source());
    expect(text).not.toMatch(/participant|resolveSession|PARTICIPANT_SESSION_COOKIE/);
  });
});

describe('the URL it hands out', () => {
  it('is signed and short-lived', async () => {
    const text = code(await source());
    expect(text).toMatch(/getSignedUrl\(/);
    expect(text).toMatch(/SIGNED_URL_SECONDS/);
  });

  it('expires in minutes, not hours', async () => {
    const text = await source();
    const match = /const SIGNED_URL_SECONDS = (\d+)/.exec(text);
    expect(match, 'the expiry must be a named constant').not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(900);
  });

  it('never creates a public URL', async () => {
    const text = code(await source());
    expect(text).not.toMatch(/getPublicUrl|\/object\/public\//);
  });

  it('is not cached, because it expires', async () => {
    const text = code(await source());
    expect(text).toMatch(/no-store/);
  });
});

describe('when there is nothing to open', () => {
  it('distinguishes "no deck" from "no such submission"', async () => {
    // An operator needs to know the team never uploaded one, rather than going
    // to look for a broken link.
    const text = await source();
    expect(text).toMatch(/This submission has no pitch deck/);
    expect(text).toMatch(/this is not a broken link/i);
  });

  it('says plainly when the record exists but the object does not', async () => {
    // The signature of an upload recorded as a success that never stored
    // anything — a defect this project has already had once (F-7).
    const text = await source();
    expect(text).toMatch(/recorded but its file could not be found/i);
    expect(text).toMatch(/artifact record with no object behind it/i);
  });
});

describe('the audit record', () => {
  it('is written on every access', async () => {
    const text = code(await source());
    expect(text).toMatch(/auditAdminAction\(/);
    expect(text).toMatch(/submission\.deck_accessed/);
  });

  it('records the path but never the signed URL', async () => {
    // A signed URL in an audit log is a live credential sitting in a table
    // that is deliberately readable for a long time.
    const text = code(await source());
    // Sliced to a marker that exists — the previous version cut to
    // `NextResponse.redirect`, which no longer appears, so it asserted on an
    // empty string and passed for the wrong reason.
    const start = text.indexOf('auditAdminAction(');
    const end = text.indexOf('const filename');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const auditBlock = text.slice(start, end);
    expect(auditBlock).toMatch(/storagePath/);
    expect(auditBlock).not.toMatch(/signedUrl/);
  });

  it('records which team it belonged to', async () => {
    const text = code(await source());
    expect(text).toMatch(/groupNumber: detail\.team\.groupNumber/);
  });
});

describe('the admin submission page', () => {
  const page = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../admin/submissions/[id]/submission-detail.tsx',
  );

  it('offers both View and Download', async () => {
    const text = await readFile(page, 'utf8');
    expect(text).toMatch(/View deck/);
    expect(text).toMatch(/Download deck/);
  });

  it('routes them through the authenticated endpoint, not the bucket', async () => {
    const text = await readFile(page, 'utf8');
    expect(text).toMatch(/\/api\/admin\/submissions\/\$\{detail\.submission\.id\}\/deck/);
    expect(text).not.toMatch(/supabase\.co\/storage/);
  });

  it('no longer shows only a storage path for a deck', async () => {
    // The state that made a deck unreadable: a path rendered as plain text.
    const text = await readFile(page, 'utf8');
    const deckBranch = text.slice(text.indexOf("artifact.kind === 'deck_pdf'"));
    expect(deckBranch.slice(0, 900)).toMatch(/View deck/);
  });
});

describe('View and Download are genuinely different', () => {
  const source = () => readFile(ROUTE, 'utf8');

  it('streams the object rather than redirecting to Storage', async () => {
    // A redirect handed the browser a cross-origin signed URL, and the outcome
    // was Supabase's to decide: the tab navigated away to a PDF viewer, and
    // "Download" behaved exactly like "View". `Content-Disposition` on somebody
    // else's response is not something this application can set.
    const text = code(await source());
    expect(text).not.toMatch(/NextResponse\.redirect/);
    expect(text).toMatch(/new Response\(upstream\.body/);
  });

  it('opens inline by default and attaches when asked', async () => {
    const text = code(await source());
    expect(text).toMatch(/wantsDownload \? 'attachment' : 'inline'/);
    expect(text).toMatch(/searchParams\.get\('download'\) === '1'/);
  });

  it('never lets the signed URL reach the browser', async () => {
    // Created, used and discarded server-side, so there is no URL to forward.
    const text = code(await source());
    const responseBlock = text.slice(text.indexOf('return new Response('));
    expect(responseBlock).not.toMatch(/signedUrl/);
  });

  it('gives the file a name a reviewer can find again', async () => {
    // Every deck is stored as `pitch-deck.pdf`, so three downloads would
    // otherwise collide.
    const text = code(await source());
    expect(text).toMatch(/function downloadFilename/);
    expect(text).toMatch(/group-\$\{groupNumber\}/);
  });

  it('strips anything unsafe out of the supplied filename', async () => {
    const text = code(await source());
    expect(text).toContain('[^\\w.-]+');
  });

  it('refuses to be sniffed into another content type', async () => {
    const text = code(await source());
    expect(text).toMatch(/x-content-type-options/);
    expect(text).toMatch(/nosniff/);
  });

  it('stays out of shared caches', async () => {
    expect(code(await source())).toMatch(/private, no-store/);
  });

  it('reports a missing object rather than streaming an error page as a PDF', async () => {
    const text = code(await source());
    expect(text).toMatch(/if \(!upstream\.ok \|\| !upstream\.body\)/);
    expect(text).toMatch(/return storageFailure\(\)/);
  });

  it('records which mode was used, and still never the URL', async () => {
    const text = code(await source());
    const auditBlock = text.slice(text.indexOf('auditAdminAction('), text.indexOf('const filename'));
    expect(auditBlock).toMatch(/mode: wantsDownload \? 'download' : 'view'/);
    expect(auditBlock).not.toMatch(/signedUrl/);
  });
});

describe('the admin page opens View in a new tab', () => {
  const page = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../admin/submissions/[id]/submission-detail.tsx',
  );

  it('so the operator keeps the submission they were reading', async () => {
    const text = await readFile(page, 'utf8');
    const viewBlock = text.slice(text.indexOf('View deck') - 400, text.indexOf('View deck'));
    expect(viewBlock).toMatch(/target="_blank"/);
  });

  it('and Download stays in place, because it does not navigate', async () => {
    const text = await readFile(page, 'utf8');
    const downloadBlock = text.slice(text.indexOf('Download deck') - 300, text.indexOf('Download deck'));
    expect(downloadBlock).toMatch(/download=1/);
    expect(downloadBlock).not.toMatch(/target="_blank"/);
  });
});
