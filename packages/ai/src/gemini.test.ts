import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiError,
  createAiClient,
  describeGeminiError,
  isQuotaExhausted,
  type AiConfig,
} from './provider';

/**
 * The Gemini adapter, against a mocked transport.
 *
 * No key and no network: `fetch` is replaced, so every branch is exercised
 * deterministically and nothing is spent. What is being tested is the handling
 * of the ways this provider fails, because those are what decide whether a
 * submission gets judged or gets quietly scored on nothing.
 */

const CONFIG: AiConfig = {
  provider: 'gemini',
  model: 'gemini-2.5-flash-lite',
  apiKey: 'not-a-real-key',
  maxRetries: 1,
  timeoutMs: 5_000,
};

const SCHEMA = z.object({ verdict: z.string(), score: z.number() });

function client(config: Partial<AiConfig> = {}) {
  return createAiClient({ ...CONFIG, ...config });
}

function request() {
  return {
    promptVersion: 'v1',
    system: 'You are a judge.',
    user: 'Assess this.',
    schema: SCHEMA,
    correlationId: 'anon-1',
  };
}

/** A well-formed Gemini success body. */
function geminiOk(payload: unknown, usage = { promptTokenCount: 100, candidatesTokenCount: 20 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
      usageMetadata: usage,
    }),
    text: async () => '',
  } as unknown as Response;
}

function geminiError(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --------------------------------------------------------------------------

describe('a successful call', () => {
  it('returns validated data and real usage figures', async () => {
    fetchMock.mockResolvedValue(geminiOk({ verdict: 'works', score: 7 }));

    const response = await client().run(request());

    expect(response.data).toEqual({ verdict: 'works', score: 7 });
    expect(response.usage).toEqual({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, requests: 1 });
    expect(response.modelVersion).toBe('gemini-2.5-flash-lite');
    expect(response.degraded).toBe(false);
  });

  it('sends the key in a header, never in the URL', async () => {
    // A key in a query string ends up in access logs, proxy logs and error
    // messages — none of which are places a credential should be recoverable.
    fetchMock.mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }));
    await client().run(request());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain('not-a-real-key');
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'not-a-real-key' });
  });

  it('asks for deterministic output', async () => {
    // Two runs of the same submission must not disagree because of sampling.
    fetchMock.mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }));
    await client().run(request());

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('puts the model in the path, so AI_MODEL alone switches models', async () => {
    fetchMock.mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }));
    await client({ model: 'gemini-2.0-flash' }).run(request());

    expect(String(fetchMock.mock.calls[0]![0])).toContain('gemini-2.0-flash:generateContent');
  });

  it('separates the system instruction from the user turn', async () => {
    // Participant content goes in the user turn. Merging them would put
    // untrusted text where the instructions live.
    fetchMock.mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }));
    await client().run(request());

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.systemInstruction.parts[0].text).toContain('You are a judge.');
    expect(body.contents[0].parts[0].text).toBe('Assess this.');
  });
});

describe('a 200 with no text', () => {
  it('is an error, not an empty answer', async () => {
    // The dangerous case. Treating this as a completion would score a
    // submission on nothing at all.
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }),
      text: async () => '',
    } as unknown as Response);

    await expect(client({ maxRetries: 0 }).run(request())).rejects.toThrow(/no text/i);
  });

  it('names the finish reason so the cause is visible', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }),
      text: async () => '',
    } as unknown as Response);

    await expect(client({ maxRetries: 0 }).run(request())).rejects.toThrow(/SAFETY/);
  });

  it('reports a blocked prompt rather than a mysterious empty result', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ promptFeedback: { blockReason: 'OTHER' } }),
      text: async () => '',
    } as unknown as Response);

    await expect(client({ maxRetries: 0 }).run(request())).rejects.toThrow(/OTHER/);
  });

  it('retries when the output ceiling was the cause', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }),
        text: async () => '',
      } as unknown as Response)
      .mockResolvedValue(geminiOk({ verdict: 'second try', score: 3 }));

    const response = await client().run(request());
    expect(response.data.verdict).toBe('second try');
    expect(response.attempts).toBe(2);
  });
});

describe('quota and rate limits', () => {
  const QUOTA_BODY = JSON.stringify({
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' },
  });

  it('recognises exhausted free quota', () => {
    expect(isQuotaExhausted(QUOTA_BODY)).toBe(true);
    expect(isQuotaExhausted('{"error":{"message":"too many requests"}}')).toBe(false);
  });

  it('does not retry an exhausted quota', async () => {
    // Retrying cannot fix it and burns what remains faster.
    fetchMock.mockResolvedValue(geminiError(429, QUOTA_BODY));

    await expect(client({ maxRetries: 3 }).run(request())).rejects.toThrow(AiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does retry an ordinary rate limit', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiError(429, '{"error":{"message":"rate limit"}}'))
      .mockResolvedValue(geminiOk({ verdict: 'recovered', score: 5 }));

    const response = await client().run(request());
    expect(response.data.verdict).toBe('recovered');
  });

  it('tells the operator what to do about exhausted quota', () => {
    const message = describeGeminiError(429, QUOTA_BODY);
    expect(message).toMatch(/free quota/i);
    expect(message).toMatch(/AI_MODEL/);
    expect(message).toMatch(/billing/i);
  });
});

describe('configuration errors', () => {
  it('explains a rejected key without echoing it', async () => {
    const body = JSON.stringify({ error: { code: 400, message: 'API key not valid' } });
    fetchMock.mockResolvedValue(geminiError(400, body));

    const error = (await client({ maxRetries: 0 })
      .run(request())
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/AI_API_KEY/);
    expect(error.message).not.toContain('not-a-real-key');
  });

  it('names the model when it does not exist', async () => {
    const body = JSON.stringify({
      error: { code: 404, message: 'models/gemini-9-ultra is not found' },
    });
    fetchMock.mockResolvedValue(geminiError(404, body));

    const error = (await client({ maxRetries: 0 })
      .run(request())
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/AI_MODEL/);
  });

  it('does not retry a bad key', async () => {
    fetchMock.mockResolvedValue(
      geminiError(400, JSON.stringify({ error: { message: 'API key not valid' } })),
    );
    await expect(client({ maxRetries: 3 }).run(request())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to build a Gemini client with no key', () => {
    // Names the provider-specific variable, so an operator is told the exact
    // thing to set rather than the generic one they may not be using.
    expect(() => createAiClient({ ...CONFIG, apiKey: undefined })).toThrow(
      /GEMINI_API_KEY is required/,
    );
  });

  it('retries a server error', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiError(503, '{"error":{"message":"overloaded"}}'))
      .mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }));

    await expect(client().run(request())).resolves.toMatchObject({ attempts: 2 });
  });
});

describe('malformed output', () => {
  it('retries once and then refuses, rather than inventing fields', async () => {
    // A missing score must never become a zero. Zero is a real score.
    fetchMock.mockResolvedValue(geminiOk({ verdict: 'missing the score field' }));

    await expect(client().run(request())).rejects.toThrow(/did not match the required structure/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when a retry returns valid output', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiOk({ nonsense: true }))
      .mockResolvedValue(geminiOk({ verdict: 'fine', score: 9 }));

    const response = await client().run(request());
    expect(response.data.score).toBe(9);
    expect(response.attempts).toBe(2);
  });

  it('tells the model what was wrong on the retry', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiOk({ verdict: 'no score' }))
      .mockResolvedValue(geminiOk({ verdict: 'fine', score: 9 }));

    await client().run(request());
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(retryBody.contents[0].parts[0].text).toMatch(/was rejected/i);
    // The retry must say what was wrong, not just that something was.
    expect(retryBody.contents[0].parts[0].text).toMatch(/score/i);
  });

  it('handles JSON wrapped in prose or fences', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [{ text: 'Here you go:\n```json\n{"verdict":"ok","score":4}\n```\nHope that helps.' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {},
      }),
      text: async () => '',
    } as unknown as Response);

    await expect(client().run(request())).resolves.toMatchObject({ data: { score: 4 } });
  });

  it('accumulates usage across retries, so cost is not under-reported', async () => {
    fetchMock
      .mockResolvedValueOnce(geminiOk({ bad: true }, { promptTokenCount: 50, candidatesTokenCount: 10 }))
      .mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }, { promptTokenCount: 60, candidatesTokenCount: 12 }));

    const response = await client().run(request());
    expect(response.usage).toEqual({ inputTokens: 110, cachedInputTokens: 0, outputTokens: 22, requests: 2 });
  });
});

describe('timeouts', () => {
  it('are reported as such and retried', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort).mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }));

    await expect(client().run(request())).resolves.toMatchObject({ attempts: 2 });
  });

  it('give up with a clear message when every attempt times out', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(client().run(request())).rejects.toThrow(/timed out|failed after/i);
  });
});

describe('the local provider', () => {
  it('needs no API key', () => {
    expect(() =>
      createAiClient({
        provider: 'ollama',
        model: 'llama3.2',
        maxRetries: 0,
        timeoutMs: 1_000,
      }),
    ).not.toThrow();
  });

  it('talks to localhost and asks for JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: '{"verdict":"local","score":2}' },
        prompt_eval_count: 30,
        eval_count: 8,
      }),
      text: async () => '',
    } as unknown as Response);

    const response = await createAiClient({
      provider: 'ollama',
      model: 'llama3.2',
      maxRetries: 0,
      timeoutMs: 5_000,
    }).run(request());

    expect(String(fetchMock.mock.calls[0]![0])).toContain('127.0.0.1:11434');
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.format).toBe('json');
    expect(body.options.temperature).toBe(0);
    expect(response.data).toEqual({ verdict: 'local', score: 2 });
    expect(response.usage).toEqual({ inputTokens: 30, cachedInputTokens: 0, outputTokens: 8, requests: 1 });
  });

  it('says how to install a missing model', async () => {
    fetchMock.mockResolvedValue(geminiError(404, 'model not found'));

    const error = (await createAiClient({
      provider: 'ollama',
      model: 'llama3.2',
      maxRetries: 0,
      timeoutMs: 5_000,
    })
      .run(request())
      .catch((e: unknown) => e)) as Error;

    expect(error.message).toMatch(/ollama pull llama3\.2/);
  });
});

describe('provider independence', () => {
  it('keeps the same contract across every provider', async () => {
    // The point of the abstraction: switching AI_PROVIDER must not require a
    // change anywhere in the assessment or domain logic.
    fetchMock.mockResolvedValue(geminiOk({ verdict: 'ok', score: 1 }));

    for (const provider of ['gemini', 'anthropic', 'openai', 'custom'] as const) {
      const built = createAiClient({
        provider,
        // OpenAI refuses to default a model — judging a cohort on an unstated
        // one is exactly the inconsistency the pinned model exists to prevent.
        model: provider === 'openai' ? 'gpt-5.6-terra' : undefined,
        apiKey: 'k',
        maxRetries: 0,
        timeoutMs: 1_000,
      });
      expect(typeof built.run, provider).toBe('function');
      expect(typeof built.modelVersion, provider).toBe('string');
    }
  });

  it('defaults Gemini to a free-tier model rather than a paid one', () => {
    const built = createAiClient({ provider: 'gemini', apiKey: 'k', maxRetries: 0, timeoutMs: 1 });
    expect(built.modelVersion).toBe('gemini-2.5-flash-lite');
  });
});
