/**
 * Fetching a deck the team linked rather than uploaded.
 *
 * The Judge takes no files from learners, so a deck arrives as a URL — nearly
 * always a Google Drive share link. Going and getting it means making an
 * outbound request to an address a stranger chose, which is the same threat as
 * the product URL and gets the same treatment: resolve first, check what it
 * resolved to, and only then connect.
 *
 * Redirects are where that gets interesting, and why this does not simply use
 * `redirect: 'follow'`. Drive's download endpoint always redirects, at least
 * once, to a different host. A single check before a followed redirect chain
 * proves nothing about where the request finally goes — the second hop can
 * point anywhere, including back inside our own network. So every hop is
 * resolved and checked on its own before it is taken.
 */

import { lookup } from 'node:dns/promises';
import {
  MAX_DECK_BYTES,
  assertResolvedAddressesSafe,
  looksLikePdf,
  resolveEvidenceLink,
  validateUrl,
} from '@ohj/shared';

/*
 * The same ceiling the upload path enforces, and the same magic-byte check.
 * A deck that arrives as a link and one that arrives as a file should be held
 * to one standard, or "too large" would mean two different things.
 */
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

export type DeckFetchResult =
  | { ok: true; bytes: Uint8Array; contentType: string; finalUrl: string }
  /**
   * Deliberately one shape for every failure. The caller's job is to say "the
   * deck could not be read, here is why" — never to conclude that a team that
   * linked a deck did not submit one.
   */
  | { ok: false; reason: string };

export interface DeckFetchOptions {
  fetchImpl?: typeof fetch;
  resolver?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

const defaultResolver = async (hostname: string) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

/**
 * Download a linked deck and return its bytes, or say why we could not.
 *
 * Never throws: an unreachable deck is missing evidence, and the assessment
 * carries on without it.
 */
export async function fetchLinkedDeck(
  url: string,
  options: DeckFetchOptions = {},
): Promise<DeckFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const resolver = options.resolver ?? defaultResolver;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const link = resolveEvidenceLink(url);
  if (!link) return { ok: false, reason: 'The deck link is not a usable http(s) URL.' };
  if (link.kind === 'video') {
    return { ok: false, reason: 'The deck link points at a video host, not a document.' };
  }

  let target = link.fetchUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const check = validateUrl(target, { requireHttps: false, allowPrivateAddress: false });
      if (!check.ok) return { ok: false, reason: check.message ?? 'The deck link is not a usable URL.' };

      const safe = await assertResolvedAddressesSafe(new URL(target).hostname, resolver);
      if (!safe.safe) {
        return { ok: false, reason: safe.reason ?? 'The deck link does not resolve to a public address.' };
      }

      const response = await doFetch(target, {
        // Manual, so the check above applies to every hop and not just the first.
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'OutskillHackathonJudge/1.0 (+assessment)' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { ok: false, reason: `Redirect with no destination (${response.status}).` };
        target = new URL(location, target).toString();
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reason: `Access denied (${response.status}) — the file is not shared with anyone who has the link.`,
        };
      }
      if (!response.ok) {
        return { ok: false, reason: `The deck link returned ${response.status}.` };
      }

      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > MAX_DECK_BYTES) {
        return { ok: false, reason: `The deck is larger than the ${MAX_DECK_BYTES / 1024 / 1024} MB limit.` };
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // Checked again after reading: `content-length` is a claim, not a fact.
      if (bytes.byteLength > MAX_DECK_BYTES) {
        return { ok: false, reason: `The deck is larger than the ${MAX_DECK_BYTES / 1024 / 1024} MB limit.` };
      }

      /*
       * Drive answers a request for an unshared file with 200 and an HTML
       * sign-in page. Taking that as a deck would extract no text from it,
       * which downstream reads as an image-only deck — a specific and wrong
       * conclusion about a team that shared nothing of the sort.
       */
      if (!looksLikePdf(bytes.slice(0, 8))) {
        return {
          ok: false,
          reason:
            'The deck link did not return a PDF — it is most likely a sign-in or permissions page, meaning the file is not shared publicly.',
        };
      }

      return {
        ok: true,
        bytes,
        contentType: response.headers.get('content-type') ?? '',
        finalUrl: target,
      };
    }

    return { ok: false, reason: `The deck link redirected more than ${MAX_REDIRECTS} times.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: controller.signal.aborted ? `The deck link timed out after ${timeoutMs} ms.` : message,
    };
  } finally {
    clearTimeout(timer);
  }
}
