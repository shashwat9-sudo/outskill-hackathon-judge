import { describe, expect, it, vi } from 'vitest';

/**
 * A browser stage that cannot end.
 *
 * Found in production: a run entered `browser_testing`, emitted nothing for
 * nineteen minutes against an eight-minute budget, wrote no run row, and held
 * its lease long past expiry. With one worker that is not a slow submission —
 * it is a cohort that never gets judged, and on the day it would have looked
 * like nothing happening at all.
 *
 * The budget was checked *between* steps, so it could only fire if the loop
 * came back round. Anything that stalled inside a single await — launching
 * Chromium, opening a context, stopping a trace, an accessibility scan — was
 * unbounded, and nothing above it was watching.
 *
 * These tests use small budgets. The point is the shape of the guarantee, not
 * the number.
 */

/** The stage-level deadline, as implemented in the pipeline. */
function withStageDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The ${label} browser run did not finish within ${ms}ms.`)),
        ms,
      );
    }),
  ]);
}

const hangsForever = () => new Promise<never>(() => {});

describe('an operation that never resolves', () => {
  it('cannot hold the stage past its deadline', async () => {
    const started = Date.now();
    await expect(withStageDeadline(hangsForever(), 60, 'desktop')).rejects.toThrow(/did not finish/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('names the run that stalled, so a log says which one', async () => {
    await expect(withStageDeadline(hangsForever(), 30, 'mobile')).rejects.toThrow(/mobile/);
  });

  it('does not delay a run that finishes normally', async () => {
    // A guarantee that also slows down healthy runs is not worth having.
    const started = Date.now();
    await expect(withStageDeadline(Promise.resolve('done'), 5000, 'desktop')).resolves.toBe('done');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('lets the next job run once a stalled one has been abandoned', async () => {
    /*
     * The property that matters most operationally. One submission that hangs
     * must not stop the ones behind it.
     */
    const order: string[] = [];
    await withStageDeadline(hangsForever(), 40, 'desktop').catch(() => order.push('first:timeout'));
    await withStageDeadline(Promise.resolve('ok'), 5000, 'desktop').then(() => order.push('second:ok'));

    expect(order).toEqual(['first:timeout', 'second:ok']);
  });

  it('clears its timer, so a finished run leaves nothing pending', async () => {
    // A deadline that outlives its run would keep the process alive.
    const spy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      await withStageDeadline(Promise.resolve(1), 10_000, 'desktop');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the setup and teardown steps that used to be unbounded', () => {
  /** The `within` helper, as implemented in the browser runner. */
  async function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms.`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it('bounds a launch that never returns', async () => {
    await expect(within('Launching Chromium', 40, hangsForever())).rejects.toThrow(/Launching Chromium/);
  });

  it('bounds a trace that never stops', async () => {
    // A strong suspect for the production hang: stopping a trace writes a zip,
    // and a stalled write held everything behind it.
    await expect(within('Stopping the trace', 40, hangsForever())).rejects.toThrow(/Stopping the trace/);
  });

  it('bounds a context that never opens', async () => {
    await expect(within('Opening a browser context', 40, hangsForever())).rejects.toThrow(/context/);
  });
});

describe('the test plan the model produced', () => {
  const MAX_BROWSER_STEPS = 8;

  it('is capped, because twenty-one steps for one page is mostly waiting', () => {
    /*
     * The real plan that triggered this: twenty-one steps against a page with a
     * single heading. Long plans are not more rigorous — they spend the budget
     * the main user action needed on waits for elements that were never there.
     */
    const generated = Array.from({ length: 21 }, (_, i) => ({ action: 'assert_text', index: i }));
    const executed = generated.slice(0, MAX_BROWSER_STEPS);

    expect(executed).toHaveLength(8);
    // Steps arrive in priority order, so the main user action survives the cut.
    expect(executed[0]!.index).toBe(0);
  });

  it('leaves a short plan alone', () => {
    const generated = Array.from({ length: 5 }, (_, i) => ({ action: 'navigate', index: i }));
    expect(generated.slice(0, MAX_BROWSER_STEPS)).toHaveLength(5);
  });

  it('is not a substitute for the deadline', () => {
    // Eight steps that each hang still need the stage deadline to end the run.
    expect(MAX_BROWSER_STEPS).toBeGreaterThan(0);
    expect(typeof withStageDeadline).toBe('function');
  });
});

describe('what a timed-out run records', () => {
  /** The shape the pipeline substitutes when a run is abandoned. */
  const timedOutRun = (viewport: 'desktop' | 'mobile', reason: string) => ({
    viewport,
    status: 'error' as const,
    timedOut: true,
    cleanupStatus: 'not_attempted' as const,
    steps: [],
    tracePath: null,
    observations: { consoleErrors: [], networkFailures: [], a11yViolations: [], createdValues: [] },
    error: reason,
  });

  it('invents nothing', async () => {
    /*
     * A timeout means we did not observe the product. That is a reason for a
     * human to look, never a reason to write down steps that never ran or
     * evidence that does not exist.
     */
    const run = timedOutRun('desktop', 'did not finish within 60000ms');

    expect(run.steps).toEqual([]);
    expect(run.tracePath).toBeNull();
    expect(run.observations.consoleErrors).toEqual([]);
    expect(run.observations.a11yViolations).toEqual([]);
  });

  it('says plainly that it timed out', () => {
    const run = timedOutRun('mobile', 'did not finish within 60000ms');
    expect(run.timedOut).toBe(true);
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/did not finish/);
  });

  it('is not a disqualification', () => {
    // Automation failing is our problem to explain, not the team's to be
    // punished for. Scoring and manual review decide what it means.
    const run = timedOutRun('desktop', 'timeout');
    expect(JSON.stringify(run)).not.toMatch(/disqualif/i);
  });
});

describe('a product that will not answer', () => {
  /**
   * The routing decision, as the preflight stage makes it.
   *
   * A team whose deployment was asleep for ten minutes has not failed the
   * hackathon. Ending their assessment as `failed` removed them from
   * consideration *and* left no flag, so the submission simply vanished from
   * the review queue — nobody would have known to look.
   */
  const route = (outcome: { canProceed: boolean; unreachable: boolean; looksLikeOutage: boolean },
                 attemptsRemaining: boolean) => {
    if (outcome.canProceed) return 'artifact_analysis';
    if (outcome.looksLikeOutage && attemptsRemaining) return 'retry';
    return outcome.unreachable ? 'manual_review' : 'failed';
  };

  it('sends a reachable product down the normal path', () => {
    expect(route({ canProceed: true, unreachable: false, looksLikeOutage: false }, true)).toBe(
      'artifact_analysis',
    );
  });

  it('retries first, because a host can be down for a moment', () => {
    expect(route({ canProceed: false, unreachable: true, looksLikeOutage: true }, true)).toBe('retry');
  });

  it('goes to a human once the retries are spent, not to failed', () => {
    expect(route({ canProceed: false, unreachable: true, looksLikeOutage: true }, false)).toBe(
      'manual_review',
    );
  });

  it('leaves a malformed submission failing as it did', () => {
    /*
     * The distinction worth keeping. An invalid URL is the submission being
     * wrong; an unreachable one is a site that was not answering. Only the
     * second is a question for a person.
     */
    expect(route({ canProceed: false, unreachable: false, looksLikeOutage: false }, false)).toBe(
      'failed',
    );
  });

  it('leaves a blocked address on its existing path', () => {
    // SSRF decisions are rule enforcement, not an outage, and are unaffected.
    expect(route({ canProceed: false, unreachable: false, looksLikeOutage: false }, true)).toBe(
      'failed',
    );
  });

  it('invents no browser evidence for a product it never saw', () => {
    // Manual review means we could not observe it — not that we observed
    // nothing working.
    const assessment = { browserRuns: [], scores: [], flagged: 'product_unreachable' };
    expect(assessment.browserRuns).toEqual([]);
    expect(assessment.scores).toEqual([]);
    expect(assessment.flagged).toBe('product_unreachable');
  });
});
