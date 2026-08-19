/**
 * Pipeline stages.
 *
 * One function per stage. Each takes a claimed job, does its work, persists its
 * output, and returns the stage to move to. Diverting to `manual_review` or
 * `failed` is a normal return value, not an exception — routing a submission to
 * a human is an outcome, not an error.
 */

import { mkdir, rm } from 'node:fs/promises';
import {
  RUBRIC_CATEGORIES,
  anonymiseSubmissionId,
  getMaxPoints,
  isCompleteScoreSet,
  roundToQuarter,
  totalScore,
  validatePlanSteps,
  weightedScore,
  type AssessmentJob,
  type AssessmentStage,
  type JudgingInput,
  type DataStore,
  type Env,
  type Logger,
  type RubricCategoryKey,
} from '@ohj/shared';
import {
  artifactAnalysisPrompt,
  artifactAnalysisSchema,
  assertDispatchAllowed,
  assertNoCredentialShapedContent,
  consistencyOutputSchema,
  consistencyPrompt,
  detectInjection,
  feedbackOutputSchema,
  feedbackPrompt,
  redactDeep,
  scoringOutputSchema,
  scoringPrompt,
  shouldRouteToManualReview,
  testPlanOutputSchema,
  testPlanPrompt,
  validateFeedbackSafety,
  validateScoreCeilings,
  type AiClient,
} from '@ohj/ai';
import { runPreflight } from './preflight';
import { extractPdfText } from './pdf';
import { runBrowserPlan, summariseRun, type BrowserRunResult } from './browser-runner';
import type { EvidenceUploader } from './evidence-upload';

/**
 * Every personal name the system already holds for a submission.
 *
 * Passed to redaction, which cannot detect a name by pattern — only by knowing
 * it. Nulls are dropped rather than coerced to '': a team imported from the
 * learner allocation sheet has no lead name, and `redactKnownNames` splits
 * every entry it is given, so a null would throw before anything was redacted.
 */
function knownNames(detail: { team: { leadName: string | null }; members: { fullName: string }[] }): string[] {
  return [detail.team.leadName, ...detail.members.map((m) => m.fullName)].filter(
    (name): name is string => typeof name === 'string' && name.trim().length > 0,
  );
}


export interface StageContext {
  store: DataStore;
  ai: AiClient;
  env: Env;
  workerId: string;
  evidenceRoot: string;
  /**
   * How captured evidence becomes durable.
   *
   * Absent in unit tests and in demo mode, where nothing is uploaded and the
   * database simply records no evidence — which is honest. Never a local path.
   */
  evidence?: EvidenceUploader;
  log: Logger;
  /**
   * Only the controlled judging run sets this, to reach a fixture served from
   * this machine. The worker never does — see `worker-security.test.ts`.
   */
  allowPrivateProductUrlForControlledRun?: boolean;
  /**
   * Declare that this job's content is synthetic.
   *
   * `synthetic_only` decides what may leave for a provider by asking the store
   * driver, and treats every Postgres cohort as real — deliberately, because
   * that is where learner work lives and a wrong answer sends someone's deck to
   * a free tier.
   *
   * The controlled judging run is the one case that rule cannot see: a Postgres
   * engine holding nothing but fixtures. Rather than teach the guard to guess,
   * the caller states it, and only that caller may. The worker never sets it —
   * `worker-security.test.ts` asserts so.
   */
  contentIsSyntheticForControlledRun?: boolean;
}

export interface StageOutcome {
  stage: AssessmentStage;
  error?: string;
}

/**
 * May this job's content reach an external model?
 *
 * Called before every provider call, not once at startup: the mode can change
 * between a worker starting and a job being claimed, and a check that ran only
 * at boot would let a restart-free worker keep sending.
 *
 * "Synthetic" is derived from the store driver rather than a column on the
 * cohort. The memory driver *is* the demo fixtures; the Postgres driver holds
 * real learner work, all of it. That means `synthetic_only` refuses every
 * Postgres cohort, which is the intended reading — the free tier should not
 * receive anything out of the production database, whatever it is labelled.
 *
 * The demo provider is exempt because it makes no network call at all. There is
 * no boundary to protect when nothing crosses one.
 */
function guardDispatch(
  job: AssessmentJob,
  cohort: { id: string; name: string; isSynthetic: boolean },
  ctx: StageContext,
): void {
  if (ctx.ai.providerName === 'demo') return;

  /*
   * Whether this may leave for a provider is a fact about the cohort, read
   * from the cohort.
   *
   * It used to be inferred from the database driver: memory meant synthetic,
   * Postgres meant real. That was safe in the direction that mattters and wrong
   * in the other — a fixture cohort in production Postgres was indistinguishable
   * from the learner cohorts beside it, so the deployed worker could not be
   * proven end to end without relaxing `synthetic_only` for everything at once.
   *
   * `is_synthetic` is persisted, defaults to false, cannot be expressed by the
   * create or update types, and is never derived from a name, a group number,
   * an email domain, DEMO_MODE or the driver. Each of those can be accidentally
   * true for a cohort full of real work.
   *
   * `contentIsSyntheticForControlledRun` remains for the controlled run script,
   * which operates on a database it has just built. The worker never sets it.
   */
  const isSynthetic = cohort.isSynthetic || ctx.contentIsSyntheticForControlledRun === true;
  assertDispatchAllowed(ctx.env.AI_EVALUATION_MODE, {
    isDemoCohort: isSynthetic,
    isSyntheticSubmission: isSynthetic,
    cohortName: cohort.name,
    correlationId: anonymiseSubmissionId(job.submissionId, cohort.id),
  });
}

export async function runStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  switch (job.stage) {
    case 'queued':
      return { stage: 'preflight' };
    case 'preflight':
      return preflightStage(job, ctx);
    case 'artifact_analysis':
      return artifactAnalysisStage(job, ctx);
    case 'test_plan_generation':
      return testPlanStage(job, ctx);
    case 'browser_testing':
      return browserTestingStage(job, ctx);
    case 'evidence_review':
      return { stage: 'scoring' };
    case 'scoring':
      return scoringStage(job, ctx);
    case 'consistency_review':
      return consistencyStage(job, ctx);
    default:
      return { stage: job.stage };
  }
}

// --------------------------------------------------------------------------
// Preflight
// --------------------------------------------------------------------------

async function preflightStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  const detail = await ctx.store.assessment.getJudgingInput(job.submissionId);
  if (!detail) return { stage: 'failed', error: 'Submission not found.' };

  const deck = detail.artifacts.find((a) => a.kind === 'deck_pdf');
  const video = detail.artifacts.find((a) => a.kind === 'demo_video');
  const credentials = await ctx.store.submissions.getCredentials(job.submissionId);

  const outcome = await runPreflight(
    {
    submissionId: job.submissionId,
    productUrl: detail.submission.productUrl,
    demoVideoUrl: video?.externalUrl ?? null,
    hasDeckPdf: Boolean(deck),
    deckReadable: Boolean(deck),
    deckPageCount: null,
    loginRequired: detail.submission.loginRequired,
    hasCredentials: Boolean(credentials?.passwordCiphertext),
    ideaIsApproved: Boolean(detail.idea?.isActive),
    isComplete: detail.submission.status === 'locked' || detail.submission.status === 'submitted',
    isLate: detail.submission.isLate,
      attemptNumber: job.attemptCount + 1,
    },
    // Undefined in production, so `runPreflight` applies its defaults.
    ctx.allowPrivateProductUrlForControlledRun
      ? { allowPrivateProductUrlForControlledRun: true }
      : {},
  );

  await ctx.store.assessment.recordPreflight(job.id, outcome.checks);

  if (outcome.needsManualReview) {
    await ctx.store.assessment.raiseManualReview({
      submissionId: job.submissionId,
      reasonCode: 'unsupported_product_type',
      detail: outcome.manualReviewReason ?? 'Preflight could not confirm this product can be tested automatically.',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });
    return { stage: 'manual_review' };
  }

  if (!outcome.canProceed) {
    // An outage is retried rather than failed — a host being down during our
    // window is not the team's product failing.
    if (outcome.looksLikeOutage && job.attemptCount + 1 < job.maxAttempts) {
      throw new Error('Product was unreachable; classified as a possible outage and will be retried.');
    }
    return { stage: 'failed', error: 'Preflight could not confirm the product is reachable.' };
  }

  return { stage: 'artifact_analysis' };
}

// --------------------------------------------------------------------------
// Artifact analysis
// --------------------------------------------------------------------------

async function artifactAnalysisStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  const detail = await ctx.store.assessment.getJudgingInput(job.submissionId);
  if (!detail) return { stage: 'failed', error: 'Submission not found.' };

  const anonId = anonymiseSubmissionId(job.submissionId, detail.cohort.id);
  guardDispatch(job, detail.cohort, ctx);
  const deck = detail.artifacts.find((a) => a.kind === 'deck_pdf');
  const video = detail.artifacts.find((a) => a.kind === 'demo_video');

  const deckExtraction = deck?.storagePath
    ? await extractPdfText(deck.storagePath).catch(() => null)
    : null;

  // Video is not fetched or transcribed in Version 1. Being explicit beats
  // inventing content (ADR-015).
  const videoAnalysisLimited = !video?.externalUrl || video.isAccessible === false;
  const videoLimitationReason = !video?.externalUrl
    ? 'No demo video link was supplied.'
    : video.isAccessible === false
      ? 'The demo link could not be retrieved. No video content has been inferred.'
      : 'Video content is not analysed in this version. No video content has been inferred.';

  const writtenSubmission = buildWrittenSubmission(detail);
  const deckText = deckExtraction?.text ?? '';

  const injectionFlags = [
    ...detectInjection(writtenSubmission, 'written'),
    ...detectInjection(deckText, 'deck'),
  ];

  // Redaction happens before the payload is built (ADR-009).
  const names = knownNames(detail);
  const redactedWritten = redactDeep(writtenSubmission, names);
  const redactedDeck = redactDeep(deckText, names);

  // Credentials are NOT decrypted here.
  //
  // This used to call revealCredentials purely to assert the plaintext was
  // absent from the payload. That check created the exposure it was testing
  // for: the plaintext sat in worker memory at the exact moment an AI payload
  // was being assembled, so a throw between those lines could have put it in a
  // stack trace or an error log.
  //
  // The real guarantee is structural. The payload below is built from an
  // explicit field list and there is no credential field in it, so there is no
  // path for one to be included — which `credential-boundary.test.ts` proves by
  // walking every argument this stage passes to the model.
  //
  // Plaintext is resolved once, in the browser stage, at the moment a form is
  // actually filled. That is the only place it is needed.
  assertNoCredentialShapedContent({ redactedWritten, redactedDeck });

  const response = await ctx.ai.run({
    promptVersion: artifactAnalysisPrompt.version,
    system: artifactAnalysisPrompt.system,
    user: artifactAnalysisPrompt.user({
      submissionId: anonId,
      ideaTitle: detail.idea?.title ?? 'unknown',
      ideaMinimumFlow: detail.idea?.minimumCoreFlow ?? [],
      writtenSubmission: redactedWritten,
      deckText: redactedDeck,
      deckPageCount: deckExtraction?.pageCount ?? null,
      transcript: null,
    }),
    schema: artifactAnalysisSchema,
    correlationId: anonId,
  });

  await ctx.store.assessment.saveArtifactAnalysis({
    jobId: job.id,
    deckPageCount: deckExtraction?.pageCount ?? null,
    deckTextExtracted: Boolean(deckExtraction?.text),
    deckAnalysis: response.data.deck,
    videoAnalysisLimited,
    videoLimitationReason: videoAnalysisLimited ? videoLimitationReason : null,
    transcriptAvailable: false,
    writtenAnalysis: response.data.written,
    injectionFlags,
    modelVersion: response.modelVersion,
    promptVersion: response.promptVersion,
  });

  // An injection attempt is a review signal, never a penalty and never a
  // disqualification ground.
  if (shouldRouteToManualReview(injectionFlags)) {
    await ctx.store.assessment.raiseManualReview({
      submissionId: job.submissionId,
      reasonCode: 'prompt_injection_detected',
      detail:
        'Instruction-like content aimed at an automated judge was found in participant material. It was treated as data and never followed. Flagged for a human to look at; this is not a scoring penalty.',
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });
  }

  return { stage: 'test_plan_generation' };
}

// --------------------------------------------------------------------------
// Test plan generation
// --------------------------------------------------------------------------

async function testPlanStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  const detail = await ctx.store.assessment.getJudgingInput(job.submissionId);
  if (!detail?.submission.productUrl) return { stage: 'failed', error: 'No product URL.' };

  const anonId = anonymiseSubmissionId(job.submissionId, detail.cohort.id);
  guardDispatch(job, detail.cohort, ctx);
  const names = knownNames(detail);

  const response = await ctx.ai.run({
    promptVersion: testPlanPrompt.version,
    system: testPlanPrompt.system,
    user: testPlanPrompt.user({
      submissionId: anonId,
      productUrl: detail.submission.productUrl,
      ideaTitle: detail.idea?.title ?? 'unknown',
      ideaMinimumFlow: detail.idea?.minimumCoreFlow ?? [],
      ideaEntities: detail.idea?.expectedEntities ?? [],
      unsafeInterpretations: detail.idea?.unsafeInterpretations ?? '',
      declaredWorkflow: redactDeep(detail.submission.mustHaveWorkflow ?? '', names),
      declaredSteps: detail.submission.coreTestSteps,
      sampleInputs: redactDeep(detail.submission.safeSampleInputs ?? '', names),
      knownLimitations: redactDeep(detail.submission.knownLimitations ?? '', names),
      loginRequired: detail.submission.loginRequired,
      budgetMs: detail.cohort.assessmentConfig.browserBudgetMs,
    }),
    schema: testPlanOutputSchema,
    correlationId: anonId,
    maxOutputTokens: 8000,
  });

  // Validated a second time, step by step. Rejections are recorded rather than
  // silently dropped, so a systematically broken generator is visible.
  const validated = validatePlanSteps(response.data.steps);

  if (validated.steps.length === 0) {
    return { stage: 'manual_review', error: 'No valid test steps could be generated.' };
  }

  await ctx.store.assessment.saveTestPlan(
    {
      jobId: job.id,
      generatedFrom: { idea: detail.idea?.slug, declaredSteps: detail.submission.coreTestSteps.length },
      stepCount: validated.steps.length,
      estimatedDurationMs: response.data.estimatedDurationMs,
      modelVersion: response.modelVersion,
      promptVersion: response.promptVersion,
      validationStatus: validated.rejected.length === 0 ? 'valid' : 'partial',
      rejectedSteps: validated.rejected,
      summary: response.data.summary,
    },
    validated.steps.map((step, index) => ({
      stepIndex: index,
      step,
      isCleanup: step.isCleanup ?? false,
      rationale: step.rationale ?? null,
    })),
  );

  return { stage: 'browser_testing' };
}

// --------------------------------------------------------------------------
// Browser testing
// --------------------------------------------------------------------------

async function browserTestingStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  const detail = await ctx.store.assessment.getJudgingInput(job.submissionId);
  const plan = await ctx.store.assessment.getTestPlan(job.id);
  if (!detail?.submission.productUrl || !plan) {
    return { stage: 'failed', error: 'Missing product URL or test plan.' };
  }

  const credentials = detail.submission.loginRequired
    ? await ctx.store.submissions.revealCredentials(job.submissionId)
    : null;

  const screenshotDir = `${ctx.evidenceRoot}/${job.submissionId}/screenshots`;
  const traceDir = `${ctx.evidenceRoot}/${job.submissionId}/traces`;
  await mkdir(screenshotDir, { recursive: true });
  await mkdir(traceDir, { recursive: true });

  const steps = plan.steps.map((s) => s.step);
  const budgetMs = detail.cohort.assessmentConfig.browserBudgetMs;

  const desktop = await runBrowserPlan({
    productUrl: detail.submission.productUrl,
    steps,
    credentials: credentials ? { username: credentials.username, password: credentials.password } : null,
    // Reserve a fifth of the budget for the mobile smoke test.
    budgetMs: Math.floor(budgetMs * 0.8),
    viewport: 'desktop',
    screenshotDir,
    traceDir,
    headless: ctx.env.BROWSER_HEADLESS,
    // Only the controlled run sets this, and the executor ignores it outright
    // when NODE_ENV is 'production'.
    allowPrivateOriginForTesting: ctx.allowPrivateProductUrlForControlledRun === true,
  });
  await persistRun(job.id, desktop, ctx);

  const mobile = await runBrowserPlan({
    productUrl: detail.submission.productUrl,
    steps: steps.slice(0, 6),
    credentials: credentials ? { username: credentials.username, password: credentials.password } : null,
    budgetMs: Math.floor(budgetMs * 0.2),
    allowPrivateOriginForTesting: ctx.allowPrivateProductUrlForControlledRun === true,
    viewport: 'mobile',
    screenshotDir,
    traceDir: null,
    headless: ctx.env.BROWSER_HEADLESS,
  });
  await persistRun(job.id, mobile, ctx);

  /**
   * Did the browser ever actually reach the product?
   *
   * If every navigation failed, nothing that follows is evidence about the
   * submission — the assertions failed because there was no page, the console
   * was quiet because nothing ran, and the accessibility scan found nothing to
   * scan. Scoring that produces a low mark with high confidence, which reads as
   * a judgement of the team rather than a failure of ours.
   *
   * Seen exactly once, during the controlled judging run: a navigation guard
   * blocked every load and the pipeline still produced 37/100 at 0.83
   * confidence with no flag raised. Preflight normally catches an unreachable
   * product, but it checks with a plain fetch — a site can answer that and
   * still refuse a headless browser, redirect elsewhere, or fail only under
   * automation.
   *
   * So this is checked where the browser actually ran.
   */
  /*
   * The staging directory has served its purpose.
   *
   * Both runs have been persisted and their uploads attempted, including the
   * bounded retries. Anything still here failed to upload and there is no
   * out-of-process retry that will ever read it again, so keeping it would just
   * accumulate — 400 submissions with 50 MB traces fills a container disk long
   * before the queue drains. The failures were logged with the reason at the
   * point they happened; the bytes add nothing.
   */
  await rm(`${ctx.evidenceRoot}/${job.submissionId}`, { recursive: true, force: true }).catch(
    () => {},
  );

  const outcome = classifyBrowserOutcome(desktop, mobile);

  if (outcome.nextStage === 'manual_review') {
    await ctx.store.assessment.raiseManualReview({
      submissionId: job.submissionId,
      reasonCode: outcome.reasonCode as string,
      detail: outcome.detail as string,
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });

    ctx.log.warn('Browser never reached the product — routing to manual review', {
      submissionId: job.submissionId,
    });
    return { stage: 'manual_review', error: outcome.reason as string };
  }

  return { stage: 'evidence_review' };
}

/** The shape of a browser run, as far as this decision is concerned. */
interface NavigableRun {
  steps: { action: string; status: string; errorMessage: string | null }[];
}

export interface BrowserOutcome {
  navigationSucceeded: boolean;
  nextStage: 'evidence_review' | 'manual_review';
  reasonCode: string | null;
  reason: string | null;
  detail: string | null;
}

/**
 * Did the browser ever actually reach the product?
 *
 * Extracted from the stage so it can be driven directly. The decision it makes
 * is the one that separates "this team shipped something that does not work"
 * from "we never saw what this team shipped", and the two must never be
 * confused — the first is a score, the second is a question for a human.
 *
 * One navigation that passed, in either viewport, is the whole test. A page
 * that loads and then fails every assertion IS a finding about the product; a
 * page that never loads is a finding about nothing.
 */
export function classifyBrowserOutcome(
  desktop: NavigableRun,
  mobile: NavigableRun,
): BrowserOutcome {
  const navigationSucceeded = [desktop, mobile].some((run) =>
    run.steps.some((step) => step.action === 'navigate' && step.status === 'passed'),
  );

  if (navigationSucceeded) {
    return {
      navigationSucceeded: true,
      nextStage: 'evidence_review',
      reasonCode: null,
      reason: null,
      detail: null,
    };
  }

  const reason =
    desktop.steps.find((step) => step.action === 'navigate')?.errorMessage ??
    'The browser could not open the product URL.';

  return {
    navigationSucceeded: false,
    nextStage: 'manual_review',
    reasonCode: 'browser_never_reached_product',
    reason,
    detail:
      `The browser never loaded the product, so nothing observed is evidence about this ` +
      `submission. Reported reason: ${reason}. This may be the host, the network or our own ` +
      `configuration — it is not a finding about the team.`,
  };
}

/**
 * Write the run down, then make its evidence durable.
 *
 * The paths saved here are null on purpose. The worker's local paths are not
 * evidence — they name files inside a container that is about to be replaced —
 * and a column that holds one is a row claiming something that is not there.
 * The real path is written by the confirmation, or not at all.
 */
async function persistRun(jobId: string, run: BrowserRunResult, ctx: StageContext): Promise<void> {
  const a11y = run.observations.a11yViolations;
  await ctx.store.assessment.saveBrowserRun(
    {
      jobId,
      viewport: run.viewport,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      status: run.status,
      browserVersion: run.browserVersion,
      tracePath: null,
      consoleErrorCount: run.observations.consoleErrors.length,
      networkFailureCount: run.observations.networkFailures.length,
      a11yViolationCount: a11y.length,
      a11ySummary: {
        critical: a11y.filter((v) => v.impact === 'critical').length,
        serious: a11y.filter((v) => v.impact === 'serious').length,
        moderate: a11y.filter((v) => v.impact === 'moderate').length,
        minor: a11y.filter((v) => v.impact === 'minor').length,
      },
      cleanupStatus: run.cleanupStatus,
      timedOut: run.timedOut,
    },
    run.steps.map((step) => ({
      stepIndex: step.stepIndex,
      action: step.action,
      status: step.status,
      durationMs: step.durationMs,
      screenshotPath: null,
      assertionDetail: { detail: step.detail },
      errorMessage: step.errorMessage,
    })),
  );

  await uploadRunEvidence(jobId, run, ctx);
}

/**
 * Move this run's captured files into Storage.
 *
 * Best effort by design. A failed upload leaves the local file in place and the
 * database saying there is no evidence, which is true and is the safe way to be
 * wrong. Judging continues either way: a missing screenshot is a weaker record,
 * not a reason to fail a learner's submission.
 */
async function uploadRunEvidence(
  jobId: string,
  run: BrowserRunResult,
  ctx: StageContext,
): Promise<void> {
  if (!ctx.evidence) return;

  // The ids the database assigned, which are what evidence is attached to.
  const saved = (await ctx.store.assessment.listBrowserRuns(jobId)).find(
    (r) => r.viewport === run.viewport,
  );
  if (!saved) return;

  if (run.tracePath) {
    const result = await ctx.evidence.upload({
      jobId,
      kind: 'trace',
      localPath: run.tracePath,
      runId: saved.id,
    });
    if (!result.ok) {
      ctx.log.warn('evidence.trace_not_stored', {
        jobId,
        viewport: run.viewport,
        reason: result.reason,
        retainedLocally: result.retained,
      });
    }
  }

  for (const step of run.steps) {
    if (!step.screenshotPath) continue;
    const savedStep = saved.steps.find((s) => s.stepIndex === step.stepIndex);
    if (!savedStep) continue;

    const result = await ctx.evidence.upload({
      jobId,
      kind: 'screenshot',
      localPath: step.screenshotPath,
      stepId: savedStep.id,
    });
    if (!result.ok) {
      ctx.log.warn('evidence.screenshot_not_stored', {
        jobId,
        viewport: run.viewport,
        stepIndex: step.stepIndex,
        reason: result.reason,
        retainedLocally: result.retained,
      });
    }
  }
}

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------

async function scoringStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  const detail = await ctx.store.assessment.getJudgingInput(job.submissionId);
  if (!detail) return { stage: 'failed', error: 'Submission not found.' };

  const anonId = anonymiseSubmissionId(job.submissionId, detail.cohort.id);
  guardDispatch(job, detail.cohort, ctx);
  const runs = await ctx.store.assessment.listBrowserRuns(job.id);
  const preflight = await ctx.store.assessment.listPreflight(job.id);
  const analysis = detail.artifactAnalysis;
  const plan = await ctx.store.assessment.getTestPlan(job.id);

  const browserEvidence = runs
    .map((run) =>
      summariseRun({
        viewport: run.viewport,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? run.startedAt,
        durationMs: run.durationMs ?? 0,
        timedOut: run.timedOut,
        browserVersion: run.browserVersion ?? 'unknown',
        tracePath: run.tracePath,
        steps: run.steps.map((s) => ({
          stepIndex: s.stepIndex,
          action: s.action,
          status: s.status,
          durationMs: s.durationMs,
          detail: String((s.assertionDetail as { detail?: string }).detail ?? ''),
          screenshotPath: s.screenshotPath,
          errorMessage: s.errorMessage,
        })),
        observations: {
          consoleErrors: Array.from({ length: run.consoleErrorCount }, () => ({ text: '', location: '' })),
          networkFailures: Array.from({ length: run.networkFailureCount }, () => ({
            url: '',
            status: null,
            reason: '',
          })),
          a11yViolations: [],
          createdValues: [],
        },
        cleanupStatus: run.cleanupStatus,
        error: null,
      }),
    )
    .join('\n\n');

  const response = await ctx.ai.run({
    promptVersion: scoringPrompt.version,
    system: scoringPrompt.system,
    user: scoringPrompt.user({
      submissionId: anonId,
      ideaTitle: detail.idea?.title ?? 'unknown',
      writtenSummary: JSON.stringify(analysis?.writtenAnalysis ?? {}),
      deckAnalysis: JSON.stringify(analysis?.deckAnalysis ?? {}),
      videoAnalysisLimited: analysis?.videoAnalysisLimited ?? true,
      videoLimitationReason: analysis?.videoLimitationReason ?? null,
      preflightSummary: preflight
        .map((c) => `${c.checkKey} [${c.status}] attempt ${c.attemptNumber}: ${String((c.detail as { message?: string }).message ?? '')}`)
        .join('\n'),
      browserEvidence,
      testPlanSummary: plan?.summary ?? 'No plan summary recorded.',
    }),
    schema: scoringOutputSchema,
    correlationId: anonId,
    maxOutputTokens: 8000,
  });

  const ceilings = validateScoreCeilings(response.data, (key) => getMaxPoints(key as RubricCategoryKey));
  if (!ceilings.ok) {
    return { stage: 'manual_review', error: `Scoring output was invalid: ${ceilings.problems.join('; ')}` };
  }

  const threshold = detail.cohort.assessmentConfig.lowConfidenceThreshold;

  await ctx.store.assessment.saveScores(
    job.id,
    response.data.scores.map((score) => ({
      categoryKey: score.categoryKey,
      rawScore: roundToQuarter(score.rawScore),
      maxPoints: getMaxPoints(score.categoryKey),
      weightedScore: weightedScore(score.categoryKey, score.rawScore),
      confidence: score.confidence,
      rationale: score.rationale,
      supportingEvidence: score.supportingEvidence,
      contradictoryEvidence: score.contradictoryEvidence,
      missingEvidence: score.missingEvidence,
      isOverridden: false,
      overrideReason: null,
      overriddenBy: null,
      overriddenAt: null,
      originalRawScore: null,
      modelVersion: response.modelVersion,
      promptVersion: response.promptVersion,
      rubricVersion: detail.cohort.rubricVersion,
    })),
  );

  // Evidence rows, so "every score has evidence" is a query rather than trust.
  await ctx.store.assessment.saveEvidence(
    job.id,
    response.data.scores.flatMap((score) => {
      const category = RUBRIC_CATEGORIES.find((c) => c.key === score.categoryKey);
      const type = category?.evidenceSources[0] ?? 'written';
      return [
        ...score.supportingEvidence.map((summary) => ({
          categoryKey: score.categoryKey,
          evidenceType: type,
          stance: 'supporting' as const,
          summary,
          sourceRef: { origin: 'scoring' },
          confidence: score.confidence,
        })),
        ...score.contradictoryEvidence.map((summary) => ({
          categoryKey: score.categoryKey,
          evidenceType: type,
          stance: 'contradictory' as const,
          summary,
          sourceRef: { origin: 'scoring' },
          confidence: score.confidence,
        })),
        ...score.missingEvidence.map((summary) => ({
          categoryKey: score.categoryKey,
          evidenceType: type,
          stance: 'missing' as const,
          summary,
          sourceRef: { origin: 'scoring' },
          confidence: score.confidence,
        })),
      ];
    }),
  );

  const scored = response.data.scores.map((s) => ({
    categoryKey: s.categoryKey,
    weightedScore: weightedScore(s.categoryKey, s.rawScore),
  }));
  const confidences = response.data.scores.map((s) => s.confidence);
  const minConfidence = Math.min(...confidences);

  await ctx.store.assessment.saveSummary({
    jobId: job.id,
    totalScore: totalScore(scored),
    meanConfidence: Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100,
    minConfidence,
    lowConfidence: minConfidence < threshold,
    risks: response.data.risks,
    strengths: response.data.strengths,
    weaknesses: response.data.weaknesses,
    internalNotes: null,
    bugsFound: response.data.bugsFound,
    modelVersion: response.modelVersion,
    promptVersion: response.promptVersion,
    completedAt: new Date(),
  });

  if (!isCompleteScoreSet(scored)) {
    return { stage: 'manual_review', error: 'Scoring produced an incomplete score set.' };
  }

  if (minConfidence < threshold) {
    await ctx.store.assessment.raiseManualReview({
      submissionId: job.submissionId,
      reasonCode: 'low_confidence_scores',
      detail: `At least one category scored below the confidence threshold (${minConfidence.toFixed(2)} < ${threshold}). Treat this score as provisional.`,
      raisedBy: 'system',
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
    });
  }

  await generateFeedback(job, ctx, detail, browserEvidence, response.data.bugsFound);

  // The consistency pass is selected at the cohort level after ranking, so a
  // single job goes straight to completed here.
  return { stage: 'completed' };
}

async function generateFeedback(
  job: AssessmentJob,
  ctx: StageContext,
  detail: JudgingInput,
  browserEvidence: string,
  bugs: { description: string; severity: string; evidence: string }[],
): Promise<void> {
  try {
    const response = await ctx.ai.run({
      promptVersion: feedbackPrompt.version,
      system: feedbackPrompt.system,
      user: feedbackPrompt.user({
        productName: detail.submission.productName ?? 'the product',
        ideaTitle: detail.idea?.title ?? 'unknown',
        declaredWorkflow: detail.submission.mustHaveWorkflow ?? '',
        observedBehaviour: browserEvidence,
        bugsObserved: bugs.map((b) => `${b.description} (${b.evidence})`).join('\n'),
        teamNextPlan: detail.submission.nextSevenDayPlan ?? '',
      }),
      schema: feedbackOutputSchema,
      correlationId: anonymiseSubmissionId(job.submissionId, detail.cohort.id),
    });

    // Enforced, not trusted: a report that mentions rank or score is not stored.
    const safety = validateFeedbackSafety(response.data);
    if (!safety.ok) {
      ctx.log.warn('Feedback report withheld — it referenced information participants must not see', {
        problems: safety.problems,
      });
      return;
    }

    await ctx.store.assessment.saveFeedbackReport({
      submissionId: job.submissionId,
      productSummary: response.data.productSummary,
      strengths: response.data.strengths,
      improvements: response.data.improvements,
      bugs: response.data.bugs,
      nextSevenDayPlan: response.data.nextSevenDayPlan,
      isExposedToParticipant: false,
      generatedAt: new Date(),
      modelVersion: response.modelVersion,
      promptVersion: response.promptVersion,
    });
  } catch (error) {
    // Feedback is valuable but not load-bearing — never fail a job over it.
    ctx.log.warn('Feedback generation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// --------------------------------------------------------------------------
// Consistency review
// --------------------------------------------------------------------------

async function consistencyStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  const scores = await ctx.store.assessment.listScores(job.id);
  const evidence = await ctx.store.assessment.listEvidence(job.id);
  const detail = await ctx.store.assessment.getJudgingInput(job.submissionId);
  if (!detail || scores.length === 0) return { stage: 'completed' };

  const response = await ctx.ai.run({
    promptVersion: consistencyPrompt.version,
    system: consistencyPrompt.system,
    user: consistencyPrompt.user({
      submissionId: anonymiseSubmissionId(job.submissionId, detail.cohort.id),
      firstPassScores: scores
        .map(
          (s) =>
            `${s.categoryKey}: ${s.rawScore}/${s.maxPoints} (confidence ${s.confidence})\n  supporting: ${s.supportingEvidence.join(' | ')}\n  contradictory: ${s.contradictoryEvidence.join(' | ')}\n  missing: ${s.missingEvidence.join(' | ')}`,
        )
        .join('\n'),
      evidence: evidence.map((e) => `[${e.stance}] ${e.categoryKey}: ${e.summary}`).join('\n'),
      trigger: 'selected for a second pass',
    }),
    schema: consistencyOutputSchema,
    correlationId: job.submissionId,
  });

  const before = totalScore(scores.map((s) => ({ categoryKey: s.categoryKey, weightedScore: s.weightedScore })));

  for (const adjustment of response.data.categoryAdjustments) {
    await ctx.store.assessment.overrideScore({
      jobId: job.id,
      categoryKey: adjustment.categoryKey,
      rawScore: roundToQuarter(adjustment.suggestedScore),
      reason: `Consistency pass: ${adjustment.reason}`,
      actor: 'system:consistency',
    });
  }

  const after = await ctx.store.assessment.listScores(job.id);
  const afterTotal = totalScore(after.map((s) => ({ categoryKey: s.categoryKey, weightedScore: s.weightedScore })));

  await ctx.store.assessment.saveConsistencyReview({
    jobId: job.id,
    triggerReason: ['top20'],
    passNumber: 2,
    scoreDelta: Math.round((afterTotal - before) * 100) / 100,
    adjusted: response.data.categoryAdjustments.length > 0,
    detail: { notes: response.data.notes, agrees: response.data.agreesWithFirstPass },
    reviewedAt: new Date(),
  });

  return { stage: 'completed' };
}

// --------------------------------------------------------------------------

function buildWrittenSubmission(
  detail: JudgingInput,
): string {
  const s = detail.submission;
  return [
    `Product: ${s.productName}`,
    `Primary user: ${s.primaryUser}`,
    `Problem: ${s.exactProblem}`,
    `Promise: ${s.oneSentencePromise}`,
    `Description: ${s.briefDescription}`,
    `Why AI: ${s.whyAiNecessary}`,
    `Differentiation: ${s.differentiation}`,
    `Must-have workflow: ${s.mustHaveWorkflow}`,
    `Should-haves: ${s.shouldHaveFeatures.join('; ')}`,
    `Excluded: ${s.excludedFeatures}`,
    `Known limitations: ${s.knownLimitations}`,
    `Bugs fixed: ${s.bugsFixed.map((b) => `${b.description} — ${b.howFixed}`).join(' | ')}`,
    `Trade-off: ${s.majorTradeoff}`,
    `Day 12 to 13: ${s.day12ToDay13Changes}`,
    `Learning: ${s.mostImportantLearning}`,
    `Next plan: ${s.nextSevenDayPlan}`,
    `Stack: ${s.builderStack}`,
  ].join('\n');
}
