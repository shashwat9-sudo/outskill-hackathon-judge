import { describe, expect, it } from 'vitest';
import {
  assertDispatchAllowed,
  canDispatchToProvider,
  describeProviderStatus,
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
  const base = {
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
    hasApiKey: true,
    evaluationMode: 'synthetic_only' as const,
    demoMode: false,
  };

  it('distinguishes no provider from demo fixtures', () => {
    // Different situations with different next steps. "AI not working" would
    // describe both and help with neither.
    expect(describeProviderStatus({ ...base, demoMode: true }).readiness).toBe('demo_fixtures');
    expect(describeProviderStatus({ ...base, hasApiKey: false }).readiness).toBe('no_provider');
  });

  it('distinguishes internal evaluation from production judging', () => {
    expect(describeProviderStatus(base).readiness).toBe('synthetic_only');
    expect(describeProviderStatus({ ...base, evaluationMode: 'production' }).readiness).toBe(
      'production_judging',
    );
  });

  it('recognises a local model', () => {
    const status = describeProviderStatus({ ...base, provider: 'ollama', hasApiKey: false });
    expect(status.readiness).toBe('local_model');
    expect(status.detail).toMatch(/nothing is charged/i);
  });

  it('never says a real cohort can be judged when it cannot', () => {
    // The flag the "Start judging" control reads. A key existing is not the
    // same as judging being safe.
    expect(describeProviderStatus(base).canJudgeRealCohort).toBe(false);
    expect(describeProviderStatus({ ...base, demoMode: true }).canJudgeRealCohort).toBe(false);
    expect(describeProviderStatus({ ...base, hasApiKey: false }).canJudgeRealCohort).toBe(false);
    expect(
      describeProviderStatus({ ...base, evaluationMode: 'production' }).canJudgeRealCohort,
    ).toBe(true);
  });

  it('warns that production judging costs money', () => {
    const status = describeProviderStatus({ ...base, evaluationMode: 'production' });
    expect(status.detail).toMatch(/incur cost/i);
    expect(status.tone).toBe('warning');
  });

  it('names the model, so nobody has to guess which one is running', () => {
    expect(describeProviderStatus(base).label).toContain('gemini-2.5-flash-lite');
  });

  it('says submissions are safe when no provider is configured', () => {
    const status = describeProviderStatus({ ...base, hasApiKey: false });
    expect(status.detail).toMatch(/stored safely/i);
  });
});
