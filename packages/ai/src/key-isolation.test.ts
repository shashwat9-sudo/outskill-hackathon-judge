import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAiClientFromEnv } from './index';
import { loadEnv, providerApiKey } from '@ohj/shared';

/**
 * Which key goes to which provider.
 *
 * On the production worker `AI_API_KEY` holds the *Gemini* key. It is kept
 * there on purpose: rolling back from OpenAI is then a change to AI_PROVIDER
 * and nothing else, with no secret for anyone to go and reissue at three in the
 * morning.
 *
 * That makes a generic fallback dangerous rather than convenient. If OpenAI
 * could fall back to AI_API_KEY, a missing OPENAI_API_KEY would send the Gemini
 * key to OpenAI: a 401 whose text describes none of the actual mistake,
 * arriving mid-batch, and one step away from someone pasting a key into the
 * wrong variable to make it stop.
 *
 * So the two providers are mutually explicit. There is no automatic failover
 * between them anywhere in this system — switching is a deliberate change to
 * AI_PROVIDER, because a batch judged half on one model and half on another is
 * not a batch anybody can defend.
 */

const GEMINI_KEY = 'gemini-key-do-not-send-to-openai';
const OPENAI_KEY = 'openai-key';

const base = { AI_MAX_RETRIES: 0, AI_TIMEOUT_MS: 1_000, DEMO_MODE: false } as const;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bearerOf = (call: number) =>
  (fetchMock.mock.calls[call]![1] as { headers: Record<string, string> }).headers.authorization;

const ok = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    text: async () => '',
  }) as unknown as Response;

const request = () => ({
  promptVersion: 'v1',
  system: 's',
  user: 'u',
  schema: z.object({ ok: z.boolean() }),
  correlationId: 'anon-1',
});

// 1. OpenAI uses OPENAI_API_KEY.
it('sends OPENAI_API_KEY to OpenAI', async () => {
  fetchMock.mockResolvedValue(ok({ ok: true }));

  await createAiClientFromEnv({
    ...base,
    AI_PROVIDER: 'openai',
    AI_MODEL: 'gpt-5.6-terra',
    OPENAI_API_KEY: OPENAI_KEY,
    AI_API_KEY: GEMINI_KEY,
  }).run(request());

  expect(bearerOf(0)).toBe(`Bearer ${OPENAI_KEY}`);
});

// 2. OpenAI never falls back to AI_API_KEY.
it('never sends the Gemini key to OpenAI, even with AI_API_KEY set', () => {
  expect(() =>
    createAiClientFromEnv({
      ...base,
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-5.6-terra',
      AI_API_KEY: GEMINI_KEY,
    }),
  ).toThrow(/OPENAI_API_KEY is required/);

  expect(providerApiKey({ AI_PROVIDER: 'openai', AI_API_KEY: GEMINI_KEY })).toBeUndefined();
});

// 3. Missing OPENAI_API_KEY fails before an API request is made.
it('fails before any request leaves the machine', () => {
  expect(() =>
    createAiClientFromEnv({
      ...base,
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-5.6-terra',
      AI_API_KEY: GEMINI_KEY,
    }),
  ).toThrow();

  // Construction refused, so nothing was ever sent — the mistake is caught at
  // boot rather than one submission at a time.
  expect(fetchMock).not.toHaveBeenCalled();
});

it('refuses at config load too, and says not to use AI_API_KEY', () => {
  const attempt = () =>
    loadEnv({
      DEMO_MODE: '0',
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-5.6-terra',
      AI_API_KEY: GEMINI_KEY,
      ADMIN_SESSION_SECRET: 'x'.repeat(48),
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      DATABASE_URL: 'postgresql://u:p@db.pooler.supabase.com:6543/postgres',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SECRET_KEY: 'k',
    });

  expect(attempt).toThrow(/OPENAI_API_KEY must be set/);
  // Suggesting AI_API_KEY here would be actively harmful advice: following it
  // puts a Gemini key where an OpenAI one belongs.
  expect(attempt).toThrow(/not a substitute/);
});

// 4. Gemini still works using the preserved key.
it('keeps Gemini reading AI_API_KEY, so rollback needs no new secret', async () => {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    text: async () => '',
  } as unknown as Response);

  const client = createAiClientFromEnv({
    ...base,
    AI_PROVIDER: 'gemini',
    AI_MODEL: 'gemini-3.5-flash-lite',
    AI_API_KEY: GEMINI_KEY,
  });

  expect(client.providerName).toBe('gemini');
  const response = await client.run(request());
  expect(response.data.ok).toBe(true);
  expect(response.modelVersion).toBe('gemini-3.5-flash-lite');
});

it('rolls back on AI_PROVIDER alone, with both keys present', () => {
  // Exactly the production shape after the migration.
  const production = { ...base, OPENAI_API_KEY: OPENAI_KEY, AI_API_KEY: GEMINI_KEY };

  expect(
    createAiClientFromEnv({ ...production, AI_PROVIDER: 'openai', AI_MODEL: 'gpt-5.6-terra' })
      .providerName,
  ).toBe('openai');
  expect(
    createAiClientFromEnv({ ...production, AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-3.5-flash-lite' })
      .providerName,
  ).toBe('gemini');
});

// 5. No secret value appears in errors or logs.
it('puts no key value in the refusal', () => {
  const error = (() => {
    try {
      createAiClientFromEnv({
        ...base,
        AI_PROVIDER: 'openai',
        AI_MODEL: 'gpt-5.6-terra',
        AI_API_KEY: GEMINI_KEY,
      });
      return new Error('expected a refusal');
    } catch (e) {
      return e as Error;
    }
  })();

  expect(error.message).not.toContain(GEMINI_KEY);
  expect(error.message).toContain('OPENAI_API_KEY');
});

it('puts no key value in a provider error', async () => {
  fetchMock.mockResolvedValue({
    ok: false,
    status: 401,
    headers: new Headers(),
    json: async () => ({}),
    text: async () => `Incorrect API key provided: sk-proj-LEAKED123456789`,
  } as unknown as Response);

  const error: Error = await createAiClientFromEnv({
    ...base,
    AI_PROVIDER: 'openai',
    AI_MODEL: 'gpt-5.6-terra',
    OPENAI_API_KEY: OPENAI_KEY,
  })
    .run(request())
    .then(() => new Error('expected a rejection'))
    .catch((e: Error) => e);

  // This text reaches assessment_jobs.last_error, the admin queue and operator
  // reports.
  expect(error.message).not.toContain('sk-proj-LEAKED123456789');
  expect(error.message).toContain('[redacted]');
});

// No automatic failover, anywhere.
describe('provider modes stay mutually explicit', () => {
  it('does not retry a failed OpenAI call on another provider', async () => {
    /*
     * A batch judged half on one model and half on another is not a batch
     * anybody can defend, so a failure stays a failure. Every request in this
     * run goes to api.openai.com or nowhere.
     */
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => 'upstream error',
    } as unknown as Response);

    await createAiClientFromEnv({
      ...base,
      AI_MAX_RETRIES: 2,
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-5.6-terra',
      OPENAI_API_KEY: OPENAI_KEY,
      AI_API_KEY: GEMINI_KEY,
    })
      .run(request())
      .catch(() => undefined);

    const hosts = fetchMock.mock.calls.map((c) => new URL(String(c[0])).host);
    expect(new Set(hosts)).toEqual(new Set(['api.openai.com']));
    expect(hosts.length).toBeGreaterThan(1);
  });

  it('has no code path that swaps provider mid-run', () => {
    // One client is built at worker boot from one AI_PROVIDER, and the model it
    // reports never changes for the life of the process.
    const client = createAiClientFromEnv({
      ...base,
      AI_PROVIDER: 'openai',
      AI_MODEL: 'gpt-5.6-terra',
      OPENAI_API_KEY: OPENAI_KEY,
      AI_API_KEY: GEMINI_KEY,
    });

    expect(client.providerName).toBe('openai');
    expect(client.modelVersion).toBe('gpt-5.6-terra');
  });
});
