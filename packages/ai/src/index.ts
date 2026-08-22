/**
 * @ohj/ai — the only place in the system that talks to a model.
 *
 * Everything crossing the provider boundary passes through here, so redaction,
 * injection containment, schema validation and version stamping happen in one
 * place rather than at every call site.
 */

export * from './provider';
export * from './schemas';
export * from './prompts';
export * from './redaction';
export * from './injection';
export * from './evaluation-mode';
export * from './schema-shape';
export { demoResponder } from './demo-responder';

import { createAiClient, type AiClient, type AiConfig } from './provider';
import { demoResponder } from './demo-responder';

/** Build a client from validated environment configuration. */
export function createAiClientFromEnv(env: {
  AI_PROVIDER: 'demo' | 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom';
  AI_MODEL?: string;
  AI_API_KEY?: string;
  /**
   * Provider-specific keys, preferred over the generic one.
   *
   * Both can be present at once, which is the point: a migration keeps the
   * outgoing provider's key exactly where it was, so rolling back is a change
   * to AI_PROVIDER and nothing else.
   */
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MAX_RETRIES: number;
  AI_TIMEOUT_MS: number;
  DEMO_MODE: boolean;
}): AiClient {
  // Demo mode never reaches a provider, regardless of what AI_PROVIDER says —
  // so a stray key in a local .env cannot cause an accidental live call.
  const provider = env.DEMO_MODE ? 'demo' : env.AI_PROVIDER;

  const config: AiConfig = {
    provider,
    model: env.AI_MODEL,
    apiKey: resolveApiKey(provider, env),
    baseUrl: env.AI_BASE_URL,
    maxRetries: env.AI_MAX_RETRIES,
    timeoutMs: env.AI_TIMEOUT_MS,
  };

  return createAiClient(config, demoResponder);
}

/**
 * The key for the provider actually selected.
 *
 * Mirrors `providerApiKey` in the shared config, which validates the same rule
 * at load time. Kept here too rather than imported, because this package is
 * consumed independently of the shared config loader and must not silently
 * depend on it.
 *
 * OpenAI takes no fallback. Everything else still may.
 *
 * The asymmetry is deliberate and is the point. `AI_API_KEY` holds the Gemini
 * key on the production worker, kept there so a rollback is a change to
 * AI_PROVIDER and nothing else. A generic fallback would therefore mean that a
 * missing OPENAI_API_KEY sends *the Gemini key to OpenAI* — a 401 whose text
 * says nothing about the real mistake, arriving during a live judging batch,
 * and one attempt away from someone "fixing" it by pasting a key into the
 * wrong variable.
 *
 * Gemini keeps reading AI_API_KEY because that is where its working key
 * already is, and this migration must not require touching it.
 */
function resolveApiKey(
  provider: string,
  env: {
    AI_API_KEY?: string;
    OPENAI_API_KEY?: string;
    GEMINI_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
  },
): string | undefined {
  if (provider === 'openai') return env.OPENAI_API_KEY;

  const specific =
    provider === 'gemini'
      ? env.GEMINI_API_KEY
      : provider === 'anthropic'
        ? env.ANTHROPIC_API_KEY
        : undefined;
  return specific || env.AI_API_KEY;
}
