/**
 * Pipeline stages.
 *
 * One function per stage. Each takes a claimed job, does its work, persists its
 * output, and returns the stage to move to. Diverting to `manual_review` or
 * `failed` is a normal return value, not an exception — routing a submission to
 * a human is an outcome, not an error.
 */

import { mkdir } from 'node:fs/promises';
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
  type DataStore,
  type Env,
  type Logger,
  type RubricCategoryKey,
} from '@ohj/shared';
import {
  artifactAnalysisPrompt,
  artifactAnalysisSchema,
  assertNoCredentials,
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

export interface StageContext {
  store: DataStore;
  ai: AiClient;
  env: Env;
  workerId: string;
  evidenceRoot: string;
  log: Logger;
}

export interface StageOutcome {
  stage: AssessmentStage;
  error?: string;
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
  const detail = await ctx.store.submissions.getSubmissionDetail(job.submissionId);
  if (!detail) return { stage: 'failed', error: 'Submission not found.' };

  const deck = detail.artifacts.find((a) => a.kind === 'deck_pdf');
  const video = detail.artifacts.find((a) => a.kind === 'demo_video');
  const credentials = await ctx.store.submissions.getCredentials(job.submissionId);

  const outcome = await runPreflight({
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
  });

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
  const detail = await ctx.store.submissions.getSubmissionDetail(job.submissionId);
  if (!detail) return { stage: 'failed', error: 'Submission not found.' };

  const anonId = anonymiseSubmissionId(job.submissionId, detail.cohort.id);
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

  // Redaction happens before the payload is built, and the credential assertion
  // is a structural backstop (ADR-009).
  const names = [detail.team.leadName, ...detail.members.map((m) => m.fullName)];
  const redactedWritten = redactDeep(writtenSubmission, names);
  const redactedDeck = redactDeep(deckText, names);

  const credentials = await ctx.store.submissions.revealCredentials(job.submissionId).catch(() => null);
  assertNoCredentials({ redactedWritten, redactedDeck }, [
    credentials?.username ?? '',
    credentials?.password ?? '',
  ]);

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
  const detail = await ctx.store.submissions.getSubmissionDetail(job.submissionId);
  if (!detail?.submission.productUrl) return { stage: 'failed', error: 'No product URL.' };

  const anonId = anonymiseSubmissionId(job.submissionId, detail.cohort.id);
  const names = [detail.team.leadName, ...detail.members.map((m) => m.fullName)];

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
  const detail = await ctx.store.submissions.getSubmissionDetail(job.submissionId);
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
  });
  await persistRun(job.id, desktop, ctx);

  const mobile = await runBrowserPlan({
    productUrl: detail.submission.productUrl,
    steps: steps.slice(0, 6),
    credentials: credentials ? { username: credentials.username, password: credentials.password } : null,
    budgetMs: Math.floor(budgetMs * 0.2),
    viewport: 'mobile',
    screenshotDir,
    traceDir: null,
    headless: ctx.env.BROWSER_HEADLESS,
  });
  await persistRun(job.id, mobile, ctx);

  return { stage: 'evidence_review' };
}

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
      tracePath: run.tracePath,
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
      screenshotPath: step.screenshotPath,
      assertionDetail: { detail: step.detail },
      errorMessage: step.errorMessage,
    })),
  );
}

// --------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------

async function scoringStage(job: AssessmentJob, ctx: StageContext): Promise<StageOutcome> {
  const detail = await ctx.store.submissions.getSubmissionDetail(job.submissionId);
  if (!detail) return { stage: 'failed', error: 'Submission not found.' };

  const anonId = anonymiseSubmissionId(job.submissionId, detail.cohort.id);
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
  detail: NonNullable<Awaited<ReturnType<DataStore['submissions']['getSubmissionDetail']>>>,
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
  const detail = await ctx.store.submissions.getSubmissionDetail(job.submissionId);
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
  detail: NonNullable<Awaited<ReturnType<DataStore['submissions']['getSubmissionDetail']>>>,
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
