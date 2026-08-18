#!/usr/bin/env node
/**
 * One controlled synthetic assessment against the real AI provider.
 *
 * Purpose: find out whether the provider actually works, using data that
 * belongs to nobody. It runs the real prompts and validates against the real
 * schemas, so a pass here means the contracts hold — not merely that the
 * network is reachable.
 *
 * What it deliberately does NOT do:
 *   - touch Supabase (no client is constructed, no connection is opened)
 *   - read any learner submission
 *   - write any assessment record
 *   - print the API key, or any value from .env.local
 *
 * The synthetic submission below contains planted PII and a planted credential.
 * They are there so redaction can be proven on the exact payload that goes to
 * the provider, rather than asserted. If any of them survives to the wire, the
 * run aborts before the request is sent.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// --- load .env.local without printing anything from it -------------------

for (const line of readFileSync(resolve(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (match) process.env[match[1]] ??= match[2].trim();
}

import { createAiClient, type AiProviderName, type AiRequest } from '../packages/ai/src/provider';
import type { ScoringOutput } from '../packages/ai/src/schemas';

interface CallRecord {
  label: string;
  ok: boolean;
  ms: number;
  attempts?: number;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}
import {
  artifactAnalysisPrompt,
  scoringPrompt,
} from '../packages/ai/src/prompts';
import {
  artifactAnalysisSchema,
  scoringOutputSchema,
} from '../packages/ai/src/schemas';
import { redactDeep, assertNoCredentialShapedContent } from '../packages/ai/src/redaction';
import { canDispatchToProvider } from '../packages/ai/src/evaluation-mode';
import { RUBRIC_CATEGORIES } from '../packages/shared/src/rubric/index';

const log = (...args: unknown[]) => process.stdout.write(`${args.join(' ')}\n`);
const rule = () => log('─'.repeat(74));

// --- the synthetic submission -------------------------------------------

/**
 * Fictional throughout. The names, email, phone and password below are planted
 * bait: they must be gone before anything is sent.
 */
const SYNTHETIC = {
  submissionId: 'SUB-SYNTHETIC0001',
  teamNames: ['Priya Sharma', 'Arjun Rao'],
  ideaTitle: 'Clinic appointment reminder tool',
  ideaMinimumFlow: [
    'Add a patient with a phone number',
    'Book an appointment for that patient',
    'See the appointment in a list',
    'Mark it as confirmed',
  ],
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

// --- guard: would this even be allowed to dispatch? ----------------------

rule();
log('CONTROLLED SYNTHETIC AI RUN');
rule();

const mode = (process.env.AI_EVALUATION_MODE ?? 'synthetic_only') as 'synthetic_only' | 'production';
const decision = canDispatchToProvider(mode, {
  isDemoCohort: true,
  isSyntheticSubmission: true,
  cohortName: 'Synthetic fixture cohort',
  correlationId: SYNTHETIC.submissionId,
});

log(`Provider          ${process.env.AI_PROVIDER}`);
log(`Model             ${process.env.AI_MODEL}`);
log(`Evaluation mode   ${mode}`);
log(`Dispatch allowed  ${decision.allowed} (synthetic fixture data)`);
if (!decision.allowed) {
  log(`\nREFUSED: ${decision.reason}`);
  process.exit(1);
}

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

rule();
log('PAYLOAD INSPECTION — before anything is sent');
rule();

let leaked = false;
for (const secret of PLANTED) {
  const present = analysisUser.includes(secret);
  if (present) leaked = true;
  log(`  ${present ? 'LEAKED  ' : 'removed '} ${secret}`);
}

// Structural backstop, same one the pipeline uses.
try {
  assertNoCredentialShapedContent({ analysisUser });
  log('  passed   credential-shape assertion');
} catch (error) {
  leaked = true;
  log(`  FAILED   credential-shape assertion: ${error.message}`);
}

if (leaked) {
  log('\nABORTED before sending. Planted data survived redaction.');
  process.exit(1);
}

log(`\nPayload length    ${analysisUser.length} characters`);
log('Identifier sent   ' + SYNTHETIC.submissionId + ' (synthetic, not a team id)');

// Stop here when only the payload matters — lets the redaction be verified
// without spending a single token.
if (process.argv.includes('--inspect-only')) {
  rule();
  log('INSPECT ONLY — no request was sent.');
  rule();
  process.exit(0);
}

async function main(): Promise<void> {
// --- the run -------------------------------------------------------------

const client = createAiClient({
  provider: process.env.AI_PROVIDER as AiProviderName,
  model: process.env.AI_MODEL,
  apiKey: process.env.AI_API_KEY,
  maxRetries: Number(process.env.AI_MAX_RETRIES ?? 2),
  timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 60_000),
});

const calls: CallRecord[] = [];

async function call<T>(label: string, request: AiRequest<T>) {
  const startedAt = Date.now();
  try {
    const response = await client.run(request);
    calls.push({
      label,
      ok: true,
      attempts: response.attempts,
      ms: Date.now() - startedAt,
      usage: response.usage,
    });
    return response;
  } catch (error) {
    calls.push({ label, ok: false, ms: Date.now() - startedAt, error: (error as Error).message });
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

log(`Schema            VALID (${analysis.attempts} attempt${analysis.attempts === 1 ? '' : 's'})`);
log(`Tokens            ${analysis.usage.inputTokens} in / ${analysis.usage.outputTokens} out`);
log(`Model reported    ${analysis.modelVersion}`);
log('\nExtracted:');
log(JSON.stringify(analysis.data, null, 2).split('\n').slice(0, 40).join('\n'));

rule();
log('CALL 2 — rubric scoring');
rule();

const scoringUser = scoringPrompt.user({
  submissionId: SYNTHETIC.submissionId,
  ideaTitle: SYNTHETIC.ideaTitle,
  writtenSummary: JSON.stringify(analysis.data.writtenAnalysis ?? analysis.data),
  deckAnalysis: JSON.stringify(analysis.data.deckAnalysis ?? {}),
  videoAnalysisLimited: true,
  videoLimitationReason: 'The system cannot watch video.',
  preflightSummary: 'product_url_present: pass. product_url_reachable: pass (820ms). deck_present: pass.',
  browserEvidence: [
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
  ].join('\n'),
  testPlanSummary: 'Exercise the declared core flow: add patient, book, list, confirm.',
});

// Second payload, same inspection.
for (const secret of PLANTED) {
  if (scoringUser.includes(secret)) {
    log(`ABORTED: planted value "${secret}" reached the scoring payload.`);
    process.exit(1);
  }
}
assertNoCredentialShapedContent({ scoringUser });
log('Payload clean     no planted PII or credential present');

const scoring = await call('scoring', {
  promptVersion: scoringPrompt.version,
  system: scoringPrompt.system,
  user: scoringUser,
  schema: scoringOutputSchema,
  correlationId: SYNTHETIC.submissionId,
  maxOutputTokens: 8192,
});

log(`Schema            VALID (${scoring.attempts} attempt${scoring.attempts === 1 ? '' : 's'})`);
log(`Tokens            ${scoring.usage.inputTokens} in / ${scoring.usage.outputTokens} out`);

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

log(`\n  ${'TOTAL'.padEnd(20)} ${total.toFixed(1)} / 100`);
log(`  All 8 categories scored: ${coveredAll}`);

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

const deckDemo = byKey.get('deck_demo');
log(
  `  deck_demo records the unwatched video as missing evidence: ` +
    `${(deckDemo?.missingEvidence?.length ?? 0) > 0}`,
);

rule();
log('SUMMARY');
rule();

const totals = calls.reduce(
  (acc, c) => ({
    inputTokens: acc.inputTokens + (c.usage?.inputTokens ?? 0),
    outputTokens: acc.outputTokens + (c.usage?.outputTokens ?? 0),
  }),
  { inputTokens: 0, outputTokens: 0 },
);

for (const c of calls) {
  log(
    `  ${c.label.padEnd(18)} ${c.ok ? 'ok' : 'FAILED'}  ${String(c.ms).padStart(6)}ms  ` +
      `attempts ${c.attempts ?? '-'}  ${c.usage ? `${c.usage.inputTokens}/${c.usage.outputTokens} tokens` : c.error ?? ''}`,
  );
}
log(`\n  API calls made    ${calls.length}`);
log(`  Total tokens      ${totals.inputTokens} in / ${totals.outputTokens} out`);
log('  Supabase          not contacted (no client constructed, no connection opened)');
log('  Data source       synthetic fixture defined in this script');
rule();

}

main().catch((error) => {
  log(`\nRUN FAILED: ${(error as Error).message}`);
  process.exit(1);
});
