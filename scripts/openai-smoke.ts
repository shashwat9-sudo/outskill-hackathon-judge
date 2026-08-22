/**
 * One real OpenAI call, and nothing else.
 *
 * Run before switching the production provider, to answer the only question a
 * unit test cannot: does this key, in this project, reach this model, over the
 * Responses API, and come back as something the pipeline would accept.
 *
 * Deliberately standalone. It opens no database connection, touches no
 * Supabase bucket, reads no spreadsheet, and creates no cohort, submission or
 * job — so it cannot perturb a cohort waiting to be judged. The input is a
 * hard-coded fixture about a fictional lamp; no learner data exists in this
 * file and none is read.
 *
 * It prints metadata only. Not the key, not the prompt, not the response body.
 *
 *   railway run --service judging-worker npx tsx scripts/openai-smoke.ts
 *
 * The key arrives from the Railway environment. It is never read from a file,
 * never echoed, and never written anywhere by this script.
 */

import { z } from 'zod';
import { createAiClient, AiError } from '../packages/ai/src/provider';

const MODEL = 'gpt-5.6-terra';

/**
 * Small, but the same shape of thing judging asks for: an enum, a bounded
 * number, a string and an array of strings. Enough to exercise strict
 * Structured Outputs and then Zod on top of it.
 */
const smokeSchema = z.object({
  verdict: z.enum(['works', 'broken', 'unclear']),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(300),
  observations: z.array(z.string().max(200)).max(4),
});

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(
      'OPENAI_API_KEY is not present in this environment. ' +
        'Run through `railway run --service judging-worker` so the deployed secret is injected.',
    );
    process.exit(1);
  }

  const client = createAiClient({
    provider: 'openai',
    model: MODEL,
    apiKey,
    // One retry, so a single transient blip does not fail the check, while a
    // real fault still surfaces quickly rather than being masked.
    maxRetries: 1,
    timeoutMs: 60_000,
  });

  const started = Date.now();
  let rateLimited = false;

  try {
    const response = await client.run({
      promptVersion: 'smoke-v1',
      system:
        'You assess whether a described product works. Answer only with the JSON object requested.',
      user: [
        'A fictional product for this connectivity check. No real submission is involved.',
        '',
        'Product: a desk lamp with one button.',
        'Claim: pressing the button turns the light on, and pressing it again turns it off.',
        'Observed: pressing the button turned the light on. Pressing it again did nothing.',
        '',
        'Give a verdict, a confidence between 0 and 1, a one-sentence summary,',
        'and up to four short observations.',
      ].join('\n'),
      schema: smokeSchema,
      correlationId: 'smoke-check',
      schemaName: 'smoke_check',
      maxOutputTokens: 2048,
    });

    const durationMs = Date.now() - started;

    console.log('request succeeded        : YES');
    console.log(`returned model           : ${response.modelVersion}`);
    console.log(`input tokens             : ${response.usage.inputTokens}`);
    console.log(`cached input tokens      : ${response.usage.cachedInputTokens}`);
    console.log(`output tokens            : ${response.usage.outputTokens}`);
    console.log(`OpenAI requests made     : ${response.usage.requests}`);
    console.log(`attempts                 : ${response.attempts}`);
    console.log(`rate-limit error         : ${rateLimited ? 'YES' : 'NO'}`);
    console.log(`structured validation    : PASS`);
    console.log(`degraded                 : ${response.degraded ? 'YES' : 'NO'}`);
    console.log(`duration ms              : ${durationMs}`);

    /*
     * Field presence, not field content. Whether the model thinks a fictional
     * lamp is broken is irrelevant; that every required key came back with the
     * right type is the whole point of the check.
     */
    const keys = Object.keys(response.data).sort().join(',');
    console.log(`fields returned          : ${keys}`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rateLimited = /429|rate limit/i.test(message);

    console.log('request succeeded        : NO');
    console.log(`returned model           : ${MODEL} (requested)`);
    console.log(`rate-limit error         : ${rateLimited ? 'YES' : 'NO'}`);
    console.log(`retryable                : ${error instanceof AiError ? error.retryable : 'unknown'}`);
    console.log(`structured validation    : FAIL`);
    // Already redacted by the adapter before it reaches here.
    console.log(`error                    : ${message.slice(0, 400)}`);
    process.exit(1);
  }
}

void main();
