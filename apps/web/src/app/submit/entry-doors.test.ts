import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * How many ways there are into a team's submission.
 *
 * There must be exactly one in production: the common `/submit` URL, with a
 * group number and an access code. The code is Argon2id-hashed, rate-limited,
 * locks out after eight wrong attempts, and is versioned so that regenerating
 * it signs everyone out.
 *
 * `/submit/[token]` grants the same access with none of that. A token sitting
 * in a URL cannot be rate-limited into uselessness, and a URL is precisely the
 * thing that gets forwarded into a group chat. It stays only because the demo
 * home page opens teams directly, so it is gated to demo mode — and this test
 * is what keeps that gate in place, since removing it would break nothing that
 * a test would otherwise notice.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

async function inviteRouteSource(): Promise<string> {
  return readFile(resolve(HERE, '[token]/page.tsx'), 'utf8');
}

describe('the invite-token route', () => {
  it('refuses to run outside demo mode', async () => {
    const source = await inviteRouteSource();
    expect(source).toMatch(/if\s*\(!isDemo\(\)\)\s*notFound\(\)/);
  });

  it('checks demo mode before it looks the token up', async () => {
    // Order matters. Resolving first would let a caller distinguish a real
    // token from a made-up one by timing, which is the enumeration weakness
    // the common entry was designed to avoid.
    const source = await inviteRouteSource();
    const gate = source.indexOf('isDemo()');
    const lookup = source.indexOf('resolveInviteTeam');
    expect(gate).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(lookup);
  });

  it('fails closed with a 404 rather than an explanation', async () => {
    // An error page saying "invite links are disabled" confirms the route
    // exists. A 404 is indistinguishable from a route that never did.
    const source = await inviteRouteSource();
    expect(source).not.toMatch(/invite links are disabled/i);
  });
});
