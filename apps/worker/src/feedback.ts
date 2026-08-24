/**
 * Participant feedback, generated from work that has already been done.
 *
 * This is deliberately not a judging stage. Everything it needs — scores,
 * browser runs, the submission itself — already exists on disk by the time it
 * runs, so producing a report is a pure read of that plus one model call. It
 * recalculates no score, regenerates no ranking, and launches no browser.
 *
 * That separation is the fix for how it failed. Feedback used to be a tail call
 * inside the scoring stage: a report that was refused or errored produced a
 * warning line and nothing else, the job was still marked `completed`, and the
 * missing artefact was invisible until somebody opened the page. 43 of 69
 * submissions on the C13 run were in that state.
 *
 * So it is now separately addressable, separately recorded, and separately
 * retryable — without touching anything upstream of it.
 */

import {
  anonymiseSubmissionId,
  type AssessmentJob,
  type DataStore,
  type FeedbackReport,
  type Logger,
} from '@ohj/shared';
import { feedbackPrompt, feedbackOutputSchema, validateFeedbackSafety, type AiClient } from '@ohj/ai';
import { summariseRun } from './browser-runner';

/** Bounded. A report is worth retrying for; it is not worth retrying forever. */
const MAX_ATTEMPTS = 3;

export type FeedbackResult =
  | { ok: true; report: FeedbackReport; skipped: boolean; attempts: number }
  | { ok: false; reason: string; attempts: number };

export interface FeedbackDeps {
  store: DataStore;
  ai: AiClient;
  log: Logger;
}

/**
 * Produce the feedback report for one submission, or say why not.
 *
 * Idempotent by default: an existing report is returned untouched. `force`
 * exists for the case where a report is known to be wrong, and is never used by
 * the backfill — a report a participant may already have seen should not change
 * under them because a maintenance job ran.
 */
export async function generateFeedbackForSubmission(
  submissionId: string,
  deps: FeedbackDeps,
  options: { force?: boolean } = {},
): Promise<FeedbackResult> {
  const { store, ai, log } = deps;

  const existing = await store.assessment.getFeedbackReport(submissionId);
  if (existing && !options.force) {
    return { ok: true, report: existing, skipped: true, attempts: 0 };
  }

  const job = await store.assessment.getJobBySubmission(submissionId);
  if (!job) return { ok: false, reason: 'No assessment job exists for this submission.', attempts: 0 };

  const detail = await store.assessment.getJudgingInput(submissionId);
  if (!detail) return { ok: false, reason: 'Submission not found.', attempts: 0 };

  /*
   * Scores are a precondition, not an input to be recomputed.
   *
   * Without them the run never reached the point where feedback is meaningful,
   * and generating a report anyway would describe a product nobody assessed.
   */
  const scores = await store.assessment.listScores(job.id);
  if (scores.length === 0) {
    await setStatus(store, job, 'failed', 'No scores exist for this submission yet.', 0);
    return { ok: false, reason: 'No scores exist for this submission yet.', attempts: 0 };
  }

  await setStatus(store, job, 'generating', null, job.feedbackAttempts);

  const runs = await store.assessment.listBrowserRuns(job.id);
  const observed = describeRuns(runs);
  const bugs = await bugsFrom(store, job.id);

  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await ai.run({
        promptVersion: feedbackPrompt.version,
        system: feedbackPrompt.system,
        user: feedbackPrompt.user({
          productName: detail.submission.productName ?? 'the product',
          ideaTitle: detail.idea?.title ?? 'unknown',
          declaredWorkflow: detail.submission.mustHaveWorkflow ?? '',
          observedBehaviour: observed,
          bugsObserved: bugs,
          teamNextPlan: detail.submission.nextSevenDayPlan ?? '',
        }),
        schema: feedbackOutputSchema,
        correlationId: anonymiseSubmissionId(submissionId, detail.cohort.id),
      });

      /*
       * Enforced, not trusted. A report naming a rank or a mark is refused —
       * that rule is unchanged and is not weakened here.
       *
       * What changed is what a refusal costs. It used to end the attempt
       * silently; now it is a retry with the offending phrase quoted back, so
       * the model can say the same thing differently. Only when every attempt
       * has been refused does the report get withheld, and then it is recorded
       * as a failure rather than as an absence.
       */
      const safety = validateFeedbackSafety(response.data);
      if (!safety.ok) {
        lastError = `Withheld: ${safety.problems.join(' ')}`;
        log.warn('[feedback-generation-refused]', {
          submissionId,
          groupNumber: detail.team.groupNumber,
          productName: detail.submission.productName,
          attempt,
          problems: safety.problems,
        });
        continue;
      }

      const report = await store.assessment.saveFeedbackReport({
        submissionId,
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

      await setStatus(store, job, 'generated', null, attempt);
      log.info('Feedback report generated', {
        submissionId,
        groupNumber: detail.team.groupNumber,
        attempt,
      });
      return { ok: true, report, skipped: false, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      /*
       * Which half failed matters to whoever reads this. A model that returned
       * nothing usable and a database that refused the write need different
       * people to look at them, and "feedback generation failed" describes both.
       */
      const persistence = /saveFeedbackReport|insert|duplicate key|connection/i.test(lastError);
      log.error('[feedback-generation-failed]', {
        submissionId,
        groupNumber: detail.team.groupNumber,
        productName: detail.submission.productName,
        attempt,
        stage: persistence ? 'persistence' : 'ai-generation',
        error: lastError,
      });
    }
  }

  await setStatus(store, job, 'failed', lastError, MAX_ATTEMPTS);
  log.error('[feedback-generation-exhausted]', {
    submissionId,
    groupNumber: detail.team.groupNumber,
    attempts: MAX_ATTEMPTS,
    error: lastError,
  });
  return { ok: false, reason: lastError, attempts: MAX_ATTEMPTS };
}

/**
 * Record where feedback got to.
 *
 * Never touches `stage`. Judging and feedback are separate concerns, and a job
 * that is `completed` with `feedback_status = failed` is a state this is
 * designed to express rather than one to be avoided.
 */
async function setStatus(
  store: DataStore,
  job: AssessmentJob,
  status: 'pending' | 'generating' | 'generated' | 'failed',
  error: string | null,
  attempts: number,
): Promise<void> {
  await store.assessment.setFeedbackStatus(job.id, { status, error, attempts });
}

/** The same summary the scoring stage reads, from the same stored runs. */
function describeRuns(runs: Awaited<ReturnType<DataStore['assessment']['listBrowserRuns']>>): string {
  return runs
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
          detail: String((s.assertionDetail as { detail?: string } | null)?.detail ?? ''),
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
}

/**
 * Bugs as the scoring pass recorded them.
 *
 * Read back from the stored summary rather than recomputed, so a regenerated
 * report describes the same run the score was given for.
 */
async function bugsFrom(store: DataStore, jobId: string): Promise<string> {
  const summary = await store.assessment.getSummary(jobId);
  return (summary?.bugsFound ?? [])
    .map((b) => `${b.description} (${b.evidence})`)
    .join('\n');
}
