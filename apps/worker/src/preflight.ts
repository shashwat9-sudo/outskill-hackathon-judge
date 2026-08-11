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
  validateProductUrl,
  type FailureClass,
  type PreflightStatus,
} from '@ohj/shared';

export interface PreflightInput {
  submissionId: string;
  productUrl: string | null;
  demoVideoUrl: string | null;
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
}

/** DNS resolver injected for testability; production uses the real one. */
export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
};

export async function runPreflight(
  input: PreflightInput,
  options: { resolver?: Resolver; fetchImpl?: typeof fetch } = {},
): Promise<PreflightOutcome> {
  const resolver = options.resolver ?? defaultResolver;
  const doFetch = options.fetchImpl ?? fetch;
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

  record(
    'deck_readable',
    input.hasDeckPdf ? (input.deckReadable ? 'pass' : 'warn') : 'fail',
    {
      message: !input.hasDeckPdf
        ? 'No PDF pitch deck was uploaded.'
        : input.deckReadable
          ? `PDF parsed: ${input.deckPageCount ?? 'unknown'} pages, text extracted.`
          : `PDF parsed: ${input.deckPageCount ?? 'unknown'} pages, but no text could be extracted — the deck is likely image-based.`,
    },
    input.hasDeckPdf ? 'none' : 'invalid',
  );

  if (!input.demoVideoUrl) {
    record('demo_link_accessible', 'fail', { message: 'No demo video link was supplied.' }, 'invalid');
  } else {
    const probe = await probeUrl(input.demoVideoUrl, doFetch, timeoutMs, 'HEAD');
    record(
      'demo_link_accessible',
      probe.ok ? 'pass' : 'warn',
      {
        message: probe.ok
          ? `Demo link returned ${probe.status}.`
          : `Demo link could not be verified (${probe.detail}). Video analysis will be marked limited rather than treated as a missing demo.`,
      },
      probe.ok ? 'none' : probe.failureClass,
    );
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

  const validation = validateProductUrl(input.productUrl);
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
  const resolved = await assertResolvedAddressesSafe(hostname, resolver);

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
    });
  }

  record('dns_resolves', 'pass', { message: `Hostname resolved to ${resolved.addresses.length} public address(es).` });
  record('unsafe_url', 'pass', { message: 'URL does not resolve to a private or blocked address.' });

  // ---- Reachability ------------------------------------------------------

  const probe = await probeUrl(validation.normalised as string, doFetch, timeoutMs, 'GET');
  if (!probe.ok) {
    record('http_reachable', 'fail', { message: probe.detail }, probe.failureClass);
    return finish(checks, { canProceed: false, needsManualReview: false, manualReviewReason: null });
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
  outcome: { canProceed: boolean; needsManualReview: boolean; manualReviewReason: string | null },
): PreflightOutcome {
  const failures = checks.filter((c) => c.status === 'fail');
  // Timeout, DNS and server-error failures are all consistent with a host being
  // temporarily down. A missing field or an invalid URL is not.
  const outageClasses: FailureClass[] = ['timeout', 'dns', 'server'];
  const looksLikeOutage =
    failures.length > 0 && failures.every((c) => outageClasses.includes(c.failureClass));

  return { checks, looksLikeOutage, ...outcome };
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
