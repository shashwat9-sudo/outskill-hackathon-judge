import { describe, expect, it } from 'vitest';
import {
  canSupportDisqualification,
  classifyObservation,
  decidePreflight,
  describeOutcome,
  foldAttempts,
  PREFLIGHT_CHECKS,
  type PreflightCheckKey,
  type PreflightObservation,
  type PreflightOutcome,
} from './preflight';

/**
 * Telling apart failures that mean different things.
 *
 * "Their site was down when we looked" and "they never submitted a site" are
 * the same HTTP outcome and opposite facts about a team. Everything here exists
 * to keep them apart, because collapsing them is how an automated judge starts
 * disqualifying people for being hosted somewhere slow.
 */

function observe(
  checkKey: PreflightCheckKey,
  status: PreflightObservation['status'],
  failureClass: PreflightObservation['failureClass'],
  attemptNumber = 1,
): PreflightObservation {
  return { checkKey, status, failureClass, attemptNumber, detail: {} };
}

describe('classifying one observation', () => {
  it('reads a pass as satisfied', () => {
    expect(classifyObservation(observe('product_url_reachable', 'pass', 'none'))).toBe('satisfied');
  });

  it('reads a missing thing as absent', () => {
    expect(classifyObservation(observe('product_url_present', 'fail', 'invalid'))).toBe('absent');
  });

  it('reads a timeout as a temporary outage, not a broken product', () => {
    // A free-tier host that cold-starts in twelve seconds produces this, and it
    // says nothing about the work.
    expect(classifyObservation(observe('product_url_reachable', 'fail', 'timeout'))).toBe(
      'temporary_outage',
    );
  });

  it('reads a DNS or server failure the same way', () => {
    for (const failureClass of ['dns', 'server'] as const) {
      expect(
        classifyObservation(observe('product_url_reachable', 'fail', failureClass)),
        failureClass,
      ).toBe('temporary_outage');
    }
  });

  it('reads a blocked target as disallowed', () => {
    expect(classifyObservation(observe('product_url_public', 'fail', 'blocked'))).toBe('disallowed');
  });

  it('reads a skipped check as unknown rather than as a pass', () => {
    expect(classifyObservation(observe('deck_readable', 'skipped', 'none'))).toBe('unknown');
  });

  it('never reads a network failure as absent', () => {
    // Absent is the only outcome that can support a disqualification, so this
    // is the assertion that stops a slow host becoming a disqualified team.
    for (const failureClass of ['timeout', 'dns', 'server', 'auth', 'none'] as const) {
      expect(
        classifyObservation(observe('product_url_reachable', 'fail', failureClass)),
        failureClass,
      ).not.toBe('absent');
    }
  });
});

describe('folding several attempts', () => {
  it('lets a later success win', () => {
    // A site that answers is a site that answers. The earlier timeouts were
    // facts about the moment, not about the product.
    const folded = foldAttempts([
      observe('product_url_reachable', 'fail', 'timeout', 1),
      observe('product_url_reachable', 'fail', 'timeout', 2),
      observe('product_url_reachable', 'pass', 'none', 3),
    ]);

    expect(folded.get('product_url_reachable')?.outcome).toBe('satisfied');
    expect(folded.get('product_url_reachable')?.attempts).toBe(3);
  });

  it('keeps the worst when nothing ever succeeded', () => {
    const folded = foldAttempts([
      observe('product_url_present', 'fail', 'invalid', 1),
      observe('product_url_present', 'fail', 'invalid', 2),
    ]);
    expect(folded.get('product_url_present')?.outcome).toBe('absent');
  });

  it('prefers a temporary outage over a hard conclusion', () => {
    // Given both readings of the same check, the one that blames the network
    // wins — the system should be readier to doubt itself than the team.
    const folded = foldAttempts([
      observe('product_url_reachable', 'fail', 'invalid', 1),
      observe('product_url_reachable', 'fail', 'timeout', 2),
    ]);
    expect(folded.get('product_url_reachable')?.outcome).toBe('temporary_outage');
  });

  it('keeps the last attempt for the record', () => {
    const folded = foldAttempts([
      observe('deck_readable', 'fail', 'invalid', 1),
      observe('deck_readable', 'fail', 'timeout', 2),
    ]);
    expect(folded.get('deck_readable')?.last.attemptNumber).toBe(2);
  });

  it('handles no observations at all', () => {
    expect(foldAttempts([]).size).toBe(0);
  });
});

// --------------------------------------------------------------------------

function fold(entries: [PreflightCheckKey, PreflightOutcome][]) {
  return new Map(entries.map(([key, outcome]) => [key, { outcome, attempts: 1 }]));
}

/** Everything present and working. */
const ALL_GOOD = fold(PREFLIGHT_CHECKS.map((key) => [key, 'satisfied' as const]));

describe('deciding what happens next', () => {
  const context = { loginRequired: false, credentialsProvided: false };

  it('proceeds when everything is in order', () => {
    expect(decidePreflight(ALL_GOOD, context)).toEqual({ kind: 'proceed' });
  });

  it('proposes a disqualification only for something genuinely absent', () => {
    const missing = new Map(ALL_GOOD);
    missing.set('product_url_present', { outcome: 'absent', attempts: 1 });

    const verdict = decidePreflight(missing, context);
    expect(verdict.kind).toBe('propose_disqualification');
    expect(verdict).toMatchObject({ reasonCode: 'missing_product_url' });
  });

  it('names only permitted grounds', () => {
    const cases: [PreflightCheckKey, string][] = [
      ['product_url_present', 'missing_product_url'],
      ['deck_present', 'missing_pdf_deck'],
      ['demo_video_present', 'missing_demo_link'],
    ];

    for (const [key, reasonCode] of cases) {
      const missing = new Map(ALL_GOOD);
      missing.set(key, { outcome: 'absent', attempts: 1 });
      expect(decidePreflight(missing, context), key).toMatchObject({ reasonCode });
    }
  });

  it('sends an unreachable product to a human, never to a disqualification', () => {
    // `artifact_inaccessible_after_retries` exists as a ground, but a machine
    // reaching it alone would disqualify teams for their hosting.
    for (const outcome of ['temporary_outage', 'unknown', 'broken'] as const) {
      const down = new Map(ALL_GOOD);
      down.set('product_url_reachable', { outcome, attempts: 3 });

      const verdict = decidePreflight(down, context);
      expect(verdict.kind, outcome).toBe('manual_review');
      expect(verdict).toMatchObject({ reasonCode: 'app_unreachable' });
    }
  });

  it('sends a target we may not visit to a human', () => {
    const blocked = new Map(ALL_GOOD);
    blocked.set('product_url_public', { outcome: 'disallowed', attempts: 1 });

    const verdict = decidePreflight(blocked, context);
    expect(verdict.kind).toBe('manual_review');
    expect(verdict).toMatchObject({ reasonCode: 'target_not_permitted' });
  });

  it('decides a missing URL before it complains about anything downstream', () => {
    // Otherwise the verdict is a cascade of timeouts against a URL that was
    // never there, and the real reason is buried.
    const nothing = fold(PREFLIGHT_CHECKS.map((key) => [key, 'temporary_outage' as const]));
    nothing.set('product_url_present', { outcome: 'absent', attempts: 1 });

    expect(decidePreflight(nothing, context)).toMatchObject({
      reasonCode: 'missing_product_url',
    });
  });

  it('disqualifies a declared login with no credentials at all', () => {
    const verdict = decidePreflight(ALL_GOOD, {
      loginRequired: true,
      credentialsProvided: false,
    });
    expect(verdict).toMatchObject({
      kind: 'propose_disqualification',
      reasonCode: 'login_required_without_working_credentials',
    });
  });

  it('does not disqualify when credentials were supplied but unconfirmed', () => {
    // Unconfirmed is not the same as missing. The credentials may work when the
    // browser actually tries them.
    const unconfirmed = new Map(ALL_GOOD);
    unconfirmed.set('login_credentials_usable', { outcome: 'unknown', attempts: 1 });

    const verdict = decidePreflight(unconfirmed, {
      loginRequired: true,
      credentialsProvided: true,
    });
    expect(verdict.kind).toBe('proceed_degraded');
  });

  it('proceeds with a note when the deck could not be read', () => {
    // Judging continues on what can be seen, and the gap is recorded rather
    // than scored as though the deck were bad.
    const noDeck = new Map(ALL_GOOD);
    noDeck.set('deck_readable', { outcome: 'broken', attempts: 2 });

    const verdict = decidePreflight(noDeck, context);
    expect(verdict.kind).toBe('proceed_degraded');
    expect(verdict).toMatchObject({
      limitations: [expect.stringMatching(/deck could not be read/i)],
    });
  });

  it('proceeds with a note when the video could not be opened', () => {
    const noVideo = new Map(ALL_GOOD);
    noVideo.set('demo_video_reachable', { outcome: 'temporary_outage', attempts: 3 });

    expect(decidePreflight(noVideo, context)).toMatchObject({
      kind: 'proceed_degraded',
      limitations: [expect.stringMatching(/video/i)],
    });
  });
});

describe('what may support a disqualification', () => {
  it('is absence, and nothing else', () => {
    const outcomes: PreflightOutcome[] = [
      'satisfied',
      'absent',
      'broken',
      'temporary_outage',
      'unknown',
      'disallowed',
    ];
    const allowed = outcomes.filter(canSupportDisqualification);
    expect(allowed).toEqual(['absent']);
  });
});

describe('describing an outcome to a person', () => {
  it('says something plain for every case', () => {
    const outcomes: PreflightOutcome[] = [
      'satisfied',
      'absent',
      'broken',
      'temporary_outage',
      'unknown',
      'disallowed',
    ];
    for (const outcome of outcomes) {
      expect(describeOutcome(outcome).length, outcome).toBeGreaterThan(0);
    }
  });

  it('does not call a temporary outage a failure', () => {
    expect(describeOutcome('temporary_outage')).toMatch(/temporary/i);
    expect(describeOutcome('absent')).toMatch(/not submitted/i);
  });
});
