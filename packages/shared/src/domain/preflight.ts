/**
 * Preflight: can this submission be assessed at all?
 *
 * Preflight runs before any judging and answers one question per check. The
 * design problem is not detecting failures — it is telling apart failures that
 * mean different things:
 *
 *   ABSENT            the team never provided it
 *   BROKEN            it is there and it does not work
 *   TEMPORARY_OUTAGE  it did not respond this time
 *   UNKNOWN           we could not determine either way
 *   DISALLOWED        we are not permitted to visit it
 *
 * Collapsing these is how an automated judge becomes unfair. "Their site was
 * down when we looked" and "they never submitted a site" are the same HTTP
 * outcome and opposite facts about the team. A free-tier host that cold-starts
 * in twelve seconds, a laptop closed at midnight, a CDN hiccup — all produce
 * failures that say nothing about the work.
 *
 * So only ABSENT and DISALLOWED can ever support a disqualification, and even
 * then only through the eleven permitted grounds. TEMPORARY_OUTAGE and UNKNOWN
 * route to a human. This module holds no I/O: it decides what an observation
 * means, which is the part worth testing exhaustively.
 */

export type PreflightStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export type FailureClass = 'timeout' | 'dns' | 'auth' | 'server' | 'blocked' | 'invalid' | 'none';

export type PreflightOutcome =
  | 'satisfied'
  | 'absent'
  | 'broken'
  | 'temporary_outage'
  | 'unknown'
  | 'disallowed';

/** The checks preflight performs, in the order they are attempted. */
export const PREFLIGHT_CHECKS = [
  'product_url_present',
  'product_url_parseable',
  'product_url_scheme',
  'product_url_public',
  'product_url_dns',
  'product_url_reachable',
  'product_url_http_status',
  'product_url_tls',
  'required_fields_present',
  'deck_present',
  'deck_readable',
  'demo_video_present',
  'demo_video_reachable',
  'login_credentials_present',
  'login_credentials_usable',
] as const;

export type PreflightCheckKey = (typeof PREFLIGHT_CHECKS)[number];

export interface PreflightObservation {
  checkKey: PreflightCheckKey;
  status: PreflightStatus;
  failureClass: FailureClass;
  attemptNumber: number;
  detail: Record<string, unknown>;
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

/**
 * What one observation means.
 *
 * The failure class carries the meaning, not the status — `fail` alone cannot
 * distinguish "no URL" from "the URL timed out". `invalid` is the class the
 * checker uses when the thing is missing or malformed, which is a statement
 * about the submission; every other class is a statement about the network or
 * the host.
 */
export function classifyObservation(observation: PreflightObservation): PreflightOutcome {
  if (observation.status === 'pass') return 'satisfied';
  if (observation.status === 'skipped') return 'unknown';

  switch (observation.failureClass) {
    case 'invalid':
      // Nothing there, or nothing usable there. A fact about the submission.
      return observation.status === 'warn' ? 'broken' : 'absent';

    case 'blocked':
      // We are not permitted to visit it — a private address, a disallowed
      // scheme, or a host that refuses automated access.
      return 'disallowed';

    case 'timeout':
    case 'dns':
    case 'server':
      // Every one of these is routinely transient. A free-tier host that
      // cold-starts slowly produces all three across a day.
      return 'temporary_outage';

    case 'auth':
      // The product wants credentials. Whether that is the team's fault depends
      // on what they declared, which this function cannot see.
      return 'broken';

    case 'none':
      return 'unknown';

    default:
      return 'unknown';
  }
}

/**
 * What the whole preflight means, given every attempt.
 *
 * Attempts are folded per check with the most favourable result winning: a
 * check that passed on the third attempt passed. That is not leniency, it is
 * accuracy — a site that answers is a site that answers, and the earlier
 * timeouts were facts about the moment rather than about the product.
 */
export function foldAttempts(observations: readonly PreflightObservation[]): Map<
  PreflightCheckKey,
  { outcome: PreflightOutcome; attempts: number; last: PreflightObservation }
> {
  const byCheck = new Map<
    PreflightCheckKey,
    { outcome: PreflightOutcome; attempts: number; last: PreflightObservation }
  >();

  for (const observation of observations) {
    const outcome = classifyObservation(observation);
    const existing = byCheck.get(observation.checkKey);

    if (!existing) {
      byCheck.set(observation.checkKey, { outcome, attempts: 1, last: observation });
      continue;
    }

    byCheck.set(observation.checkKey, {
      outcome: betterOutcome(existing.outcome, outcome),
      attempts: existing.attempts + 1,
      last:
        observation.attemptNumber >= existing.last.attemptNumber ? observation : existing.last,
    });
  }

  return byCheck;
}

/** Ordered best to worst. `satisfied` wins over anything; `absent` is the most certain failure. */
const OUTCOME_RANK: Record<PreflightOutcome, number> = {
  satisfied: 0,
  temporary_outage: 1,
  unknown: 2,
  broken: 3,
  disallowed: 4,
  absent: 5,
};

function betterOutcome(a: PreflightOutcome, b: PreflightOutcome): PreflightOutcome {
  return OUTCOME_RANK[a] <= OUTCOME_RANK[b] ? a : b;
}

// --------------------------------------------------------------------------
// What preflight is allowed to conclude
// --------------------------------------------------------------------------

export type PreflightVerdict =
  | { kind: 'proceed' }
  | { kind: 'proceed_degraded'; limitations: string[] }
  | { kind: 'manual_review'; reasonCode: string; detail: string }
  | { kind: 'propose_disqualification'; reasonCode: string; detail: string };

/** Checks without which browser testing cannot happen at all. */
const BLOCKING_CHECKS: PreflightCheckKey[] = [
  'product_url_present',
  'product_url_parseable',
  'product_url_scheme',
  'product_url_public',
  'product_url_reachable',
];

/**
 * Decide what happens next.
 *
 * The ordering matters. A submission with no product URL is a permitted
 * disqualification ground and is decided first, because everything downstream
 * would otherwise report a cascade of timeouts against a URL that was never
 * there. Anything uncertain goes to a human — never to a disqualification.
 */
export function decidePreflight(
  folded: ReadonlyMap<PreflightCheckKey, { outcome: PreflightOutcome; attempts: number }>,
  context: { loginRequired: boolean; credentialsProvided: boolean },
): PreflightVerdict {
  const outcome = (key: PreflightCheckKey): PreflightOutcome =>
    folded.get(key)?.outcome ?? 'unknown';

  // --- grounds that are genuinely about the submission ---

  if (outcome('product_url_present') === 'absent') {
    return {
      kind: 'propose_disqualification',
      reasonCode: 'missing_product_url',
      detail: 'No product URL was submitted.',
    };
  }

  if (outcome('deck_present') === 'absent') {
    return {
      kind: 'propose_disqualification',
      reasonCode: 'missing_pdf_deck',
      detail: 'No pitch deck was submitted.',
    };
  }

  if (outcome('demo_video_present') === 'absent') {
    return {
      kind: 'propose_disqualification',
      reasonCode: 'missing_demo_link',
      detail: 'No demo video link was submitted.',
    };
  }

  if (context.loginRequired && !context.credentialsProvided) {
    return {
      kind: 'propose_disqualification',
      reasonCode: 'login_required_without_working_credentials',
      detail: 'The team declared that a login is required but supplied no demo credentials.',
    };
  }

  // --- we are not permitted to look ---

  const disallowed = [...folded.entries()].filter(([, v]) => v.outcome === 'disallowed');
  if (disallowed.length > 0) {
    return {
      kind: 'manual_review',
      reasonCode: 'target_not_permitted',
      detail: `Cannot visit the submitted target: ${disallowed.map(([k]) => k).join(', ')}. A human must confirm what was submitted before anything is concluded.`,
    };
  }

  // --- we looked and could not tell ---

  const blocked = BLOCKING_CHECKS.filter((key) =>
    ['temporary_outage', 'unknown', 'broken'].includes(outcome(key)),
  );
  if (blocked.length > 0) {
    const worst = blocked.map((key) => `${key} (${outcome(key)})`).join(', ');
    return {
      kind: 'manual_review',
      // Deliberately NOT `artifact_inaccessible_after_retries`. That ground
      // exists, but a machine reaching it on its own would disqualify teams for
      // being hosted somewhere slow. A human decides whether the retries were
      // enough.
      reasonCode: 'app_unreachable',
      detail: `The product could not be reached after retries: ${worst}. This may be the host rather than the team.`,
    };
  }

  // --- we can proceed, possibly with less than everything ---

  const limitations: string[] = [];
  if (outcome('deck_readable') !== 'satisfied') {
    limitations.push('The deck could not be read, so deck-based evidence is unavailable.');
  }
  if (outcome('demo_video_reachable') !== 'satisfied') {
    limitations.push('The demo video could not be opened, so it was not reviewed.');
  }
  if (context.loginRequired && outcome('login_credentials_usable') !== 'satisfied') {
    limitations.push('The supplied credentials could not be confirmed before testing began.');
  }

  return limitations.length > 0 ? { kind: 'proceed_degraded', limitations } : { kind: 'proceed' };
}

/**
 * Is this outcome allowed to contribute to a disqualification?
 *
 * A single place to ask, so the rule cannot drift between the preflight stage
 * and anything downstream that reads the same checks.
 */
export function canSupportDisqualification(outcome: PreflightOutcome): boolean {
  return outcome === 'absent';
}

/** Plain-English rendering for the admin queue and the manual-review screen. */
export function describeOutcome(outcome: PreflightOutcome): string {
  switch (outcome) {
    case 'satisfied':
      return 'Fine';
    case 'absent':
      return 'Not submitted';
    case 'broken':
      return 'Present but not working';
    case 'temporary_outage':
      return 'Did not respond — may be temporary';
    case 'disallowed':
      return 'Not permitted to visit';
    case 'unknown':
      return 'Could not determine';
  }
}
