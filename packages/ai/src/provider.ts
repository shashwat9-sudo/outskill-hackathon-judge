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
import { schemaInstruction } from './schema-shape';
import { stripNulls, toStrictJsonSchema, type JsonSchemaObject } from './json-schema';

export type AiProviderName = 'demo' | 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom';

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
  /** Names the schema in the provider request. Diagnostic only. */
  schemaName?: string;
}

/**
 * Token accounting for one `run`, summed across every attempt it made.
 *
 * `cachedInputTokens` is reported by providers that bill cached prompt prefixes
 * differently and is zero elsewhere — it is a subset of `inputTokens`, not an
 * addition to it, so totalling them would double-count. `requests` is the
 * number of HTTP calls actually made, which is what a rate limit is measured
 * against and is not the same as `attempts` when a retry is swallowed.
 */
export interface AiUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface AiResponse<T> {
  data: T;
  modelVersion: string;
  promptVersion: string;
  usage: AiUsage;
  /** True when validation failed on every attempt and a degraded result was used. */
  degraded: boolean;
  attempts: number;
}

export class AiError extends Error {
  override readonly name = 'AiError';
  constructor(
    message: string,
    readonly retryable: boolean,
    /**
     * The provider's own `Retry-After`, in milliseconds, when it sent one.
     *
     * Null means "we are guessing", and the caller backs off exponentially
     * instead. A 429 that names its window is the one case where waiting the
     * stated time is better than any schedule we could invent.
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/**
 * Read `Retry-After`, which may be seconds or an HTTP date.
 *
 * Returns null for anything unparseable rather than a default, so a malformed
 * header falls through to exponential backoff instead of pinning the wait to a
 * number nobody sent.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export interface AiCompletion {
  text: string;
  usage: { inputTokens: number; cachedInputTokens?: number; outputTokens: number };
  /**
   * True when the provider constrained decoding to the supplied JSON Schema.
   *
   * Read by `AiClient` to decide whether to strip nulls before validating: a
   * strict schema expresses "absent" as an explicit null, and a prompt-guided
   * one expresses it as a missing key. Reported by the provider rather than
   * assumed by the caller, because a provider may decline the schema.
   */
  usedStrictSchema?: boolean;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly modelVersion: string;
  complete(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
    timeoutMs: number;
    /**
     * The response schema, when it could be expressed strictly. Providers that
     * cannot constrain decoding ignore it — the prompt already describes the
     * shape and Zod still validates, so ignoring it costs nothing.
     */
    jsonSchema?: JsonSchemaObject | null;
    schemaName?: string;
  }): Promise<AiCompletion>;
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

  /** Which provider is behind this client. Read by the dispatch guard. */
  get providerName(): AiProviderName {
    return this.provider.name;
  }

  /**
   * Run a structured-output call.
   *
   * Two things are attached here rather than at call sites, so a new prompt
   * cannot forget either: the untrusted-content instruction, and the shape of
   * the schema the response will be validated against.
   *
   * The schema description was added after the first real provider run failed
   * three times with `deck: Required; written: Required; risks: Required`. The
   * prompt had asked for "valid JSON matching the required structure" without
   * ever stating the structure, so the model was being marked wrong for not
   * guessing field names. Generating it from the schema keeps the prompt and
   * the validator from drifting apart.
   */
  async run<T>(request: AiRequest<T>): Promise<AiResponse<T>> {
    const system = [
      UNTRUSTED_CONTENT_INSTRUCTION,
      request.system,
      schemaInstruction(request.schema as unknown as z.ZodTypeAny),
    ].join('\n\n');
    const attemptsAllowed = Math.max(1, this.config.maxRetries + 1);

    /*
     * Offered to the provider, not required by it. A provider that can
     * constrain decoding to this cannot return the wrong shape at all; one
     * that cannot ignores it and relies on the prompt, exactly as before.
     * Null here means the schema could not be expressed faithfully — see
     * `toStrictJsonSchema`, which refuses rather than approximating.
     */
    const jsonSchema = toStrictJsonSchema(request.schema as unknown as z.ZodTypeAny);

    let lastError = '';
    let usage: AiUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      requests: 0,
    };

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
      const user =
        attempt === 1
          ? request.user
          : `${request.user}\n\nYour previous response was rejected: ${lastError}\n\n` +
            'Return ONLY the JSON object described in the system instructions, with every ' +
            'required field present.';

      let text: string;
      let strict = false;
      try {
        const result = await this.provider.complete({
          system,
          user,
          maxOutputTokens: request.maxOutputTokens ?? 4096,
          timeoutMs: this.config.timeoutMs,
          jsonSchema,
          schemaName: request.schemaName ?? 'judging_response',
        });
        text = result.text;
        strict = result.usedStrictSchema === true;
        usage = {
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens + (result.usage.cachedInputTokens ?? 0),
          outputTokens: usage.outputTokens + result.usage.outputTokens,
          requests: usage.requests + 1,
        };
      } catch (error) {
        if (error instanceof AiError && !error.retryable) throw error;
        usage = { ...usage, requests: usage.requests + 1 };
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === attemptsAllowed) {
          throw new AiError(`AI call failed after ${attempt} attempts: ${lastError}`, false);
        }
        /*
         * Wait before trying again.
         *
         * This loop used to retry immediately. Against a rate limit that is
         * worse than not retrying: three calls land inside the same window, all
         * three are refused, and the job fails having done nothing but add load
         * at the moment the provider asked for less. A `Retry-After` is obeyed
         * when the provider sends one, because it knows when the window opens
         * and we are guessing.
         */
        await sleep(backoffMs(attempt, error));
        continue;
      }

      /*
       * A strictly-constrained response says "nothing here" with an explicit
       * null, because strict mode requires every key to be present. Zod's
       * `.optional()` means a key may be absent and rejects a null, so without
       * this every plan step carrying `"nth": null` would fail validation and
       * burn the attempt budget on a response that was correct.
       */
      const parsed = strict
        ? mapParsed(parseJsonResponse(text), stripNulls)
        : parseJsonResponse(text);
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

/** Apply a transform to a successful parse, leaving a failure untouched. */
function mapParsed(
  parsed: { ok: true; value: unknown } | { ok: false; error: string },
  fn: (value: unknown) => unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  return parsed.ok ? { ok: true, value: fn(parsed.value) } : parsed;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Longest a single backoff will wait, so a retry cannot outlive the stage. */
const MAX_BACKOFF_MS = 20_000;

/**
 * How long to wait before retrying attempt `attempt`.
 *
 * Exponential with jitter. The jitter is not decoration: a worker retrying a
 * batch on a fixed schedule re-synchronises every one of its calls onto the
 * same instant, which is how a transient rate limit becomes a persistent one.
 *
 * A provider's own `Retry-After` wins outright — it knows when the window
 * reopens and this does not.
 */
export function backoffMs(attempt: number, error: unknown): number {
  if (error instanceof AiError && error.retryAfterMs !== null) {
    return Math.min(error.retryAfterMs, MAX_BACKOFF_MS);
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(base * (0.5 + Math.random() * 0.5));
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

/**
 * OpenAI Responses API.
 *
 * Its own adapter rather than a variant of the chat-completions one, for three
 * reasons that each bite differently.
 *
 * The request shape differs: `input` rather than `messages`,
 * `max_output_tokens` rather than `max_tokens`. That last one is not cosmetic —
 * newer models reject `max_tokens` outright, so the old adapter would have
 * failed every call with a 400 that reads like a configuration mistake.
 *
 * Structured Outputs is here rather than JSON mode. JSON mode guarantees only
 * that the response parses; it can be `{}`. A strict schema constrains decoding
 * to the shape the pipeline needs, which turns "the model omitted six fields
 * three times running" from a retry loop into something that cannot happen.
 *
 * And the response is a list of output items, not a single message. Reasoning
 * models put reasoning items in that list, so taking the first item's text
 * would read an empty string on exactly the models most worth using — the text
 * has to be gathered from the message items specifically.
 */
class OpenAiResponsesProvider implements AiProvider {
  readonly name = 'openai' as const;
  readonly modelVersion: string;

  constructor(private readonly config: AiConfig) {
    /*
     * No default model.
     *
     * A default here would let a missing AI_MODEL judge an entire cohort on
     * some other model, consistently and invisibly, and the scores would look
     * exactly as plausible. Judging consistency is the whole reason the batch
     * pins one model, so this refuses instead.
     */
    if (!config.model) {
      throw new AiError('AI_MODEL must be set when AI_PROVIDER is "openai".', false);
    }
    this.modelVersion = config.model;
  }

  async complete(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
    timeoutMs: number;
    jsonSchema?: JsonSchemaObject | null;
    schemaName?: string;
  }): Promise<AiCompletion> {
    const strict = Boolean(input.jsonSchema);

    const body: Record<string, unknown> = {
      model: this.modelVersion,
      input: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      max_output_tokens: input.maxOutputTokens,
      text: strict
        ? {
            format: {
              type: 'json_schema',
              name: input.schemaName ?? 'judging_response',
              schema: input.jsonSchema,
              strict: true,
            },
          }
        : { format: { type: 'json_object' } },
    };

    const response = await fetchWithTimeout(
      `${this.config.baseUrl ?? 'https://api.openai.com'}/v1/responses`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey ?? ''}`,
        },
        body: JSON.stringify(body),
      },
      input.timeoutMs,
    );

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new AiError(
        `OpenAI returned ${response.status}: ${redactKeyish(raw).slice(0, 300)}`,
        /*
         * 429 and 5xx are worth another attempt; 400, 401, 403 and 404 are not.
         * A bad key, an exhausted quota or a model this project cannot reach
         * will answer identically however many times it is asked, and retrying
         * only delays the operator finding out.
         */
        response.status === 429 || response.status >= 500,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    const json = (await response.json()) as OpenAiResponseBody;

    /*
     * An incomplete response is a failure, not a short answer.
     *
     * Hitting the output ceiling truncates mid-JSON, and the parse would fail
     * anyway — but with "response was not valid JSON", which sends whoever
     * reads it looking for a prompt problem. Saying which limit was hit costs
     * nothing and is the difference between a five-minute fix and an hour.
     */
    if (json.status === 'incomplete') {
      throw new AiError(
        `OpenAI stopped early (${json.incomplete_details?.reason ?? 'unknown reason'}).`,
        false,
      );
    }
    if (json.status === 'failed') {
      throw new AiError(
        `OpenAI reported failure: ${json.error?.message ?? 'no reason given'}`,
        false,
      );
    }

    const text = extractOutputText(json);
    if (!text.trim()) {
      // A 200 with no text at all. Scoring a submission on this would produce a
      // mark from nothing, so it is an error rather than an empty completion.
      throw new AiError('OpenAI returned no output text.', true);
    }

    return {
      text,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        cachedInputTokens: json.usage?.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
      usedStrictSchema: strict,
    };
  }
}

interface OpenAiResponseBody {
  status?: string;
  error?: { message?: string };
  incomplete_details?: { reason?: string };
  output_text?: string;
  output?: {
    type?: string;
    content?: { type?: string; text?: string }[];
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Gather the assistant's text from a Responses payload.
 *
 * `output` is a list of items and only the `message` ones carry text a caller
 * should read. Reasoning items sit alongside them, so indexing into the list
 * reads an empty string on a reasoning model — which would then be scored as an
 * unparseable response rather than a configuration problem.
 *
 * `output_text` is the SDK's convenience field and is preferred when present.
 */
export function extractOutputText(json: OpenAiResponseBody): string {
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text;

  return (json.output ?? [])
    .filter((item) => item.type === 'message' || item.type === undefined)
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === 'output_text' || part.type === undefined)
    .map((part) => part.text ?? '')
    .join('');
}

/**
 * Remove anything key-shaped from provider text before it is put in an error.
 *
 * Error bodies are echoed into `last_error` on the job, into logs and into
 * operator reports. Providers do not normally quote your credential back at
 * you, but "normally" is not a property worth relying on for a value that must
 * never be written down — and the cost of being wrong is a key in a database
 * column and a chat window.
 */
export function redactKeyish(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]');
}

/** OpenAI-compatible chat completions — covers gateways and self-hosted clones. */
class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'custom' as const;
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
        `Provider returned ${response.status}: ${redactKeyish(body).slice(0, 300)}`,
        response.status === 429 || response.status >= 500,
        parseRetryAfter(response.headers.get('retry-after')),
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


/**
 * Google Gemini (Generative Language API).
 *
 * Worth its own adapter rather than reuse of the OpenAI one: the request shape
 * is different (`contents` / `parts`, `systemInstruction` as its own field),
 * the key travels in a header rather than a bearer token, and — the part that
 * matters for judging — it can return a 200 with no text at all when a
 * response is stopped by a safety filter or the token ceiling. Treating that
 * as an empty completion would score a submission on nothing, so it is turned
 * into a typed error.
 *
 * `responseMimeType: application/json` asks for JSON directly, which is
 * belt-and-braces with the parsing in `AiClient` rather than a replacement for
 * it: the model can still return prose, and the schema still has to validate.
 */
class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  readonly modelVersion: string;

  constructor(private readonly config: AiConfig) {
    // Not defaulted to a paid model. The caller chooses via AI_MODEL, and this
    // fallback is the current free-tier one.
    this.modelVersion = config.model ?? 'gemini-2.5-flash-lite';
  }

  async complete(input: { system: string; user: string; maxOutputTokens: number; timeoutMs: number }) {
    const base = this.config.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const url = `${base}/v1beta/models/${encodeURIComponent(this.modelVersion)}:generateContent`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Header rather than a query parameter: a key in a URL ends up in
          // access logs, proxy logs and error messages.
          'x-goog-api-key': this.config.apiKey ?? '',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: {
            maxOutputTokens: input.maxOutputTokens,
            responseMimeType: 'application/json',
            // Judging must be as reproducible as the provider allows. Two runs
            // of the same submission should not disagree because of sampling.
            temperature: 0,
          },
        }),
      },
      input.timeoutMs,
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AiError(
        `Gemini returned ${response.status}: ${describeGeminiError(response.status, body)}`,
        // 429 is retryable in general, but free-tier daily exhaustion is not —
        // retrying it just burns the remaining quota faster.
        (response.status === 429 && !isQuotaExhausted(body)) || response.status >= 500,
      );
    }

    const json = (await response.json()) as GeminiResponse;
    const candidate = json.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    if (!text.trim()) {
      // A 200 with no text. The reason decides whether retrying is sensible.
      const reason = candidate?.finishReason ?? json.promptFeedback?.blockReason ?? 'unknown';
      throw new AiError(
        `Gemini returned no text (finish reason: ${reason}). ` +
          (reason === 'MAX_TOKENS'
            ? 'The response hit the output ceiling before producing anything usable.'
            : 'This is usually a safety filter or a blocked prompt.'),
        reason === 'MAX_TOKENS' || reason === 'unknown',
      );
    }

    return {
      text,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/** Free-tier exhaustion looks like a rate limit but retrying cannot fix it. */
export function isQuotaExhausted(body: string): boolean {
  return /RESOURCE_EXHAUSTED|quota|billing|exceeded your current quota/i.test(body);
}

/**
 * Turn a provider error into something an operator can act on.
 *
 * The raw body is a wall of JSON at 23:50. These are the four cases that
 * actually happen, and each has a different next step.
 */
export function describeGeminiError(status: number, body: string): string {
  if (status === 429 && isQuotaExhausted(body)) {
    return (
      'the free quota for this model is exhausted. Wait for the quota to reset, ' +
      'switch AI_MODEL to another free-tier model, or enable billing.'
    );
  }
  if (status === 429) return 'rate limited — too many requests in a short window.';
  if (status === 400 && /API key not valid/i.test(body)) {
    return 'the API key was rejected. Check AI_API_KEY.';
  }
  if (status === 404) {
    // The provider's own message is kept rather than replaced. A 404 here has
    // several quite different causes — a typo, a retired model, or a model that
    // is listed but closed to new keys — and only Google knows which. The first
    // real run hit the third: `gemini-2.5-flash-lite` appears in ListModels and
    // still refuses new users, so a generic "check AI_MODEL" sent the operator
    // to verify a name that was already correct.
    const detail = extractMessage(body);
    return (
      `the model "${extractModel(body)}" could not be used. ` +
      (detail ? `Google says: ${detail} ` : '') +
      'Set AI_MODEL to one your key can reach.'
    );
  }
  if (status === 403) return 'the key is not permitted to use this model or the API is not enabled.';
  return body.slice(0, 300);
}

function extractMessage(body: string): string {
  try {
    return String((JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '');
  } catch {
    return '';
  }
}

function extractModel(body: string): string {
  return /models\/([\w.-]+)/.exec(body)?.[1] ?? 'unknown';
}

/**
 * Ollama — a model running on this machine.
 *
 * No key, no network egress, no cost. Included because "we cannot judge until
 * someone pays for an API" is a bad place for the project to be, and because a
 * local provider is the only way to exercise the pipeline with no external
 * dependency at all.
 *
 * Same contract as every other provider: the response is parsed and validated
 * against the same schema. A small local model will fail that validation more
 * often, which is exactly what the retry-then-refuse path is for.
 */
class OllamaProvider implements AiProvider {
  readonly name = 'ollama' as const;
  readonly modelVersion: string;

  constructor(private readonly config: AiConfig) {
    this.modelVersion = config.model ?? 'llama3.2';
  }

  async complete(input: { system: string; user: string; maxOutputTokens: number; timeoutMs: number }) {
    const base = this.config.baseUrl ?? 'http://127.0.0.1:11434';

    const response = await fetchWithTimeout(
      `${base}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.modelVersion,
          stream: false,
          format: 'json',
          options: { temperature: 0, num_predict: input.maxOutputTokens },
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
        response.status === 404
          ? `Ollama does not have the model "${this.modelVersion}". Run: ollama pull ${this.modelVersion}`
          : `Ollama returned ${response.status}: ${body.slice(0, 300)}`,
        response.status >= 500,
      );
    }

    const json = (await response.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      text: json.message?.content ?? '',
      usage: {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
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
    case 'gemini':
      requireKey(config);
      return new AiClient(new GeminiProvider(config), config);
    case 'ollama':
      // Deliberately no key check: a model on this machine has nothing to
      // authenticate against, and demanding one would be theatre.
      return new AiClient(new OllamaProvider(config), config);
    case 'openai':
      requireKey(config);
      return new AiClient(new OpenAiResponsesProvider(config), config);
    /*
     * `custom` keeps the chat-completions shape. It exists for gateways and
     * self-hosted clones, which overwhelmingly implement that endpoint and not
     * the Responses API, so pointing it at /v1/responses would break every one
     * of them to tidy up a name.
     */
    case 'custom':
      requireKey(config);
      return new AiClient(new OpenAiCompatibleProvider(config), config);
    default: {
      const exhaustive: never = config.provider;
      throw new AiError(`Unknown AI provider: ${String(exhaustive)}`, false);
    }
  }
}

/** The variable an operator should set for each provider, named in the refusal. */
const KEY_VARIABLE: Partial<Record<AiProviderName, string>> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

function requireKey(config: AiConfig): void {
  if (!config.apiKey) {
    const variable = KEY_VARIABLE[config.provider] ?? 'AI_API_KEY';
    throw new AiError(
      `${variable} is required when AI_PROVIDER is "${config.provider}". ` +
        'Set DEMO_MODE=1 to run without one.',
      false,
    );
  }
}
