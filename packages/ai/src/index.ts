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
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL,
    maxRetries: env.AI_MAX_RETRIES,
    timeoutMs: env.AI_TIMEOUT_MS,
  };

  return createAiClient(config, demoResponder);
}
