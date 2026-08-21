import { describe, expect, it } from 'vitest';
import {
  assertDispatchAllowed,
  canDispatchToProvider,
  describeProviderStatus,
  type WorkerReport,
  EvaluationModeError,
  type DispatchSubject,
} from './evaluation-mode';

/**
 * What the external model is allowed to see.
 *
 * The product is being evaluated on a free AI tier, and free tiers carry the
 * least protective data terms a provider offers. A learner's pitch deck should
 * not be the thing that discovers this, so real work is refused rather than
 * warned about.
 */

const DEMO: DispatchSubject = {
  isDemoCohort: true,
  isSyntheticSubmission: true,
  cohortName: 'Demo cohort',
  correlationId: 'anon-1',
};

const REAL: DispatchSubject = {
  isDemoCohort: false,
  isSyntheticSubmission: false,
  cohortName: 'AI Accelerator — August',
  correlationId: 'anon-2',
};

describe('synthetic_only', () => {
  it('allows a synthetic submission in a demo cohort', () => {
    expect(canDispatchToProvider('synthetic_only', DEMO)).toEqual({ allowed: true });
  });

  it('refuses real learner work', () => {
    const decision = canDispatchToProvider('synthetic_only', REAL);
    expect(decision.allowed).toBe(false);
  });

  it('refuses a synthetic submission that lives in a real cohort', () => {
    // It sits in a database full of real ones, and the next change that widens
    // "synthetic" by a little would start sending them.
    const decision = canDispatchToProvider('synthetic_only', {
      ...REAL,
      isSyntheticSubmission: true,
    });
    expect(decision.allowed).toBe(false);
  });

  it('refuses real work that somehow appears in a demo cohort', () => {
    const decision = canDispatchToProvider('synthetic_only', {
      ...DEMO,
      isSyntheticSubmission: false,
    });
    expect(decision.allowed).toBe(false);
  });

  it('says plainly that nothing was sent', () => {
    // The first question an operator asks when they see a refusal.
    const decision = canDispatchToProvider('synthetic_only', REAL);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toMatch(/Nothing was sent to the AI provider/i);
  });

  it('names the cohort it protected', () => {
    const decision = canDispatchToProvider('synthetic_only', REAL);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toContain('AI Accelerator — August');
  });

  it('tells the operator exactly what to change, and what to check first', () => {
    const decision = canDispatchToProvider('synthetic_only', REAL);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.operatorAction).toContain('AI_EVALUATION_MODE=production');
    expect(decision.operatorAction).toMatch(/data-retention/i);
  });
});

describe('production', () => {
  it('allows real work', () => {
    expect(canDispatchToProvider('production', REAL)).toEqual({ allowed: true });
  });

  it('still allows demo work', () => {
    expect(canDispatchToProvider('production', DEMO)).toEqual({ allowed: true });
  });
});

describe('the guard the pipeline calls', () => {
  it('throws rather than returning a value that could be ignored', () => {
    // A boolean return would eventually be called without being checked.
    expect(() => assertDispatchAllowed('synthetic_only', REAL)).toThrow(EvaluationModeError);
  });

  it('passes silently when dispatch is allowed', () => {
    expect(() => assertDispatchAllowed('synthetic_only', DEMO)).not.toThrow();
    expect(() => assertDispatchAllowed('production', REAL)).not.toThrow();
  });

  it('carries the anonymised id, never a team identifier', () => {
    try {
      assertDispatchAllowed('synthetic_only', REAL);
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(EvaluationModeError);
      expect((error as EvaluationModeError).correlationId).toBe('anon-2');
    }
  });
});

describe('what the operator is shown', () => {
  /**
   * These describe the *worker*, because the worker is what judges.
   *
   * They used to describe the web application's own AI environment. That is
   * not a weaker signal about judging, it is no signal: the web tier never
   * constructs an AI client, and on a real deployment it holds no AI key at
   * all — so the only states it could ever report were the two meaning
   * "judging is not real". A production cohort being judged against real
   * Gemini was captioned "Demo fixtures — no AI provider" while these tests
   * passed.
   */
  const worker: WorkerReport = {
    workerId: 'railway-judging-worker-1',
    aiProvider: 'gemini',
    aiModel: 'gemini-2.5-flash-lite',
    evaluationMode: 'synthetic_only',
    demoMode: false,
    lastSeenAt: new Date('2026-08-21T12:00:00Z'),
  };
  const NOW = new Date('2026-08-21T12:01:00Z');

  /** A web tier with no AI configuration of its own — the production shape. */
  const base = {
    provider: 'demo',
    model: undefined,
    hasApiKey: false,
    evaluationMode: 'synthetic_only' as const,
    demoMode: false,
    now: NOW,
  };

  const describe_ = (over: Partial<typeof worker> = {}) =>
    describeProviderStatus({ ...base, worker: { ...worker, ...over } });

  it('reports production judging even though this tier has no AI key', () => {
    /*
     * The exact production configuration. The web tier is `AI_PROVIDER=demo`
     * with no key — which is correct, it needs none — and the worker is on
     * Gemini in production mode. The old code read the former and called it
     * demo fixtures.
     */
    const status = describe_({ evaluationMode: 'production' });

    expect(status.readiness).toBe('production_judging');
    expect(status.canJudgeRealCohort).toBe(true);
    expect(status.label).not.toContain('Demo fixtures');
  });

  it('distinguishes no worker from demo fixtures', () => {
    // Different situations with different next steps. "AI not working" would
    // describe both and help with neither.
    expect(describe_({ demoMode: true }).readiness).toBe('demo_fixtures');
    expect(describe_({ aiProvider: 'demo' }).readiness).toBe('demo_fixtures');
    expect(describeProviderStatus({ ...base, worker: null }).readiness).toBe('no_worker');
  });

  it('distinguishes internal evaluation from production judging', () => {
    expect(describe_().readiness).toBe('synthetic_only');
    expect(describe_({ evaluationMode: 'production' }).readiness).toBe('production_judging');
  });

  it('recognises a local model', () => {
    const status = describe_({ aiProvider: 'ollama', aiModel: 'llama3' });
    expect(status.readiness).toBe('local_model');
    expect(status.detail).toMatch(/nothing is charged/i);
  });

  it('never says a real cohort can be judged when it cannot', () => {
    // The flag the "Start judging" control reads.
    expect(describe_().canJudgeRealCohort).toBe(false);
    expect(describe_({ demoMode: true }).canJudgeRealCohort).toBe(false);
    expect(describeProviderStatus({ ...base, worker: null }).canJudgeRealCohort).toBe(false);
    expect(describe_({ evaluationMode: 'production' }).canJudgeRealCohort).toBe(true);
  });

  it('warns that production judging costs money', () => {
    const status = describe_({ evaluationMode: 'production' });
    expect(status.detail).toMatch(/incurs cost/i);
    expect(status.tone).toBe('warning');
  });

  it('names the model, so nobody has to guess which one is running', () => {
    expect(describe_().label).toContain('gemini-2.5-flash-lite');
  });

  it('says submissions are safe when no worker has ever reported', () => {
    const status = describeProviderStatus({ ...base, worker: null });
    expect(status.detail).toMatch(/stay queued/i);
  });

  it('says so when a worker reported and then went quiet', () => {
    /*
     * Not the same as no worker, and not the same as a healthy one. This is
     * the state where queued work silently stops moving, which is the failure
     * an operator most needs to see before a deadline.
     */
    const status = describeProviderStatus({
      ...base,
      worker: { ...worker, evaluationMode: 'production', lastSeenAt: new Date('2026-08-21T11:00:00Z') },
    });

    expect(status.readiness).toBe('worker_stale');
    expect(status.canJudgeRealCohort).toBe(false);
    expect(status.detail).toMatch(/nothing is being judged/i);
  });

  it('does not call a busy worker missing', () => {
    // Longer than a poll interval, shorter than one slow browser assessment.
    const status = describeProviderStatus({
      ...base,
      worker: { ...worker, evaluationMode: 'production', lastSeenAt: new Date('2026-08-21T11:50:00Z') },
    });

    expect(status.readiness).toBe('production_judging');
  });

  it('still describes the local process in single-process demo mode', () => {
    // No separate worker exists to report, so there is nothing else to read.
    const status = describeProviderStatus({ ...base, demoMode: true, worker: null });
    expect(status.readiness).toBe('demo_fixtures');
  });
});
