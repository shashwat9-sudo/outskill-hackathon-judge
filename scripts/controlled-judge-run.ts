/**
 * Phase 7 — the controlled real-browser judging run.
 *
 * Drives the ACTUAL pipeline end to end: the real worker stages, a real
 * Playwright browser navigating a real HTTP server, and real Gemini calls. The
 * only substitution is the database, which is PGlite — a genuine Postgres
 * engine running the real migrations, in process.
 *
 * That substitution is deliberate. The acceptance Supabase project holds group
 * 901's final submission; a judging run against it would write assessment rows
 * beside real acceptance data and put learner content one bug away from a
 * provider payload. Nothing about the pipeline changes: the same repositories,
 * the same SQL, the same stages.
 *
 * Everything the model sees is invented in this file. The product under test is
 * the local fixture app, which ships with known defects so detection can be
 * checked against ground truth rather than assumed.
 *
 *   npm run judge:controlled
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createAiClient } from '../packages/ai/src/provider';
import { canDispatchToProvider } from '../packages/ai/src/evaluation-mode';
import { createTestDatabase } from '../packages/shared/src/data/postgres/testing/pglite';
import { composePostgresDataStore } from '../packages/shared/src/data/postgres/store';
import { createInMemoryStorage } from '../packages/shared/src/data/postgres/storage';
import { Logger } from '../packages/shared/src/utils/logger';
import { loadEnv } from '../packages/shared/src/config/env';
import { runStage, type StageContext } from '../apps/worker/src/pipeline';
import { createFixtureApp, KNOWN_DEFECTS } from '../apps/worker/src/testing/fixture-app/server';
import { RUBRIC_CATEGORIES } from '../packages/shared/src/rubric/index';
import type { AssessmentStage } from '../packages/shared/src/domain/status';

const log = (...parts: unknown[]) => process.stdout.write(`${parts.join(' ')}\n`);
const rule = () => log('─'.repeat(76));

function loadEnvFile(): void {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key) process.env[key] ??= (value ?? '').trim();
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  // This is a test run, and the executor deliberately refuses a private origin
  // when NODE_ENV says production — so saying otherwise would be a lie that
  // disables a guard.
  process.env.NODE_ENV = 'test';
  const env = loadEnv();

  rule();
  log('PHASE 7 — CONTROLLED REAL-BROWSER JUDGING RUN');
  rule();

  // --- the guard, before anything is built ---------------------------------
  const decision = canDispatchToProvider(env.AI_EVALUATION_MODE, {
    isDemoCohort: true,
    isSyntheticSubmission: true,
    cohortName: 'Synthetic judging fixture',
    correlationId: 'PHASE7',
  });
  log(`Provider          ${env.AI_PROVIDER}`);
  log(`Model             ${env.AI_MODEL}`);
  log(`Evaluation mode   ${env.AI_EVALUATION_MODE}`);
  log(`Dispatch allowed  ${decision.allowed}`);
  if (!decision.allowed) {
    log('\nREFUSED — nothing was sent.');
    process.exit(1);
  }

  // --- the product under test ----------------------------------------------
  const server = createFixtureApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const productUrl = `http://127.0.0.1:${port}`;
  log(`Product under test ${productUrl} (local fixture, known defects)`);

  const evidenceRoot = `${process.cwd()}/test-results/phase7-evidence`;
  mkdirSync(evidenceRoot, { recursive: true });

  // --- a real Postgres engine, real schema ---------------------------------
  const db = await createTestDatabase();
  await db.query(
    `insert into rubric_versions (version, name, is_active) values ('rubric-v2', 'Phase 7', true)`,
  );

  const store = composePostgresDataStore(db, createInMemoryStorage(), {
    sessionSecret: 'phase7-secret-long-enough-for-hmac-use',
    credentialKey: 'a'.repeat(64),
    credentialKeyVersion: 1,
  });

  const cohort = await store.cohorts.createCohort({
    name: 'SYNTHETIC JUDGING FIXTURE',
    code: 'PHASE7',
    description: '',
    timezone: 'Asia/Kolkata',
    day12StartAt: new Date(Date.now() - 86_400_000),
    day13DeadlineAt: new Date(Date.now() + 86_400_000),
    shortlistTarget: 10,
    submissionInstructions: '',
    rubricVersion: 'rubric-v2',
    assessmentConfig: {
      workerConcurrency: 1,
      browserBudgetMs: 240_000,
      maxAttempts: 3,
      retryBackoffMs: 1_000,
      gracePeriodMs: 0,
      consistencyTopN: 20,
      lowConfidenceThreshold: 0.6,
      modelVersion: env.AI_MODEL ?? 'gemini',
      promptVersion: 'assessment-prompts-v1',
    },
    status: 'draft',
    closedAt: null,
    closureType: null,
    acceptingUntil: null,
  });

  const { rows: ideaRows } = await db.query<{ id: string }>(
    `insert into cohort_ideas
       (cohort_id, slug, title, description, target_user, expected_use_case,
        minimum_core_flow, expected_entities, is_active)
     values ($1, 'task-tracker', 'Simple task tracker',
             'A tool for tracking a short list of tasks.', 'A person with a to-do list',
             'Create a task, see it listed, mark it done.',
             '["Create a task","See it in the list","Mark it complete"]'::jsonb,
             '{"task"}', true)
     returning id`,
    [cohort.id],
  );
  const ideaId = ideaRows[0]!.id;

  await store.teams.importLearnerAllocation(cohort.id, [
    { groupNumber: 1, whatsappLink: null, learners: [{ name: 'Synthetic Builder', email: 's@fixture.test' }] },
  ]);
  const [team] = await store.teams.listTeams(cohort.id);

  // Every value below is invented for this run.
  const { rows: subRows } = await db.query<{ id: string }>(
    `insert into submissions
       (cohort_id, team_id, idea_id, status, product_name, primary_user, exact_problem,
        one_sentence_promise, brief_description, why_ai_necessary, differentiation,
        must_have_workflow, should_have_features, excluded_features, product_url,
        login_required, core_test_steps, safe_sample_inputs, reset_instructions,
        known_limitations, bugs_fixed, deliberately_excluded, major_tradeoff,
        day12_to_day13_changes, most_important_learning, next_seven_day_plan,
        builder_stack, apis_used, external_templates, submitted_at, locked_at, receipt_id)
     values ($1,$2,$3,'locked',
       'Fixture Task Tracker','Someone with a short list of tasks',
       'Tasks written on paper get lost and nothing shows what is still outstanding.',
       'Fixture Task Tracker lets you add a task, see it listed and mark it done.',
       'A minimal task list built to exercise an automated judge.',
       'AI summarises what is outstanding so the list can be read at a glance.',
       'Most trackers are heavyweight; this one does three things well.',
       'Create a task, see it appear in the list, mark it complete.',
       '{"Task summary"}',
       'Sharing, reminders and mobile apps were left out deliberately.',
       $4,false,
       '[{"action":"Create a task called OUTSKILL-JUDGE-TASK","expected":"It appears in the list"},{"action":"Mark it complete","expected":"It shows as done"}]'::jsonb,
       'Use only names beginning OUTSKILL-JUDGE-.',
       'Delete any task whose name begins with OUTSKILL-JUDGE-.',
       'The archive button does nothing yet and the mobile layout is rough.',
       '[{"description":"The list did not refresh after adding a task","howFixed":"Re-render after the write"},{"description":"Empty names were accepted","howFixed":"Added validation"},{"description":"Completed tasks were not visually distinct","howFixed":"Added a done style"}]'::jsonb,
       'Sharing and reminders were excluded to keep the core flow solid.',
       'Chose a single-page app over a framework to keep the build simple.',
       'Added the completion flow and fixed the refresh bug on Day 13.',
       'Building the smallest thing that works first made the rest easier.',
       'Fix the archive button, then improve the mobile layout.',
       'Plain HTML and a small Node server.','None.','None.',
       now(), now(), 'OSK-PHASE7-001-TEST')
     returning id`,
    [cohort.id, team!.id, ideaId, productUrl],
  );
  const submissionId = subRows[0]!.id;

  // --- run the real pipeline ------------------------------------------------
  const ai = createAiClient({
    provider: env.AI_PROVIDER,
    model: env.AI_MODEL,
    apiKey: env.AI_API_KEY,
    maxRetries: env.AI_MAX_RETRIES,
    timeoutMs: env.AI_TIMEOUT_MS,
  });

  const ctx: StageContext = {
    store,
    ai,
    env,
    workerId: 'phase7-worker',
    evidenceRoot,
    log: new Logger({ name: 'phase7' }),
    // The product under test is a fixture on this machine. Never set by the
    // worker; see worker-security.test.ts.
    allowPrivateProductUrlForControlledRun: true,
    // Every value in this database was written by this file. Stated explicitly
    // rather than inferred, because the guard is right to treat Postgres as
    // real by default.
    contentIsSyntheticForControlledRun: true,
  };

  await store.assessment.enqueueCohort(cohort.id);
  const [claimed] = await store.assessment.claimJobs({
    workerId: 'phase7-worker',
    limit: 1,
    leaseSeconds: 900,
  });
  if (!claimed) throw new Error('nothing was queued');

  rule();
  log('PIPELINE');
  rule();

  let job = claimed;
  const visited: AssessmentStage[] = [];
  const terminal: AssessmentStage[] = ['completed', 'failed', 'manual_review', 'disqualified'];

  for (let guard = 0; guard < 12 && !terminal.includes(job.stage); guard += 1) {
    const startedAt = Date.now();
    const outcome = await runStage(job, ctx);
    const ms = Date.now() - startedAt;
    log(`  ${job.stage.padEnd(22)} → ${outcome.stage.padEnd(20)} ${String(ms).padStart(6)}ms${outcome.error ? `  ${outcome.error}` : ''}`);
    visited.push(job.stage);
    job = await store.assessment.advanceStage(job.id, outcome.stage, outcome.error ?? null);
  }
  log(`  final stage: ${job.stage}`);

  // --- what the run actually produced --------------------------------------
  rule();
  log('BROWSER EVIDENCE');
  rule();

  const runs = await store.assessment.listBrowserRuns(job.id);
  let totalSteps = 0;
  let passedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;
  for (const run of runs) {
    totalSteps += run.steps.length;
    passedSteps += run.steps.filter((s) => s.status === 'passed').length;
    failedSteps += run.steps.filter((s) => s.status === 'failed').length;
    skippedSteps += run.steps.filter((s) => s.status === 'skipped').length;
    log(
      `  ${run.viewport.padEnd(8)} status=${run.status.padEnd(8)} steps=${String(run.steps.length).padStart(2)} ` +
        `console=${run.consoleErrorCount} network=${run.networkFailureCount} a11y=${run.a11yViolationCount} ` +
        `cleanup=${run.cleanupStatus} timedOut=${run.timedOut}`,
    );
  }
  log(`  steps: ${totalSteps} total — ${passedSteps} passed, ${failedSteps} failed, ${skippedSteps} skipped`);

  const plan = await store.assessment.getTestPlan(job.id);
  log(`\n  test plan: ${plan?.stepCount ?? 0} steps, validation=${plan?.validationStatus ?? '-'}, rejected=${plan?.rejectedSteps.length ?? 0}`);
  for (const step of plan?.steps ?? []) {
    log(`    ${String(step.stepIndex).padStart(2)} ${JSON.stringify(step.step).slice(0, 96)}`);
  }

  log('\n  step results:');
  for (const run of runs) {
    for (const step of run.steps) {
      const mark = step.status === 'passed' ? 'ok  ' : step.status === 'skipped' ? 'skip' : 'FAIL';
      log(`    ${run.viewport.slice(0, 4)} ${mark} ${String(step.stepIndex).padStart(2)} ${step.action.padEnd(16)} ${(step.errorMessage ?? '').slice(0, 70)}`);
    }
  }

  // Written into evidenceRoot/<submissionId>/screenshots, so this walks.
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
      entries.map(async (e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])),
    );
    return nested.flat();
  };
  const files = await walk(evidenceRoot);
  const screenshots = files.filter((f) => f.endsWith('.png'));
  const traces = files.filter((f) => f.endsWith('.zip'));
  log(`  evidence on disk: ${screenshots.length} screenshot(s), ${traces.length} trace(s)`);

  log('\n  ground truth in the fixture (should be detected):');
  log(`    dead button           #${KNOWN_DEFECTS.deadButtonId}`);
  log(`    console error         "${KNOWN_DEFECTS.consoleErrorFragment}"`);
  log(`    failing request       ${KNOWN_DEFECTS.failingRequestPath}`);
  log(`    a11y violations       ${KNOWN_DEFECTS.accessibilityViolations.join(', ')}`);

  rule();
  log('RUBRIC');
  rule();

  const scores = await store.assessment.listScores(job.id);
  let total = 0;
  for (const category of RUBRIC_CATEGORIES) {
    const scored = scores.find((s) => s.categoryKey === category.key);
    if (!scored) {
      log(`  ${category.key.padEnd(20)} MISSING`);
      continue;
    }
    total += scored.weightedScore;
    log(
      `  ${category.key.padEnd(20)} ${String(scored.rawScore).padStart(5)} / ${String(category.maxPoints).padEnd(3)} ` +
        `conf ${scored.confidence.toFixed(2)}  ${scored.rationale.slice(0, 58)}`,
    );
  }
  log(`\n  TOTAL ${total.toFixed(1)} / 100   (${scores.length}/8 categories scored)`);

  const summary = await store.assessment.getSummary(job.id);
  if (summary) {
    log(`  mean confidence ${summary.meanConfidence.toFixed(2)}  low-confidence flag: ${summary.lowConfidence}`);
    log(`  strengths ${summary.strengths.length}  weaknesses ${summary.weaknesses.length}  bugs ${summary.bugsFound.length}`);
    for (const bug of summary.bugsFound.slice(0, 4)) log(`    [${bug.severity}] ${bug.description.slice(0, 70)}`);
  }

  const evidence = await store.assessment.listEvidence(job.id);
  const stances = evidence.reduce<Record<string, number>>((acc, e) => {
    acc[e.stance] = (acc[e.stance] ?? 0) + 1;
    return acc;
  }, {});
  log(`  evidence rows: ${evidence.length} ${JSON.stringify(stances)}`);

  const feedback = await store.assessment.getFeedbackReport(submissionId);
  log(`  feedback report: ${feedback ? 'generated' : 'none'}${feedback ? `, exposed=${feedback.isExposedToParticipant}` : ''}`);

  const flags = await store.assessment.listManualReviewFlags(cohort.id);
  log(`  manual-review flags: ${flags.length}${flags.length ? ` (${flags.map((f) => f.reasonCode).join(', ')})` : ''}`);

  rule();
  log('RANKING');
  rule();

  const snapshot = await store.ranking.generateSnapshot(cohort.id, 'phase 7 controlled run');
  const current = await store.ranking.getCurrentSnapshot(cohort.id);
  log(`  eligible: ${snapshot.eligibleCount}   shortlist target: ${snapshot.shortlistTarget}`);
  for (const entry of current?.entries ?? []) {
    log(
      `  rank ${entry.entry.rank}  group ${entry.groupNumber}  ${entry.entry.totalScore.toFixed(1)}  ` +
        `shortlist=${entry.entry.inShortlist}  lowConfidence=${entry.lowConfidence}`,
    );
  }
  log(`  final selections (must be empty — humans choose): ${(await store.ranking.listFinalSelections(cohort.id)).length}`);

  rule();
  log('CREDENTIAL AND PII BOUNDARY');
  rule();
  const analysis = await db.query<Record<string, unknown>>(
    'select written_analysis, deck_analysis, injection_flags from artifact_analyses where job_id = $1',
    [job.id],
  );
  const serialised = JSON.stringify(analysis.rows[0] ?? {});
  for (const forbidden of ['password', 'demoPassword', 's@fixture.test']) {
    log(`  stored analysis contains "${forbidden}": ${serialised.includes(forbidden)}`);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();

  rule();
  log(`RESULT: reached ${job.stage}, ${scores.length}/8 categories, ${totalSteps} browser steps`);
  rule();
}

main().catch((error) => {
  log(`\nRUN FAILED: ${(error as Error).message}`);
  process.exit(1);
});
