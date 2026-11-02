#!/usr/bin/env node
/**
 * One controlled synthetic assessment against the real AI provider.
 *
 * Purpose: find out whether the provider — and the exact model the worker is
 * about to be pinned to — actually works, using data that belongs to nobody.
 * It runs the real prompts and validates against the real schemas, through
 * the same adapter the worker uses, so a pass here means the contracts hold
 * and not merely that the network is reachable.
 *
 * Four calls, the four the pipeline makes for one submission:
 *   1. artifact analysis      2. test-plan generation
 *   3. rubric scoring (8 categories)      4. participant feedback
 * each with the same output-token budget the worker gives that stage.
 *
 * What it deliberately does NOT do:
 *   - touch Supabase (no client is constructed, no connection is opened)
 *   - read any learner submission, import any sheet row, or queue any job
 *   - write any assessment record
 *   - print the API key, or any value from .env.local
 *
 * The synthetic submission below contains planted PII and a planted credential.
 * They are there so redaction can be proven on the exact payload that goes to
 * the provider, rather than asserted. If any of them survives to the wire, the
 * run aborts before the request is sent.
 *
 *   OPENAI_API_KEY=… npx tsx scripts/controlled-ai-run.ts --provider openai --model gpt-6.1-sol
 *
 * Flags: --provider, --model, --timeout-ms, --inspect-only (no request sent),
 * --json <path> (write the per-call record). Anything not given on the command
 * line comes from the environment, then from .env.local.
 *
 * The key is resolved exactly as the worker resolves it (`providerApiKey`):
 * OpenAI reads OPENAI_API_KEY and nothing else. On the production worker
 * AI_API_KEY holds the Gemini key, and a generic fallback would send that to
 * OpenAI; this script refuses instead, before any request leaves the machine.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// --- flags ----------------------------------------------------------------

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === `--${name}` && argv[i + 1] && !argv[i + 1]!.startsWith('--')) return argv[i + 1];
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
  }
  return undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

// --- load .env.local without printing anything from it -------------------
// Real environment wins; the file only fills gaps.

const envFile = resolve(ROOT, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) process.env[match[1]!] ??= match[2]!.trim().replace(/^["']|["']$/g, '');
  }
}
if (flag('provider')) process.env.AI_PROVIDER = flag('provider');
if (flag('model')) process.env.AI_MODEL = flag('model');
if (flag('timeout-ms')) process.env.AI_TIMEOUT_MS = flag('timeout-ms');

import { createAiClient, type AiProviderName, type AiRequest, type AiResponse } from '../packages/ai/src/provider';
import type { ScoringOutput } from '../packages/ai/src/schemas';
import {
  artifactAnalysisPrompt,
  feedbackPrompt,
  scoringPrompt,
  testPlanPrompt,
} from '../packages/ai/src/prompts';
import {
  artifactAnalysisSchema,
  feedbackOutputSchema,
  scoringOutputSchema,
  testPlanOutputSchema,
  validateFeedbackSafety,
  validateScoreCeilings,
} from '../packages/ai/src/schemas';
import { redactDeep, assertNoCredentialShapedContent } from '../packages/ai/src/redaction';
import { canDispatchToProvider } from '../packages/ai/src/evaluation-mode';
import { providerApiKey, PROVIDER_KEY_VARIABLE } from '../packages/shared/src/config/env';
import { RUBRIC_CATEGORIES, getMaxPoints } from '../packages/shared/src/rubric/index';

interface CallRecord {
  label: string;
  ok: boolean;
  ms: number;
  attempts?: number;
  requests?: number;
  providerModel?: string | null;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  reasoningTokens?: number;
  maxOutputTokens: number;
  /** Share of the output budget the model used, reasoning included. */
  budgetUsed?: string;
  error?: string;
}

const log = (...args: unknown[]) => process.stdout.write(`${args.join(' ')}\n`);
const rule = () => log('─'.repeat(74));

/**
 * List prices, USD per million tokens, for the cost estimate at the end.
 *
 * Third-party listings checked 2 November 2026; confirm against OpenAI's own
 * pricing page before quoting a budget. A model not listed here reports token
 * counts without a dollar figure rather than guessing.
 */
const PRICES_PER_MILLION: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
};

// --- the synthetic submission -------------------------------------------

/**
 * Fictional throughout. The names, email, phone and password below are planted
 * bait: they must be gone before anything is sent.
 */
const SYNTHETIC = {
  submissionId: 'SUB-SYNTHETIC0001',
  teamNames: ['Priya Sharma', 'Arjun Rao'],
  productName: 'ClinicPing',
  productUrl: 'https://clinicping.example',
  ideaTitle: 'Clinic appointment reminder tool',
  ideaMinimumFlow: [
    'Add a patient with a phone number',
    'Book an appointment for that patient',
    'See the appointment in a list',
    'Mark it as confirmed',
  ],
  ideaEntities: ['patient', 'appointment'],
  unsafeInterpretations: 'Sending real SMS messages, storing real patient records.',
  mustHaveWorkflow:
    'A receptionist adds a patient, books an appointment for them, sees it in the list and marks it confirmed.',
  declaredSteps: [
    { action: 'Click "Add patient" and enter a name and phone number', expectedResult: 'The patient appears in the list' },
    { action: 'Click "Book appointment" for that patient and pick a date', expectedResult: 'The appointment shows as Booked' },
    { action: 'Click "Confirm"', expectedResult: 'The appointment shows as Confirmed' },
  ],
  safeSampleInputs: 'Patient name: OUTSKILL-JUDGE-Test Patient. Phone: 0000000000. Any future date.',
  knownLimitations: 'Reminder scheduling is approximate and the mobile layout is rough.',
  nextSevenDayPlan: 'Fix the confirm button, add SMS via a provider, tidy the mobile layout.',
  writtenSubmission: `
Our tool helps small clinics cut no-shows. Built by Priya Sharma and Arjun Rao.
Reach us at priya.sharma@example.com or +91 98765 43210.

The receptionist adds a patient, books an appointment, and the tool sends a
reminder the day before. Confirmations show up on the dashboard.

Demo login: username demo@clinic.example password: Hunter2Reminder
We know the reminder scheduling is approximate and the mobile layout is rough.
`.trim(),
  deckText: `
Slide 1: No-shows cost small clinics 18% of revenue.
Slide 2: Receptionists track appointments on paper.
Slide 3: Our tool books, reminds and confirms.
Slide 4: Built in 2 days with AI-assisted scheduling.
Slide 5: Contact Priya Sharma, priya.sharma@example.com
`.trim(),
  deckPageCount: 5,
};

const PLANTED = [
  'Priya Sharma',
  'Arjun Rao',
  'priya.sharma@example.com',
  '98765 43210',
  'Hunter2Reminder',
  'demo@clinic.example',
];

const BROWSER_EVIDENCE = [
  'Step 0 navigate — passed (800ms)',
  'Step 1 click "Add patient" — passed (200ms)',
  'Step 2 fill patient name — passed (140ms)',
  'Step 3 click "Book appointment" — passed (260ms)',
  'Step 4 assertText "Booked" — passed (120ms)',
  'Step 5 click "Confirm" — FAILED: element not found after 5000ms',
  'Step 6 checkPersistence after reload — passed, appointment still listed',
  'Console errors: 1 (TypeError in reminder-scheduler.js)',
  'Network failures: 0',
  'Accessibility: 3 axe violations (1 serious: form input without label)',
  'Mobile viewport: layout overflows horizontally at 375px',
].join('\n');

// --- guard: would this even be allowed to dispatch? ----------------------

rule();
log('CONTROLLED SYNTHETIC AI RUN');
rule();

const provider = (process.env.AI_PROVIDER ?? 'demo') as AiProviderName;
const model = process.env.AI_MODEL;
const timeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 60_000);
const maxRetries = Number(process.env.AI_MAX_RETRIES ?? 2);
const mode = (process.env.AI_EVALUATION_MODE ?? 'synthetic_only') as 'synthetic_only' | 'production';
const decision = canDispatchToProvider(mode, {
  isDemoCohort: true,
  isSyntheticSubmission: true,
  cohortName: 'Synthetic fixture cohort',
  correlationId: SYNTHETIC.submissionId,
});

log(`Provider          ${provider}`);
log(`Model             ${model ?? '(not set)'}`);
log(`Timeout           ${timeoutMs} ms, retries ${maxRetries}`);
log(`Evaluation mode   ${mode}`);
log(`Dispatch allowed  ${decision.allowed} (synthetic fixture data)`);
if (!decision.allowed) {
  log(`\nREFUSED: ${decision.reason}`);
  process.exit(1);
}

/*
 * The key, resolved the worker's way. Which variable it came from is printed;
 * the value never is.
 */
const apiKey = providerApiKey({
  AI_PROVIDER: provider,
  AI_API_KEY: process.env.AI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
});
const keyVariable = PROVIDER_KEY_VARIABLE[provider] ?? 'AI_API_KEY';
const keySource =
  provider === 'openai'
    ? 'OPENAI_API_KEY'
    : process.env[keyVariable]
      ? keyVariable
      : 'AI_API_KEY';
if (provider !== 'demo' && provider !== 'ollama' && !apiKey) {
  log(
    `\nREFUSED: ${keyVariable} is not set for provider "${provider}".` +
      (provider === 'openai' && process.env.AI_API_KEY
        ? ' AI_API_KEY is present but holds another provider\'s credential and is never sent to OpenAI.'
        : ''),
  );
  process.exit(1);
}
log(`Key source        ${keySource} (value not shown)`);

// --- build the payloads, then prove they are clean -----------------------

const redactedWritten = redactDeep(SYNTHETIC.writtenSubmission, SYNTHETIC.teamNames);
const redactedDeck = redactDeep(SYNTHETIC.deckText, SYNTHETIC.teamNames);

const analysisUser = artifactAnalysisPrompt.user({
  submissionId: SYNTHETIC.submissionId,
  ideaTitle: SYNTHETIC.ideaTitle,
  ideaMinimumFlow: SYNTHETIC.ideaMinimumFlow,
  writtenSubmission: redactedWritten,
  deckText: redactedDeck,
  deckPageCount: SYNTHETIC.deckPageCount,
  transcript: null,
});

const planUser = testPlanPrompt.user({
  submissionId: SYNTHETIC.submissionId,
  productUrl: SYNTHETIC.productUrl,
  ideaTitle: SYNTHETIC.ideaTitle,
  ideaMinimumFlow: SYNTHETIC.ideaMinimumFlow,
  ideaEntities: SYNTHETIC.ideaEntities,
  unsafeInterpretations: SYNTHETIC.unsafeInterpretations,
  declaredWorkflow: redactDeep(SYNTHETIC.mustHaveWorkflow, SYNTHETIC.teamNames),
  declaredSteps: SYNTHETIC.declaredSteps,
  sampleInputs: redactDeep(SYNTHETIC.safeSampleInputs, SYNTHETIC.teamNames),
  knownLimitations: redactDeep(SYNTHETIC.knownLimitations, SYNTHETIC.teamNames),
  loginRequired: true,
  budgetMs: 240_000,
});

rule();
log('PAYLOAD INSPECTION — before anything is sent');
rule();

let leaked = false;
const inspect = (label: string, payload: string) => {
  for (const secret of PLANTED) {
    const present = payload.includes(secret);
    if (present) leaked = true;
    log(`  ${present ? 'LEAKED  ' : 'removed '} ${label.padEnd(10)} ${secret}`);
  }
  try {
    assertNoCredentialShapedContent({ [label]: payload });
    log(`  passed   ${label.padEnd(10)} credential-shape assertion`);
  } catch (error) {
    leaked = true;
    log(`  FAILED   ${label.padEnd(10)} credential-shape assertion: ${(error as Error).message}`);
  }
};
inspect('analysis', analysisUser);
inspect('plan', planUser);

if (leaked) {
  log('\nABORTED before sending. Planted data survived redaction.');
  process.exit(1);
}

log(`\nPayload length    analysis ${analysisUser.length}, plan ${planUser.length} characters`);
log('Identifier sent   ' + SYNTHETIC.submissionId + ' (synthetic, not a team id)');

// Stop here when only the payload matters — lets the redaction be verified
// without spending a single token.
if (has('inspect-only')) {
  rule();
  log('INSPECT ONLY — no request was sent.');
  rule();
  process.exit(0);
}

async function main(): Promise<void> {
  // --- the run -----------------------------------------------------------

  const client = createAiClient({ provider, model, apiKey, maxRetries, timeoutMs });

  const calls: CallRecord[] = [];

  async function call<T>(label: string, request: AiRequest<T>): Promise<AiResponse<T>> {
    const maxOutputTokens = request.maxOutputTokens ?? 4096;
    const startedAt = Date.now();
    try {
      const response = await client.run(request);
      calls.push({
        label,
        ok: true,
        ms: Date.now() - startedAt,
        attempts: response.attempts,
        requests: response.usage.requests,
        providerModel: response.providerModel,
        usage: {
          inputTokens: response.usage.inputTokens,
          cachedInputTokens: response.usage.cachedInputTokens,
          outputTokens: response.usage.outputTokens,
        },
        reasoningTokens: response.reasoningTokens,
        maxOutputTokens,
        budgetUsed: `${Math.round((response.usage.outputTokens / response.attempts / maxOutputTokens) * 100)}%`,
      });
      log(`Schema            VALID (${response.attempts} attempt${response.attempts === 1 ? '' : 's'}, ${response.usage.requests} request${response.usage.requests === 1 ? '' : 's'})`);
      log(`Served by         ${response.providerModel ?? '(provider did not say)'}  recorded as ${response.modelVersion}`);
      log(`Tokens            ${response.usage.inputTokens} in (${response.usage.cachedInputTokens} cached) / ${response.usage.outputTokens} out (${response.reasoningTokens} reasoning)`);
      log(`Output budget     ${response.usage.outputTokens} of ${maxOutputTokens} per attempt`);
      log(`Latency           ${Date.now() - startedAt} ms (timeout ${timeoutMs} ms)`);
      return response;
    } catch (error) {
      calls.push({ label, ok: false, ms: Date.now() - startedAt, maxOutputTokens, error: (error as Error).message });
      throw error;
    }
  }

  rule();
  log('CALL 1 — artifact analysis');
  rule();

  const analysis = await call('artifact_analysis', {
    promptVersion: artifactAnalysisPrompt.version,
    system: artifactAnalysisPrompt.system,
    user: analysisUser,
    schema: artifactAnalysisSchema,
    correlationId: SYNTHETIC.submissionId,
  });
  log('\nExtracted:');
  log(JSON.stringify(analysis.data, null, 2).split('\n').slice(0, 30).join('\n'));

  rule();
  log('CALL 2 — test-plan generation');
  rule();

  const plan = await call('test_plan', {
    promptVersion: testPlanPrompt.version,
    system: testPlanPrompt.system,
    user: planUser,
    schema: testPlanOutputSchema,
    correlationId: SYNTHETIC.submissionId,
    maxOutputTokens: 8000,
  });
  log(`\nSteps             ${plan.data.steps.length}, estimated ${Math.round(plan.data.estimatedDurationMs / 1000)} s`);
  log(`Actions used      ${[...new Set(plan.data.steps.map((s) => s.action))].join(', ')}`);
  log(`Cleanup steps     ${plan.data.steps.filter((s) => s.isCleanup).length}`);

  rule();
  log('CALL 3 — rubric scoring');
  rule();

  const scoringUser = scoringPrompt.user({
    submissionId: SYNTHETIC.submissionId,
    ideaTitle: SYNTHETIC.ideaTitle,
    writtenSummary: JSON.stringify(analysis.data.written),
    deckAnalysis: JSON.stringify(analysis.data.deck),
    videoAnalysisLimited: true,
    videoLimitationReason: 'The system cannot watch video.',
    preflightSummary: 'product_url_present: pass. product_url_reachable: pass (820ms). deck_present: pass.',
    browserEvidence: BROWSER_EVIDENCE,
    testPlanSummary: plan.data.summary,
  });

  inspect('scoring', scoringUser);
  if (leaked) {
    log('\nABORTED: planted data reached the scoring payload.');
    process.exit(1);
  }

  const scoring = await call('scoring', {
    promptVersion: scoringPrompt.version,
    system: scoringPrompt.system,
    user: scoringUser,
    schema: scoringOutputSchema,
    correlationId: SYNTHETIC.submissionId,
    maxOutputTokens: 8000,
  });

  rule();
  log('RUBRIC OUTPUT');
  rule();

  type Scored = ScoringOutput['scores'][number];
  const byKey = new Map<string, Scored>(scoring.data.scores.map((c) => [c.categoryKey, c]));
  let total = 0;
  let coveredAll = true;

  for (const category of RUBRIC_CATEGORIES) {
    const scored = byKey.get(category.key);
    if (!scored) {
      coveredAll = false;
      log(`  ${category.key.padEnd(20)} MISSING`);
      continue;
    }
    total += scored.rawScore;
    const within = scored.rawScore <= category.maxPoints ? ' ' : '!';
    log(
      `  ${category.key.padEnd(20)} ${String(scored.rawScore).padStart(5)} / ${String(category.maxPoints).padEnd(3)}` +
        `${within} conf ${scored.confidence.toFixed(2)}  ${(scored.rationale ?? '').slice(0, 70)}`,
    );
  }

  const ceilings = validateScoreCeilings(scoring.data, (key) => getMaxPoints(key as never));
  log(`\n  ${'TOTAL'.padEnd(20)} ${total.toFixed(1)} / 100`);
  log(`  All 8 categories scored: ${coveredAll}`);
  log(`  Within category ceilings: ${ceilings.ok}${ceilings.ok ? '' : ` (${ceilings.problems.join('; ')})`}`);

  const evidenceCounts = scoring.data.scores.reduce(
    (acc, c) => ({
      supporting: acc.supporting + (c.supportingEvidence?.length ?? 0),
      contradictory: acc.contradictory + (c.contradictoryEvidence?.length ?? 0),
      missing: acc.missing + (c.missingEvidence?.length ?? 0),
    }),
    { supporting: 0, contradictory: 0, missing: 0 },
  );
  log(
    `  Evidence items: ${evidenceCounts.supporting} supporting, ` +
      `${evidenceCounts.contradictory} contradictory, ${evidenceCounts.missing} missing`,
  );
  log(`  Strengths: ${scoring.data.strengths.length}, weaknesses: ${scoring.data.weaknesses.length}, bugs found: ${scoring.data.bugsFound.length}`);
  for (const bug of scoring.data.bugsFound) {
    log(`    [${bug.severity}] ${bug.description}`);
  }

  rule();
  log('CALL 4 — participant feedback');
  rule();

  const feedbackUser = feedbackPrompt.user({
    productName: SYNTHETIC.productName,
    ideaTitle: SYNTHETIC.ideaTitle,
    declaredWorkflow: redactDeep(SYNTHETIC.mustHaveWorkflow, SYNTHETIC.teamNames),
    observedBehaviour: BROWSER_EVIDENCE,
    bugsObserved: scoring.data.bugsFound.map((b) => `[${b.severity}] ${b.description}`).join('\n'),
    teamNextPlan: redactDeep(SYNTHETIC.nextSevenDayPlan, SYNTHETIC.teamNames),
  });
  inspect('feedback', feedbackUser);
  if (leaked) {
    log('\nABORTED: planted data reached the feedback payload.');
    process.exit(1);
  }

  const feedback = await call('feedback', {
    promptVersion: feedbackPrompt.version,
    system: feedbackPrompt.system,
    user: feedbackUser,
    schema: feedbackOutputSchema,
    correlationId: SYNTHETIC.submissionId,
  });
  const safety = validateFeedbackSafety(feedback.data);
  log(`\nFeedback safety   ${safety.ok ? 'PASS (no score, rank, shortlist or winner language)' : `WITHHELD: ${safety.problems.join(' ')}`}`);
  log(`Shape             ${feedback.data.strengths.length} strengths, ${feedback.data.improvements.length} improvements, ${feedback.data.bugs.length} bugs, ${feedback.data.nextSevenDayPlan.length} plan items`);

  rule();
  log('SUMMARY');
  rule();

  const totals = calls.reduce(
    (acc, c) => ({
      inputTokens: acc.inputTokens + (c.usage?.inputTokens ?? 0),
      cachedInputTokens: acc.cachedInputTokens + (c.usage?.cachedInputTokens ?? 0),
      outputTokens: acc.outputTokens + (c.usage?.outputTokens ?? 0),
      reasoningTokens: acc.reasoningTokens + (c.reasoningTokens ?? 0),
      ms: acc.ms + c.ms,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, ms: 0 },
  );

  for (const c of calls) {
    log(
      `  ${c.label.padEnd(18)} ${c.ok ? 'ok    ' : 'FAILED'} ${String(c.ms).padStart(6)}ms  ` +
        `attempts ${c.attempts ?? '-'}  ` +
        (c.usage
          ? `${c.usage.inputTokens}/${c.usage.outputTokens} tokens (${c.reasoningTokens} reasoning, ${c.budgetUsed} of ${c.maxOutputTokens} budget)`
          : (c.error ?? '')),
    );
  }
  const served = [...new Set(calls.map((c) => c.providerModel).filter(Boolean))];
  const slowest = Math.max(...calls.map((c) => c.ms));
  log(`\n  Served by         ${served.join(', ') || '(provider did not report a model)'}`);
  log(`  API calls made    ${calls.reduce((n, c) => n + (c.requests ?? 0), 0)} across ${calls.length} stages`);
  log(`  Total tokens      ${totals.inputTokens} in (${totals.cachedInputTokens} cached) / ${totals.outputTokens} out (${totals.reasoningTokens} reasoning)`);
  log(`  Slowest stage     ${slowest} ms of a ${timeoutMs} ms timeout (${Math.round((slowest / timeoutMs) * 100)}%)`);

  const prices = model ? PRICES_PER_MILLION[model] : undefined;
  if (prices) {
    const cost =
      ((totals.inputTokens - totals.cachedInputTokens) * prices.input +
        totals.cachedInputTokens * prices.cachedInput +
        totals.outputTokens * prices.output) /
      1_000_000;
    log(`  Estimated cost    $${cost.toFixed(4)} for this submission at list price ($${prices.input}/$${prices.output} per M in/out)`);
    log(`  Per 40 teams      ~$${(cost * 40).toFixed(2)} (+ one consistency pass for the top 20)`);
  } else {
    log(`  Estimated cost    no list price on file for "${model ?? '(none)'}" — see PRICES_PER_MILLION`);
  }
  log('  Supabase          not contacted (no client constructed, no connection opened)');
  log('  Data source       synthetic fixture defined in this script');
  rule();

  const out = flag('json');
  if (out) {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), provider, model, timeoutMs, maxRetries, calls, totals, served }, null, 2));
    log(`Record written    ${out}`);
  }
}

main().catch((error) => {
  log(`\nRUN FAILED: ${(error as Error).message}`);
  process.exit(1);
});
