/**
 * Preflight checks.
 *
 * Runs before any browser is launched. Two jobs:
 *   1. Establish whether the submission is assessable at all.
 *   2. Classify failures, so a temporary outage is never mistaken for a
 *      missing product. That distinction is the difference between a fair
 *      assessment and a wrongly disqualified team.
 *
 * Every attempt is recorded, not just the last one.
 */

import { lookup } from 'node:dns/promises';
import {
  assertResolvedAddressesSafe,
  resolveEvidenceLink,
  validateProductUrl,
  validateUrl,
  type FailureClass,
  type PreflightStatus,
} from '@ohj/shared';

export interface PreflightInput {
  submissionId: string;
  productUrl: string | null;
  /** Loom or other demo-video link, from the submission or a stored artifact. */
  demoVideoUrl: string | null;
  /**
   * Deck link, as the team supplied it — usually a Google Drive share URL.
   *
   * Distinct from `hasDeckPdf`, which means a PDF was uploaded through the
   * older artifact path and is already in storage. A submission may have
   * either, both or neither.
   */
  deckUrl: string | null;
  hasDeckPdf: boolean;
  deckReadable: boolean;
  deckPageCount: number | null;
  loginRequired: boolean;
  hasCredentials: boolean;
  ideaIsApproved: boolean;
  isComplete: boolean;
  isLate: boolean;
  attemptNumber: number;
  timeoutMs?: number;
}

export interface PreflightCheckResult {
  checkKey: string;
  status: PreflightStatus;
  attemptNumber: number;
  failureClass: FailureClass;
  detail: Record<string, unknown>;
  checkedAt: Date;
}

export interface PreflightOutcome {
  checks: PreflightCheckResult[];
  /** Can the browser stage proceed? */
  canProceed: boolean;
  /** Should this go to a human instead of being assessed or failed? */
  needsManualReview: boolean;
  manualReviewReason: string | null;
  /** True when failures look like a transient outage rather than an absence. */
  looksLikeOutage: boolean;
  /**
   * The product itself could not be reached — DNS, refused, timed out, down.
   *
   * Deliberately separate from the other reasons preflight stops. A malformed
   * URL is the submission being wrong and a blocked address is a rule being
   * enforced; this is a site that was not answering when we happened to look.
   * A team whose deployment was asleep at judging time has not failed the
   * hackathon, so this routes to a human rather than ending the assessment.
   */
  unreachable: boolean;
}

/** DNS resolver injected for testability; production uses the real one. */
export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

export async function runPreflight(
  input: PreflightInput,
  options: {
    resolver?: Resolver;
    fetchImpl?: typeof fetch;
    /**
     * Permit a product served from this machine.
     *
     * OFF by default and never set by the worker. It exists for one caller:
     * the controlled judging run, whose product under test is a fixture server
     * on 127.0.0.1. Without it that run cannot reach its own fixture, and the
     * only alternative is to stop exercising preflight at all.
     *
     * It relaxes exactly two rules — the HTTPS/port requirement and the
     * private-address gate — and nothing else. Every other check runs
     * unchanged. `worker-security.test.ts` asserts the production path never
     * passes it.
     */
    allowPrivateProductUrlForControlledRun?: boolean;
  } = {},
): Promise<PreflightOutcome> {
  const resolver = options.resolver ?? defaultResolver;
  const doFetch = options.fetchImpl ?? fetch;
  const controlledRun = options.allowPrivateProductUrlForControlledRun === true;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const checks: PreflightCheckResult[] = [];
  const at = () => new Date();

  const record = (
    checkKey: string,
    status: PreflightStatus,
    detail: Record<string, unknown>,
    failureClass: FailureClass = 'none',
  ) => {
    checks.push({
      checkKey,
      status,
      attemptNumber: input.attemptNumber,
      failureClass,
      detail,
      checkedAt: at(),
    });
  };

  // ---- Completeness, deadline, approved idea -----------------------------

  record(
    'completeness',
    input.isComplete ? 'pass' : 'fail',
    { message: input.isComplete ? 'All required fields present.' : 'Required fields are missing.' },
    input.isComplete ? 'none' : 'invalid',
  );

  // Lateness is recorded as a fact; whether it disqualifies is an admin call.
  record('deadline', input.isLate ? 'warn' : 'pass', {
    message: input.isLate
      ? 'Submitted after the deadline. Recorded as a fact — a disqualification decision is separate and reversible.'
      : 'Submitted before the deadline.',
  });

  record(
    'approved_idea',
    input.ideaIsApproved ? 'pass' : 'fail',
    {
      message: input.ideaIsApproved
        ? 'Selected idea is active for this cohort.'
        : 'Selected idea is not an active approved idea for this cohort.',
    },
    input.ideaIsApproved ? 'none' : 'invalid',
  );

  // ---- Deck and demo -----------------------------------------------------

  /*
   * Neither of these can stop a judging run.
   *
   * A deck and a Loom are supporting evidence: they inform the deck/demo
   * category and give the written submission something to be checked against.
   * A product that is deployed and working has not failed the hackathon
   * because a share link is set to the wrong audience, and no hackathon rule
   * says otherwise — so absence and inaccessibility are recorded as warnings
   * and priced into scoring, never used to end an assessment.
   *
   * They are also deliberately not failures for a second reason. `finish`
   * decides whether a set of failures looks like an outage by requiring every
   * one of them to be outage-shaped, so a `fail` here for a missing deck would
   * have made a genuinely unreachable product ineligible for the retry that
   * exists precisely for it.
   */
  const probeEvidence = async (url: string, label: string) => {
    const link = resolveEvidenceLink(url);
    if (!link) {
      return { ok: false, detail: `${label} is not a usable http(s) link.`, status: 0 };
    }
    /*
     * Learner-supplied links get the same egress treatment as the product URL.
     * This is a URL a stranger typed into a form, and fetching it from inside
     * our network without resolving it first is exactly the request-forgery
     * path the product URL is guarded against.
     */
    if (!controlledRun) {
      const check = validateUrl(link.fetchUrl, { requireHttps: false, allowPrivateAddress: false });
      if (!check.ok) {
        return { ok: false, detail: check.message ?? `${label} is not a usable URL.`, status: 0 };
      }
      const safe = await assertResolvedAddressesSafe(new URL(link.fetchUrl).hostname, resolver);
      if (!safe.safe) {
        return { ok: false, detail: safe.reason ?? 'Address is not publicly reachable.', status: 0 };
      }
    }
    const probe = await probeUrl(link.fetchUrl, doFetch, timeoutMs, 'HEAD');
    return { ok: probe.ok, detail: probe.detail, status: probe.status };
  };

  if (input.hasDeckPdf) {
    // A deck uploaded through the older artifact path is already in storage
    // and has already been parsed; nothing to reach for.
    record('deck_readable', input.deckReadable ? 'pass' : 'warn', {
      message: input.deckReadable
        ? `PDF parsed: ${input.deckPageCount ?? 'unknown'} pages, text extracted.`
        : `PDF parsed: ${input.deckPageCount ?? 'unknown'} pages, but no text could be extracted — the deck is likely image-based.`,
      source: 'uploaded',
    });
  } else if (input.deckUrl) {
    const probe = await probeEvidence(input.deckUrl, 'The deck link');
    record('deck_readable', probe.ok ? 'pass' : 'warn', {
      message: probe.ok
        ? `Deck link is reachable (${probe.status}). Contents are read during artifact analysis.`
        : `A deck link was supplied but could not be accessed (${probe.detail}). Deck evidence is unavailable — this is not a missing deck.`,
      source: 'link',
      accessible: probe.ok,
    });
  } else {
    record('deck_readable', 'warn', {
      message: 'No pitch deck link was supplied. Deck evidence is unavailable; this affects the deck and demo score rather than blocking judging.',
      source: 'none',
    });
  }

  if (!input.demoVideoUrl) {
    record('demo_link_accessible', 'warn', {
      message: 'No demo video link was supplied. This affects the deck and demo score rather than blocking judging.',
    });
  } else {
    const probe = await probeEvidence(input.demoVideoUrl, 'The demo link');
    record('demo_link_accessible', probe.ok ? 'pass' : 'warn', {
      message: probe.ok
        ? `Demo link returned ${probe.status}.`
        : `Demo link could not be verified (${probe.detail}). Video analysis will be marked limited rather than treated as a missing demo.`,
    });
  }

  // ---- Credentials -------------------------------------------------------

  if (!input.loginRequired) {
    record('credentials_present', 'skipped', { message: 'Not required — product should be usable as a guest.' });
  } else {
    record(
      'credentials_present',
      input.hasCredentials ? 'pass' : 'fail',
      {
        message: input.hasCredentials
          ? 'Demo credentials supplied and stored encrypted.'
          : 'Login is required but no demo credentials were supplied.',
      },
      input.hasCredentials ? 'none' : 'auth',
    );
  }

  // ---- Product URL -------------------------------------------------------

  if (!input.productUrl) {
    record('url_valid', 'fail', { message: 'No product URL was supplied.' }, 'invalid');
    return finish(checks, { canProceed: false, needsManualReview: false, manualReviewReason: null });
  }

  const validation = controlledRun
    ? validateUrl(input.productUrl, { requireHttps: false, allowPrivateAddress: true })
    : validateProductUrl(input.productUrl);
  if (!validation.ok) {
    record('url_valid', 'fail', { message: validation.message, code: validation.code }, 'invalid');
    return finish(checks, { canProceed: false, needsManualReview: false, manualReviewReason: null });
  }
  record('url_valid', 'pass', {
    message: 'Product URL is a valid HTTPS address.',
    warnings: validation.warnings.map((w) => w.message),
  });

  // A Drive folder or a video link is a supported-product-type question for a
  // human, not a failure.
  const blockingWarning = validation.warnings.find(
    (w) => w.code === 'document_host' || w.code === 'video_host',
  );
  if (blockingWarning) {
    record('product_type_supported', 'warn', { message: blockingWarning.message }, 'invalid');
    return finish(checks, {
      canProceed: false,
      needsManualReview: true,
      manualReviewReason: blockingWarning.message,
    });
  }

  // ---- SSRF gate ---------------------------------------------------------

  const { hostname } = new URL(validation.normalised as string);
  const resolved = controlledRun
    ? { safe: true, addresses: ['127.0.0.1'], reason: null }
    : await assertResolvedAddressesSafe(hostname, resolver);

  if (!resolved.safe) {
    const isDnsFailure = resolved.reason?.includes('DNS resolution failed') ?? false;
    record(
      isDnsFailure ? 'dns_resolves' : 'unsafe_url',
      'fail',
      { message: resolved.reason },
      isDnsFailure ? 'dns' : 'blocked',
    );
    return finish(checks, {
      canProceed: false,
      // A blocked address is a rule violation for a human to look at; a DNS
      // failure is retried and may simply be an outage.
      needsManualReview: !isDnsFailure,
      manualReviewReason: isDnsFailure ? null : (resolved.reason ?? 'Address is not publicly reachable.'),
      /*
       * A name that does not resolve is the product being unreachable, not the
       * submission being wrong — a DNS record still propagating looks exactly
       * like this. It is retried first, and if it never answers it goes to a
       * human rather than ending the assessment.
       *
       * A blocked address is emphatically not this. That is the SSRF rule doing
       * its job, and it keeps the path it always had.
       */
      unreachable: isDnsFailure,
    });
  }

  record('dns_resolves', 'pass', { message: `Hostname resolved to ${resolved.addresses.length} public address(es).` });
  record('unsafe_url', 'pass', { message: 'URL does not resolve to a private or blocked address.' });

  // ---- Reachability ------------------------------------------------------

  const probe = await probeUrl(validation.normalised as string, doFetch, timeoutMs, 'GET');
  if (!probe.ok) {
    record('http_reachable', 'fail', { message: probe.detail }, probe.failureClass);
    return finish(checks, {
      canProceed: false,
      needsManualReview: false,
      manualReviewReason: null,
      unreachable: true,
    });
  }

  record('http_reachable', 'pass', {
    message: `GET returned ${probe.status} in ${probe.durationMs} ms.`,
  });
  record('https_enforced', 'pass', { message: 'Product URL uses HTTPS.' });
  record(
    'redirects_sane',
    probe.redirected ? 'pass' : 'pass',
    { message: probe.redirected ? `Redirected to ${probe.finalUrl}.` : 'No redirects.' },
  );

  // ---- Product type ------------------------------------------------------

  const typeCheck = classifyProductType(probe.contentType, probe.bodySample, probe.finalUrl);
  record(
    'product_type_supported',
    typeCheck.supported ? 'pass' : 'fail',
    { message: typeCheck.message },
    typeCheck.supported ? 'none' : 'invalid',
  );

  record('duplicate_submission', 'pass', { message: 'One submission for this team in this cohort.' });

  return finish(checks, {
    canProceed: typeCheck.supported,
    needsManualReview: !typeCheck.supported,
    manualReviewReason: typeCheck.supported ? null : typeCheck.message,
  });
}

function finish(
  checks: PreflightCheckResult[],
  outcome: {
    canProceed: boolean;
    needsManualReview: boolean;
    manualReviewReason: string | null;
    unreachable?: boolean;
  },
): PreflightOutcome {
  const failures = checks.filter((c) => c.status === 'fail');
  // Timeout, DNS and server-error failures are all consistent with a host being
  // temporarily down. A missing field or an invalid URL is not.
  const outageClasses: FailureClass[] = ['timeout', 'dns', 'server'];
  const looksLikeOutage =
    failures.length > 0 && failures.every((c) => outageClasses.includes(c.failureClass));

  return { checks, looksLikeOutage, unreachable: false, ...outcome };
}

// --------------------------------------------------------------------------
// HTTP probing
// --------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  redirected: boolean;
  contentType: string;
  bodySample: string;
  durationMs: number;
  failureClass: FailureClass;
  detail: string;
}

async function probeUrl(
  url: string,
  doFetch: typeof fetch,
  timeoutMs: number,
  method: 'GET' | 'HEAD',
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  const empty: Omit<ProbeResult, 'ok' | 'failureClass' | 'detail'> = {
    status: 0,
    finalUrl: url,
    redirected: false,
    contentType: '',
    bodySample: '',
    durationMs: 0,
  };

  try {
    const response = await doFetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'OutskillHackathonJudge/1.0 (+assessment)' },
    });

    const durationMs = Date.now() - started;
    const contentType = response.headers.get('content-type') ?? '';
    let bodySample = '';
    if (method === 'GET') {
      // Only the first few KB — enough to classify, and bounded so a huge or
      // hostile response cannot exhaust memory.
      bodySample = (await response.text().catch(() => '')).slice(0, 4096);
    }

    if (response.status >= 500) {
      return {
        ...empty,
        ok: false,
        status: response.status,
        durationMs,
        failureClass: 'server',
        detail: `Server returned ${response.status}. This may be a temporary outage.`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ...empty,
        ok: false,
        status: response.status,
        durationMs,
        failureClass: 'auth',
        detail: `Access denied (${response.status}).`,
      };
    }
    if (response.status >= 400) {
      return {
        ...empty,
        ok: false,
        status: response.status,
        durationMs,
        failureClass: 'blocked',
        detail: `Returned ${response.status}.`,
      };
    }

    return {
      ok: true,
      status: response.status,
      finalUrl: response.url || url,
      redirected: response.redirected,
      contentType,
      bodySample,
      durationMs,
      failureClass: 'none',
      detail: `OK (${response.status})`,
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    const isDns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message);

    return {
      ...empty,
      ok: false,
      durationMs,
      failureClass: isTimeout ? 'timeout' : isDns ? 'dns' : 'blocked',
      detail: isTimeout
        ? `No response within ${timeoutMs} ms.`
        : isDns
          ? `DNS lookup failed: ${message}`
          : `Could not connect: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide whether automated browser testing can assess this product.
 *
 * Anything outside the supported boundary is routed to manual review, never
 * penalised — a native mobile app is not a worse submission, it is one this
 * tool cannot judge.
 */
export function classifyProductType(
  contentType: string,
  bodySample: string,
  finalUrl: string,
): { supported: boolean; message: string } {
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    return {
      supported: false,
      message: `The URL serves ${contentType || 'a non-HTML response'} rather than a web application. Needs manual review.`,
    };
  }

  const url = finalUrl.toLowerCase();
  const storeHosts = ['play.google.com/store', 'apps.apple.com', 'itunes.apple.com', 'chromewebstore.google.com', 'addons.mozilla.org'];
  if (storeHosts.some((host) => url.includes(host))) {
    return {
      supported: false,
      message:
        'The URL is an app-store or extension listing, not a web application. Automated browser testing cannot assess this product type — routed to manual review.',
    };
  }

  const body = bodySample.toLowerCase();
  if (/\b(?:recaptcha|hcaptcha|cf-turnstile)\b/.test(body)) {
    return {
      supported: false,
      message: 'A CAPTCHA guards the entry page, so automated testing cannot proceed. Needs manual review.',
    };
  }
  if (/verify your (?:email|phone)|enter the (?:otp|code) sent/i.test(bodySample)) {
    return {
      supported: false,
      message:
        'Entry appears to require email or phone verification, which automated testing cannot complete. Needs manual review.',
    };
  }

  return { supported: true, message: 'Public HTTPS web application — fully supported.' };
}
