import { describe, expect, it } from 'vitest';
import { RUBRIC_CATEGORIES } from '@ohj/shared';
import { classifyBrowserOutcome } from './pipeline';

/**
 * A broken judge must never look like a broken product.
 *
 * F-15: a browser that never loaded the product still came back with 37/100 at
 * 0.83 confidence. Every category had been scored on the *absence* of evidence
 * — no working flow, no data persisted, no accessible controls — which is
 * exactly what a page that never rendered looks like. The team had built
 * something; our browser had not reached it.
 *
 * The guard exists in `pipeline.ts`, and until now the only test of it read the
 * source for a string. That would pass for a reason code sitting in a comment.
 * These drive the decision itself.
 */

describe('when the browser never reached the product', () => {
  /** Two viewports, neither of which got past `navigate`. */
  const neverLoaded = {
    desktop: {
      steps: [
        { action: 'navigate', status: 'failed', errorMessage: 'net::ERR_NAME_NOT_RESOLVED' },
        { action: 'screenshot', status: 'skipped', errorMessage: null },
      ],
    },
    mobile: {
      steps: [{ action: 'navigate', status: 'failed', errorMessage: 'net::ERR_NAME_NOT_RESOLVED' }],
    },
  };

  it('routes to manual review rather than to scoring', () => {
    const outcome = classifyBrowserOutcome(neverLoaded.desktop, neverLoaded.mobile);
    expect(outcome.navigationSucceeded).toBe(false);
    expect(outcome.nextStage).toBe('manual_review');
    expect(outcome.reasonCode).toBe('browser_never_reached_product');
  });

  it('says the failure may be ours, not the team’s', () => {
    // The wording matters: an operator reading this must not conclude the team
    // shipped nothing. It may equally be the host, the network, or us.
    const outcome = classifyBrowserOutcome(neverLoaded.desktop, neverLoaded.mobile);
    expect(outcome.detail).toContain('not a finding about the team');
    expect(outcome.detail).toContain('net::ERR_NAME_NOT_RESOLVED');
  });

  it('carries no score of any kind', () => {
    // The outcome type has no way to express a score, which is the strongest
    // form of this guarantee: routing to manual review cannot carry a mark
    // because there is nowhere to put one.
    const outcome = classifyBrowserOutcome(neverLoaded.desktop, neverLoaded.mobile);
    expect(Object.keys(outcome).sort()).toEqual([
      'detail',
      'navigationSucceeded',
      'nextStage',
      'reason',
      'reasonCode',
    ]);
    expect(JSON.stringify(outcome).toLowerCase()).not.toContain('score');
  });
});

describe('when the browser reached the product', () => {
  it('proceeds to evidence review even if every later step failed', () => {
    /*
     * The distinction this whole guard turns on.
     *
     * A page that loads and then does nothing useful IS a finding about the
     * product — the team shipped something that does not work. A page that
     * never loads is a finding about nothing. One navigate that passed is the
     * line between them.
     */
    const desktop = {
      steps: [
        { action: 'navigate', status: 'passed', errorMessage: null },
        { action: 'click', status: 'failed', errorMessage: 'Timeout 5000ms exceeded' },
        { action: 'assertText', status: 'failed', errorMessage: 'not found' },
      ],
    };
    const mobile = { steps: [{ action: 'navigate', status: 'passed', errorMessage: null }] };

    const outcome = classifyBrowserOutcome(desktop, mobile);
    expect(outcome.navigationSucceeded).toBe(true);
    expect(outcome.nextStage).toBe('evidence_review');
    expect(outcome.reasonCode).toBeNull();
  });

  it('accepts one viewport succeeding where the other failed', () => {
    // A product that renders on desktop and not on mobile is a real, scoreable
    // weakness — not an infrastructure failure.
    const desktop = { steps: [{ action: 'navigate', status: 'passed', errorMessage: null }] };
    const mobile = {
      steps: [{ action: 'navigate', status: 'failed', errorMessage: 'viewport crash' }],
    };

    expect(classifyBrowserOutcome(desktop, mobile).nextStage).toBe('evidence_review');
    expect(classifyBrowserOutcome(mobile, desktop).nextStage).toBe('evidence_review');
  });
});

describe('the rubric this all feeds', () => {
  it('is the eight agreed categories at the agreed weights', () => {
    // Pinned individually, not just summed. A pair of categories that drifted
    // in opposite directions would still total 100 and would still be wrong.
    expect(
      RUBRIC_CATEGORIES.map((category) => [category.key, category.maxPoints]),
    ).toEqual([
      ['problem_clarity', 15],
      ['solution_usefulness', 15],
      ['core_workflow', 25],
      ['ease_of_use', 10],
      ['ai_usefulness', 15],
      ['two_day_execution', 10],
      ['deck_demo', 5],
      ['practical_potential', 5],
    ]);
  });

  it('totals exactly 100', () => {
    expect(RUBRIC_CATEGORIES.reduce((sum, c) => sum + c.maxPoints, 0)).toBe(100);
  });
});
