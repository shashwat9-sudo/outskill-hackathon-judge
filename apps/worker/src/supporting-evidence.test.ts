import { describe, expect, it } from 'vitest';
import { runPreflight } from './preflight';
import { fetchLinkedDeck } from './evidence-fetch';

/**
 * Supporting evidence supplied as links.
 *
 * Teams submit through the Hackathon product, which asks for a Loom URL and a
 * deck URL. Nothing is uploaded into the Judge. Preflight nevertheless looked
 * only at `submission_artifacts` — the old upload path — so every sheet-ingested
 * team was reported as having submitted no deck and no demo while both links
 * sat in their submission row.
 *
 * Two things are being pinned here. That a supplied link is seen. And that the
 * three states stay distinguishable: nothing submitted, submitted but
 * unreachable, submitted and fine. Collapsing the first two is what produced
 * "No PDF pitch deck was uploaded" for a team who uploaded a deck to Drive and
 * pasted the link exactly as asked.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

const base = {
  submissionId: 'sub-1',
  productUrl: 'https://sizzle.example.com',
  demoVideoUrl: null as string | null,
  deckUrl: null as string | null,
  hasDeckPdf: false,
  deckReadable: false,
  deckPageCount: null as number | null,
  loginRequired: false,
  hasCredentials: false,
  ideaIsApproved: true,
  isComplete: true,
  isLate: false,
  attemptNumber: 1,
  timeoutMs: 2000,
};

/** Public resolution, a healthy product, and whatever the test says about links. */
const opts = (linkResponses: Record<string, Response | Error> = {}) => ({
  resolver: async () => ['93.184.216.34'],
  fetchImpl: (async (url: string | URL) => {
    const href = typeof url === 'string' ? url : url.toString();
    for (const [fragment, response] of Object.entries(linkResponses)) {
      if (href.includes(fragment)) {
        if (response instanceof Error) throw response;
        return response.clone();
      }
    }
    if (href.includes('sizzle.example.com')) {
      return new Response('<html><body><h1>Sizzle</h1><button>Save recipe</button></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch,
});

const check = (
  outcome: Awaited<ReturnType<typeof runPreflight>>,
  key: string,
) => outcome.checks.find((c) => c.checkKey === key)!;

// --------------------------------------------------------------------------
// A link that was supplied is seen
// --------------------------------------------------------------------------

describe('a supplied link is recognised', () => {
  it('sees a Loom link on the submission, with no uploaded video artifact', async () => {
    const outcome = await runPreflight(
      { ...base, demoVideoUrl: 'https://www.loom.com/share/70fc0c9de0004cbc8347a5bf2e41b0fe' },
      opts({ 'loom.com': new Response('', { status: 200 }) }),
    );

    const demo = check(outcome, 'demo_link_accessible');
    expect(demo.status).toBe('pass');
    expect(String(demo.detail.message)).not.toContain('No demo video link');
  });

  it('sees a Google Drive deck link, with no uploaded PDF', async () => {
    const outcome = await runPreflight(
      { ...base, deckUrl: 'https://drive.google.com/open?id=1gsFyGihooBwZ3jxfsHS5V-OnJ_CzjWXk' },
      opts({ 'drive.google.com': new Response('', { status: 200 }) }),
    );

    const deck = check(outcome, 'deck_readable');
    expect(deck.status).toBe('pass');
    expect(deck.detail.source).toBe('link');
    // The exact wording the bug report quoted must not be reachable here.
    expect(String(deck.detail.message)).not.toContain('No PDF pitch deck was uploaded');
  });

  it('still reads a deck uploaded through the legacy artifact path', async () => {
    const outcome = await runPreflight(
      { ...base, hasDeckPdf: true, deckReadable: true, deckPageCount: 8 },
      opts(),
    );

    const deck = check(outcome, 'deck_readable');
    expect(deck.status).toBe('pass');
    expect(deck.detail.source).toBe('uploaded');
    expect(String(deck.detail.message)).toContain('8 pages');
  });

  it('prefers the uploaded deck over a link, and does not go to the network for it', async () => {
    let fetched = false;
    const outcome = await runPreflight(
      {
        ...base,
        hasDeckPdf: true,
        deckReadable: true,
        deckPageCount: 3,
        deckUrl: 'https://drive.google.com/open?id=SHOULD_NOT_BE_FETCHED',
      },
      {
        resolver: async () => ['93.184.216.34'],
        fetchImpl: (async (url: string | URL) => {
          if (String(url).includes('SHOULD_NOT_BE_FETCHED')) fetched = true;
          return new Response('<html>ok</html>', { status: 200 });
        }) as unknown as typeof fetch,
      },
    );

    expect(fetched).toBe(false);
    expect(check(outcome, 'deck_readable').detail.source).toBe('uploaded');
  });
});

// --------------------------------------------------------------------------
// Absent is not the same as unreachable
// --------------------------------------------------------------------------

describe('missing evidence is distinguished from inaccessible evidence', () => {
  it('says the deck was never supplied when there is no link', async () => {
    const outcome = await runPreflight({ ...base }, opts());

    const deck = check(outcome, 'deck_readable');
    expect(deck.status).toBe('warn');
    expect(deck.detail.source).toBe('none');
    expect(String(deck.detail.message)).toContain('No pitch deck link was supplied');
  });

  it('says the deck could not be accessed when the link is refused', async () => {
    const outcome = await runPreflight(
      { ...base, deckUrl: 'https://drive.google.com/open?id=PRIVATE' },
      opts({ 'drive.google.com': new Response('', { status: 403 }) }),
    );

    const deck = check(outcome, 'deck_readable');
    expect(deck.status).toBe('warn');
    expect(deck.detail.source).toBe('link');
    expect(deck.detail.accessible).toBe(false);
    expect(String(deck.detail.message)).toContain('could not be accessed');
    // The whole point of the distinction.
    expect(String(deck.detail.message)).toContain('not a missing deck');
  });

  it('says the demo was never supplied when there is no link', async () => {
    const outcome = await runPreflight({ ...base }, opts());

    const demo = check(outcome, 'demo_link_accessible');
    expect(demo.status).toBe('warn');
    expect(String(demo.detail.message)).toContain('No demo video link was supplied');
  });

  it('says the demo could not be verified when the link fails', async () => {
    const outcome = await runPreflight(
      { ...base, demoVideoUrl: 'https://www.loom.com/share/deleted' },
      opts({ 'loom.com': new Response('', { status: 404 }) }),
    );

    const demo = check(outcome, 'demo_link_accessible');
    expect(demo.status).toBe('warn');
    expect(String(demo.detail.message)).toContain('could not be verified');
    expect(String(demo.detail.message)).not.toContain('No demo video link was supplied');
  });
});

// --------------------------------------------------------------------------
// Evidence never ends an assessment
// --------------------------------------------------------------------------

describe('a testable product survives its supporting evidence', () => {
  it('proceeds to judging with no deck and no demo at all', async () => {
    /*
     * The original defect. A product that was up, reachable, HTTPS and a
     * supported type was stopped because two links were not found where the
     * code was looking. No hackathon rule makes either mandatory, so nothing
     * about them may end an assessment.
     */
    const outcome = await runPreflight({ ...base }, opts());

    expect(outcome.canProceed).toBe(true);
    expect(outcome.needsManualReview).toBe(false);
    expect(outcome.checks.filter((c) => c.status === 'fail')).toHaveLength(0);
  });

  it('proceeds when both links were supplied but neither could be reached', async () => {
    const outcome = await runPreflight(
      {
        ...base,
        deckUrl: 'https://drive.google.com/open?id=PRIVATE',
        demoVideoUrl: 'https://www.loom.com/share/private',
      },
      opts({
        'drive.google.com': new Response('', { status: 403 }),
        'loom.com': new Response('', { status: 403 }),
      }),
    );

    expect(outcome.canProceed).toBe(true);
    expect(outcome.needsManualReview).toBe(false);
  });

  it('does not let missing evidence disguise a genuine outage', async () => {
    /*
     * `looksLikeOutage` requires every failure to be outage-shaped, and that is
     * what buys an unreachable product its retry. While the deck and demo
     * checks failed as `invalid`, a product that was merely down could never
     * qualify — its own timeout was outvoted by two findings about links.
     */
    const outcome = await runPreflight(
      { ...base, productUrl: 'https://asleep.example.com' },
      {
        resolver: async () => ['93.184.216.34'],
        fetchImpl: (async () => {
          throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        }) as unknown as typeof fetch,
      },
    );

    expect(outcome.canProceed).toBe(false);
    expect(outcome.looksLikeOutage).toBe(true);
    expect(outcome.unreachable).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Egress
// --------------------------------------------------------------------------

describe('fetching a linked deck', () => {
  const publicResolver = async () => ['93.184.216.34'];

  it('follows Drive through its redirect and returns the PDF', async () => {
    const result = await fetchLinkedDeck('https://drive.google.com/open?id=DECK', {
      resolver: publicResolver,
      fetchImpl: (async (url: string | URL) => {
        if (String(url).includes('drive.google.com')) {
          return new Response('', {
            status: 302,
            headers: { location: 'https://doc-0.googleusercontent.com/deck.pdf' },
          });
        }
        return new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.slice(0, 4)).toEqual(PDF.slice(0, 4));
  });

  it('checks every redirect hop, not just the first', async () => {
    /*
     * The reason this does not use `redirect: 'follow'`. Drive redirects, so a
     * single pre-flight check on the first URL proves nothing about where the
     * request lands — and the second hop is attacker-chosen.
     */
    const result = await fetchLinkedDeck('https://drive.google.com/open?id=DECK', {
      resolver: async (hostname) => (hostname === 'drive.google.com' ? ['93.184.216.34'] : ['127.0.0.1']),
      fetchImpl: (async (url: string | URL) => {
        if (String(url).includes('drive.google.com')) {
          return new Response('', {
            status: 302,
            headers: { location: 'http://internal.example.com/admin' },
          });
        }
        return new Response('secrets', { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/private|loopback|not publicly/i);
  });

  it('refuses a deck link that resolves to a private address outright', async () => {
    const result = await fetchLinkedDeck('https://deck.internal.example.com/d.pdf', {
      resolver: async () => ['10.0.0.5'],
      fetchImpl: (async () => new Response(PDF, { status: 200 })) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
  });

  it('calls a Drive sign-in page what it is, rather than an unreadable deck', async () => {
    const result = await fetchLinkedDeck('https://drive.google.com/open?id=PRIVATE', {
      resolver: publicResolver,
      fetchImpl: (async () =>
        new Response('<html><body>Sign in to continue</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not shared publicly');
  });

  it('reports a permissions refusal as exactly that', async () => {
    const result = await fetchLinkedDeck('https://drive.google.com/open?id=PRIVATE', {
      resolver: publicResolver,
      fetchImpl: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not shared');
  });

  it('never throws — an unreadable deck is missing evidence, not a broken run', async () => {
    const result = await fetchLinkedDeck('https://drive.google.com/open?id=DECK', {
      resolver: publicResolver,
      fetchImpl: (async () => {
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
  });

  it('stops a redirect loop instead of following it forever', async () => {
    const result = await fetchLinkedDeck('https://example.com/deck.pdf', {
      resolver: publicResolver,
      fetchImpl: (async () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://example.com/deck.pdf' },
        })) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('redirected more than');
  });

  it('refuses to treat a video link as a document', async () => {
    const result = await fetchLinkedDeck('https://www.loom.com/share/abc', {
      resolver: publicResolver,
      fetchImpl: (async () => new Response(PDF, { status: 200 })) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('video host');
  });
});
