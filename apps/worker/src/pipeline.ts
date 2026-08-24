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
  redactDeep,
  scoringOutputSchema,
  scoringPrompt,
  shouldRouteToManualReview,
  testPlanOutputSchema,
  testPlanPrompt,
  validateScoreCeilings,
  type AiClient,
} from '@ohj/ai';
import { runPreflight } from './preflight';
import { fetchLinkedDeck } from './evidence-fetch';
import { generateFeedbackForSubmission } from './feedback';
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


/**
 * The most browser steps one submission is worth executing.
 *
 * Chosen for a two-day beginner build judged from a normal user's point of
 * view: enough to reach the main user action and look around, not enough for a
 * long tail of waits on elements that were never there.
 */
const MAX_BROWSER_STEPS = 8;

/**
 * Slack between a run's own budget and the point the stage stops waiting.
 *
 * Long enough for an orderly shutdown — closing the browser, finishing a trace
 * — to complete, so a healthy-but-slow run is not cut off mid-teardown.
 */
const STAGE_DEADLINE_GRACE_MS = 45_000;

/** Stop waiting for a run, whatever it is doing. */
function withStageDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The ${label} browser run did not finish within ${ms}ms.`)),
        ms,
      );
    }),
  ]);
}

/**
 * What a run that never came back is recorded as.
 *
 * Empty rather than invented. A timeout means we did not observe the product,
 * which is a reason for a human to look — not a reason to write down steps that
 * never ran or evidence that does not exist.
 */
function timedOutRun(viewport: 'desktop' | 'mobile', reason: string): BrowserRunResult {
  const now = new Date();
  return {
    viewport,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    status: 'error',
    browserVersion: 'unknown',
    tracePath: null,
    timedOut: true,
    cleanupStatus: 'not_attempted',
    steps: [],
    observations: { consoleErrors: [], networkFailures: [], a11yViolations: [], createdValues: [] },
    error: reason,
  };
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

  /*
   * Supporting evidence can arrive two ways and both are current.
   *
   * A submission from the Hackathon product carries a Loom link and a deck
   * link on the submission itself; one made through the older upload path has
   * `submission_artifacts` rows instead. Reading only the artifacts — which is
   * what this did — meant every sheet-ingested team was reported as having
   * supplied no deck and no demo while both links sat in their submission row.
   */
  const demoVideoUrl = detail.submission.loomUrl ?? video?.externalUrl ?? null;
  const deckUrl = detail.submission.deckUrl ?? null;

  const outcome = await runPreflight(
    {
    submissionId: job.submissionId,
    productUrl: detail.submission.productUrl,
    demoVideoUrl,
    deckUrl,
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

  /*
   * A fresh attempt starts with a clean slate of system observations.
   *
   * Preflight is the first stage of any attempt, so this is where the previous
   * one's findings stop applying. A flag saying the browser never reached the
   * product describes an attempt that is over; leaving it open after a
   * successful re-judge sends a reviewer to a problem that has already gone.
   *
   * Only this system's own flags are retired, and only by being marked
   * resolved — the history stays. An administrator's flag is a decision, not an
   * observation, and re-running a job must never quietly undo one.
   */
  const superseded = await ctx.store.assessment.supersedeSystemManualReview(
    job.submissionId,
    `Superseded by judging attempt ${job.attemptCount + 1}.`,
  );
  if (superseded > 0) {
    ctx.log.info('Retired flags from a previous attempt', {
      submissionId: job.submissionId,
      count: superseded,
      attempt: job.attemptCount + 1,
    });
  }

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

    /*
     * Out of retries, and the product still is not answering.
     *
     * This used to end as `failed`, which removed the team from consideration
     * for something that may have lasted minutes: a deployment asleep, a free
     * tier throttling, a DNS record propagating. Worse, a failed job carries no
     * flag, so the submission simply vanished from the review queue and nobody
     * would have known to look.
     *
     * It goes to a human instead, carrying the diagnostic. No browser evidence
     * is invented and nothing is scored on behaviour we never observed — the
     * assessment records that we could not see the product, which is the honest
     * outcome and leaves the decision where it belongs.
     *
     * A malformed URL or a blocked address is not this: those stay as they
     * were, because they are the submission being wrong or a rule being
     * enforced, not a site that happened to be down.
     */
    if (outcome.unreachable) {
      const failing = outcome.checks.find(
        (c) => c.status === 'fail' && (c.checkKey === 'http_reachable' || c.checkKey === 'dns_resolves'),
      );
      const reason = failing?.detail?.message ?? 'The product URL did not respond.';

      await ctx.store.assessment.raiseManualReview({
        submissionId: job.submissionId,
        reasonCode: 'product_unreachable',
        detail:
          `The product could not be reached after ${job.attemptCount + 1} attempt(s): ` +
          `${String(reason)} It has not been judged on product behaviour.`,
        raisedBy: 'system',
        status: 'open',
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
      });

      ctx.log.warn('Product unreachable — routing to manual review', {
        submissionId: job.submissionId,
        attempts: job.attemptCount + 1,
      });
      return { stage: 'manual_review', error: 'The product could not be reached.' };
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
  const demoVideoUrl = detail.submission.loomUrl ?? video?.externalUrl ?? null;

  /*
   * An uploaded deck is bytes we already hold; a linked deck has to be
   * fetched. Storage wins where both exist, because it needs no network and
   * cannot have had its sharing settings changed since submission.
   *
   * When a linked deck cannot be read, the reason is carried forward rather
   * than discarded. "The file is not shared publicly" and "no deck was
   * submitted" are different findings about a team, and only one of them is
   * about the deck being absent.
   */
  let deckExtraction = deck?.storagePath
    ? await extractPdfText(deck.storagePath).catch(() => null)
    : null;
  let deckUnavailableReason: string | null = null;

  if (!deckExtraction && detail.submission.deckUrl) {
    const fetched = await fetchLinkedDeck(detail.submission.deckUrl);
    if (fetched.ok) {
      deckExtraction = await extractPdfText(fetched.bytes).catch(() => null);
      if (!deckExtraction) {
        deckUnavailableReason = 'The linked deck was downloaded but could not be parsed as a PDF.';
      }
    } else {
      deckUnavailableReason = fetched.reason;
    }
  } else if (!deckExtraction && !deck) {
    deckUnavailableReason = 'No pitch deck was supplied.';
  }

  /*
   * The durable record of why a deck was unreadable is the `deck_readable`
   * preflight check, which an admin can see against the submission. This is
   * the operator's copy — enough to tell "nobody shared the file" apart from
   * "our egress refused the host" without opening the database.
   */
  if (deckUnavailableReason) {
    ctx.log.info('No deck text available for analysis', {
      submissionId: job.submissionId,
      reason: deckUnavailableReason,
    });
  }

  // Video is not fetched or transcribed in Version 1. Being explicit beats
  // inventing content (ADR-015).
  const videoAnalysisLimited = !demoVideoUrl || video?.isAccessible === false;
  const videoLimitationReason = !demoVideoUrl
    ? 'No demo video link was supplied.'
    : video?.isAccessible === false
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

  /*
   * How many browser steps a submission is worth.
   *
   * The model produced a twenty-one step plan for a page with one heading on
   * it. Long plans are not more rigorous — they are mostly waits on elements
   * that were never there, and each one spends budget that the main user
   * action needed. This is a two-day hackathon build being checked by a normal
   * user, not a regression suite.
   *
   * Steps come back in priority order, so taking the first N keeps the main
   * user action and drops the tail. A cap is not a substitute for the deadline
   * below; it is what stops the deadline being the normal way a run ends.
   */
  const allSteps = plan.steps.map((s) => s.step);
  const steps = allSteps.slice(0, MAX_BROWSER_STEPS);
  if (allSteps.length > MAX_BROWSER_STEPS) {
    ctx.log.info('Test plan truncated', {
      generated: allSteps.length,
      executed: steps.length,
    });
  }
  /*
   * A budget we can actually count with.
   *
   * `Number.isFinite` rather than `??`: a cohort with no configuration yields
   * undefined, and undefined arithmetic gives NaN, which `setTimeout` treats as
   * 1ms — so a missing default did not slow runs down, it abandoned them
   * instantly and sent every submission to manual review.
   */
  const configuredBudget = detail.cohort.assessmentConfig?.browserBudgetMs;
  const budgetMs = Number.isFinite(configuredBudget) ? Number(configuredBudget) : 480_000;

  /*
   * The stage always ends.
   *
   * Everything inside the runner is bounded now, but "bounded" there means a
   * race — the promise rejects while whatever it was waiting on may still be
   * alive. This is the layer that does not care: if a run has not returned by
   * its deadline, the stage stops waiting and reports a timeout, and the worker
   * goes back to the queue.
   *
   * That distinction is the whole defect. With one worker, a stage that cannot
   * end is not a slow submission — it is a cohort that never gets judged, and
   * on the day it would have looked like nothing happening at all.
   */
  const boundedRun = async (
    label: string,
    run: Promise<BrowserRunResult>,
    budgetMs: number,
  ): Promise<BrowserRunResult> => {
    try {
      return await withStageDeadline(run, budgetMs + STAGE_DEADLINE_GRACE_MS, label);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The browser run did not finish.';
      ctx.log.warn('Browser run exceeded its deadline', { viewport: label, reason });
      // An honest empty run: no fabricated steps, no invented evidence.
      return timedOutRun(label as 'desktop' | 'mobile', reason);
    }
  };

  const desktop = await boundedRun('desktop', runBrowserPlan({
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
  }), Math.floor(budgetMs * 0.8));
  await persistRun(job.id, desktop, ctx);

  const mobile = await boundedRun('mobile', runBrowserPlan({
    productUrl: detail.submission.productUrl,
    steps: steps.slice(0, 6),
    credentials: credentials ? { username: credentials.username, password: credentials.password } : null,
    budgetMs: Math.floor(budgetMs * 0.2),
    allowPrivateOriginForTesting: ctx.allowPrivateProductUrlForControlledRun === true,
    viewport: 'mobile',
    screenshotDir,
    traceDir: null,
    headless: ctx.env.BROWSER_HEADLESS,
  }), Math.floor(budgetMs * 0.2));
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

  /*
   * Feedback is produced by the same function the admin retry and the backfill
   * call, so there is one implementation rather than two that drift.
   *
   * Still non-blocking: a job whose feedback could not be produced is judged,
   * scored and ranked exactly as before. What changed is that the outcome is
   * now recorded on the job instead of vanishing into a log line — a missing
   * report is a state somebody can see and retry, not an absence nobody
   * notices until they open the page.
   */
  await generateFeedbackForSubmission(job.submissionId, {
    store: ctx.store,
    ai: ctx.ai,
    log: ctx.log,
  }).catch((error: unknown) => {
    ctx.log.error('[feedback-generation-failed]', {
      submissionId: job.submissionId,
      stage: 'unexpected',
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // The consistency pass is selected at the cohort level after ranking, so a
  // single job goes straight to completed here.
  return { stage: 'completed' };
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
    // The team's own account of what they finished. Context for two-day
    // execution; never a substitute for what the browser observed.
    `What the team got working: ${s.whatGotWorking}`,
    `Learning: ${s.mostImportantLearning}`,
    `Next plan: ${s.nextSevenDayPlan}`,
    `Stack: ${s.builderStack}`,
  ].join('\n');
}
