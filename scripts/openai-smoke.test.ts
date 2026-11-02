import { describe, expect, it } from 'vitest';
import { DEFAULT_SMOKE_MODEL, resolveSmokeModel } from './openai-smoke';

/**
 * The smoke test must name the model being promoted, explicitly. A hard-coded
 * previous model would pass against the old model and say nothing about the
 * new one.
 */
describe('smoke-test model selection', () => {
  it('defaults to the model production is moving to', () => {
    expect(DEFAULT_SMOKE_MODEL).toBe('gpt-6.1-sol');
    expect(resolveSmokeModel([], {})).toBe('gpt-6.1-sol');
  });

  it('takes an explicit flag over the environment', () => {
    expect(resolveSmokeModel(['--model', 'gpt-5.6-terra'], { AI_MODEL: 'gpt-6.1-sol' })).toBe('gpt-5.6-terra');
    expect(resolveSmokeModel(['--model=gpt-5.6-terra'], {})).toBe('gpt-5.6-terra');
  });

  it('takes AI_MODEL when no flag is given, so `railway run` tests the deployed pin', () => {
    expect(resolveSmokeModel([], { AI_MODEL: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol');
    expect(resolveSmokeModel([], { AI_MODEL: '  ' })).toBe(DEFAULT_SMOKE_MODEL);
  });
});
