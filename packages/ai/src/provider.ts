/**
 * Provider-independent AI adapter.
 *
 * `AI_PROVIDER` / `AI_MODEL` / `AI_API_KEY` select an implementation at runtime.
 * No provider is hard-coded, and the `demo` provider returns deterministic
 * fixtures so demo mode needs no key at all.
 *
 * Every call declares a Zod schema and validates the response. Invalid output
 * is retried a bounded number of times and then degraded to low confidence —
 * never guessed at, and never allowed to reach the pipeline unvalidated.
 */

import type { z } from 'zod';
import { UNTRUSTED_CONTENT_INSTRUCTION } from './injection';

export type AiProviderName = 'demo' | 'anthropic' | 'openai' | 'custom';

export interface AiConfig {
  provider: AiProviderName;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxRetries: number;
  timeoutMs: number;
}

export interface AiRequest<T> {
  /** Prompt version, recorded on every artefact it produces. */
  promptVersion: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Anonymised submission id — never a team identifier. */
  correlationId: string;
  maxOutputTokens?: number;
}

export interface AiResponse<T> {
  data: T;
  modelVersion: string;
  promptVersion: string;
  usage: { inputTokens: number; outputTokens: number };
  /** True when validation failed on every attempt and a degraded result was used. */
  degraded: boolean;
  attempts: number;
}

export class AiError extends Error {
  override readonly name = 'AiError';
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly modelVersion: string;
  complete(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
    timeoutMs: number;
  }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

export class AiClient {
  constructor(
    private readonly provider: AiProvider,
    private readonly config: AiConfig,
  ) {}

  get modelVersion(): string {
    return this.provider.modelVersion;
  }

  /**
   * Run a structured-output call.
   *
   * The untrusted-content instruction is prepended to every system prompt here
   * rather than at call sites, so a new prompt cannot forget it.
   */
  async run<T>(request: AiRequest<T>): Promise<AiResponse<T>> {
    const system = `${UNTRUSTED_CONTENT_INSTRUCTION}\n\n${request.system}`;
    const attemptsAllowed = Math.max(1, this.config.maxRetries + 1);

    let lastError = '';
    let usage = { inputTokens: 0, outputTokens: 0 };

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      const user =
        attempt === 1
          ? request.user
          : `${request.user}\n\nYour previous response could not be parsed (${lastError}). Return ONLY valid JSON matching the required structure.`;

      let text: string;
      try {
        const result = await this.provider.complete({
          system,
          user,
          maxOutputTokens: request.maxOutputTokens ?? 4096,
          timeoutMs: this.config.timeoutMs,
        });
        text = result.text;
        usage = {
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          outputTokens: usage.outputTokens + result.usage.outputTokens,
        };
      } catch (error) {
        if (error instanceof AiError && !error.retryable) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === attemptsAllowed) {
          throw new AiError(`AI call failed after ${attempt} attempts: ${lastError}`, false);
        }
        continue;
      }

      const parsed = parseJsonResponse(text);
      if (!parsed.ok) {
        lastError = parsed.error;
        continue;
      }

      const validated = request.schema.safeParse(parsed.value);
      if (validated.success) {
        return {
          data: validated.data,
          modelVersion: this.provider.modelVersion,
          promptVersion: request.promptVersion,
          usage,
          degraded: false,
          attempts: attempt,
        };
      }

      lastError = validated.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
    }

    // Every attempt failed validation. Rather than guessing at a shape the
    // pipeline depends on, surface it — the caller degrades the stage to low
    // confidence and flags it for a human.
    throw new AiError(
      `AI response did not match the required structure after ${attemptsAllowed} attempts: ${lastError}`,
      false,
    );
  }
}

/**
 * Extract JSON from a model response.
 *
 * Models wrap JSON in prose or fences more often than they should; this is
 * tolerant of that without being tolerant of malformed data.
 */
export function parseJsonResponse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidates = [fenced?.[1]?.trim(), trimmed].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Fall through to the brace-slice attempt.
    }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
      } catch {
        // Try the next candidate.
      }
    }
  }

  return { ok: false, error: 'response was not valid JSON' };
}

// --------------------------------------------------------------------------
// Providers
// --------------------------------------------------------------------------

/** Anthropic Messages API. */
class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  readonly modelVersion: string;

  constructor(private readonly config: AiConfig) {
    this.modelVersion = config.model ?? 'claude-sonnet-5';
  }

  async complete(input: { system: string; user: string; maxOutputTokens: number; timeoutMs: number }) {
    const response = await fetchWithTimeout(
      `${this.config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.modelVersion,
          max_tokens: input.maxOutputTokens,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        }),
      },
      input.timeoutMs,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(
        `Anthropic returned ${response.status}: ${body.slice(0, 300)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const json = (await response.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
    };
  }
}

/** OpenAI-compatible chat completions — also covers most gateways. */
class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  readonly modelVersion: string;

  constructor(private readonly config: AiConfig) {
    this.modelVersion = config.model ?? 'gpt-4o';
  }

  async complete(input: { system: string; user: string; maxOutputTokens: number; timeoutMs: number }) {
    const response = await fetchWithTimeout(
      `${this.config.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey ?? ''}`,
        },
        body: JSON.stringify({
          model: this.modelVersion,
          max_tokens: input.maxOutputTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
      },
      input.timeoutMs,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(
        `Provider returned ${response.status}: ${body.slice(0, 300)}`,
        response.status === 429 || response.status >= 500,
      );
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: json.choices?.[0]?.message?.content ?? '',
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** Deterministic fixture provider. No key, no network, identical every run. */
export class DemoProvider implements AiProvider {
  readonly name = 'demo' as const;
  readonly modelVersion = 'demo-fixture-model-1';

  constructor(private readonly responder: (system: string, user: string) => unknown) {}

  async complete(input: { system: string; user: string }) {
    const value = this.responder(input.system, input.user);
    const text = JSON.stringify(value);
    return {
      text,
      // Rough character-based estimate; demo mode reports usage so the cost
      // panel has something realistic to show.
      usage: {
        inputTokens: Math.ceil((input.system.length + input.user.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiError(`AI request timed out after ${timeoutMs}ms`, true);
    }
    throw new AiError(error instanceof Error ? error.message : String(error), true);
  } finally {
    clearTimeout(timer);
  }
}

export function createAiClient(
  config: AiConfig,
  demoResponder?: (system: string, user: string) => unknown,
): AiClient {
  switch (config.provider) {
    case 'demo':
      if (!demoResponder) {
        throw new AiError('The demo provider requires a fixture responder.', false);
      }
      return new AiClient(new DemoProvider(demoResponder), config);
    case 'anthropic':
      requireKey(config);
      return new AiClient(new AnthropicProvider(config), config);
    case 'openai':
    case 'custom':
      requireKey(config);
      return new AiClient(new OpenAiProvider(config), config);
    default: {
      const exhaustive: never = config.provider;
      throw new AiError(`Unknown AI provider: ${String(exhaustive)}`, false);
    }
  }
}

function requireKey(config: AiConfig): void {
  if (!config.apiKey) {
    throw new AiError(
      `AI_API_KEY is required when AI_PROVIDER is "${config.provider}". Set DEMO_MODE=1 to run without one.`,
      false,
    );
  }
}
