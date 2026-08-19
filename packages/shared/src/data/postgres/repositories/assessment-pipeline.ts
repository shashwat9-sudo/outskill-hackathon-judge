/**
 * What the pipeline observed: preflight, artifacts, test plans, browser runs.
 *
 * Everything written here is evidence. The rule running through all of it is
 * that the record must be able to say **"we do not know"** — a schema that can
 * only store findings turns every gap into an implied zero, and a team that
 * loses on a deck the system could not open deserves better than a silent
 * assumption.
 *
 * Preflight keeps one row per attempt rather than per check, which is what
 * makes "their host was slow at 23:50" arguable afterwards instead of being
 * flattened into a single verdict nobody can re-examine.
 */

import type {
  ArtifactAnalysis,
  BrowserTestRun,
  BrowserTestStep,
  PreflightCheck,
  TestPlan,
  TestPlanStep,
} from '../../types';
import type { AssessmentStore } from '../../store';
import { RowNotFoundError, type SqlDatabase } from '../client';
import { json, mapRow, parseJson, toDate, toNumber } from '../rows';
import { TEST_ACTIONS } from '../../../testing/dsl';

export type PipelineMethods = Pick<
  AssessmentStore,
  | 'recordPreflight'
  | 'listPreflight'
  | 'saveArtifactAnalysis'
  | 'saveTestPlan'
  | 'getTestPlan'
  | 'saveBrowserRun'
  | 'listBrowserRuns'
>;

export function buildPipelineMethods(db: SqlDatabase): PipelineMethods {
  return {
    /**
     * Record a round of preflight checks.
     *
     * Appended, never replaced. The second attempt does not overwrite the
     * first — the sequence *is* the evidence that a site which failed at 23:50
     * answered at 23:52, and a table holding only the latest result could not
     * tell that from a site that was never up.
     */
    async recordPreflight(jobId, checks) {
      if (checks.length === 0) return;

      await db.transaction(async (tx) => {
        for (const check of checks) {
          await tx.query(
            `insert into preflight_checks
               (job_id, check_key, status, attempt_number, failure_class, detail, checked_at)
             values ($1, $2, $3::preflight_status, $4, $5::failure_class, $6::jsonb, $7)`,
            [
              jobId,
              check.checkKey,
              check.status,
              check.attemptNumber,
              check.failureClass,
              json(check.detail ?? {}),
              check.checkedAt ?? new Date(),
            ],
          );
        }
      });
    },

    async listPreflight(jobId) {
      const { rows } = await db.query(
        'select * from preflight_checks where job_id = $1 order by checked_at, attempt_number',
        [jobId],
      );
      return rows.map(mapPreflight);
    },

    /**
     * Store what was read out of the deck, the write-up and the video.
     *
     * `on conflict` because a job re-run replaces its analysis rather than
     * accumulating several — unlike preflight, there is no argument to preserve
     * here, only the current reading of fixed artifacts.
     *
     * `videoAnalysisLimited` is a column rather than a note. The system cannot
     * watch a video, and it has to be able to say so plainly instead of scoring
     * as though it had (ADR-015).
     */
    async saveArtifactAnalysis(analysis) {
      const { rows } = await db.query(
        `insert into artifact_analyses
           (job_id, deck_page_count, deck_text_extracted, deck_analysis,
            video_analysis_limited, video_limitation_reason, transcript_available,
            written_analysis, injection_flags, model_version, prompt_version)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
         on conflict (job_id) do update set
            deck_page_count = excluded.deck_page_count,
            deck_text_extracted = excluded.deck_text_extracted,
            deck_analysis = excluded.deck_analysis,
            video_analysis_limited = excluded.video_analysis_limited,
            video_limitation_reason = excluded.video_limitation_reason,
            transcript_available = excluded.transcript_available,
            written_analysis = excluded.written_analysis,
            injection_flags = excluded.injection_flags,
            model_version = excluded.model_version,
            prompt_version = excluded.prompt_version
         returning *`,
        [
          analysis.jobId,
          analysis.deckPageCount,
          analysis.deckTextExtracted,
          json(analysis.deckAnalysis ?? {}),
          analysis.videoAnalysisLimited,
          analysis.videoLimitationReason,
          analysis.transcriptAvailable,
          json(analysis.writtenAnalysis ?? {}),
          json(analysis.injectionFlags ?? []),
          analysis.modelVersion,
          analysis.promptVersion,
        ],
      );
      return mapArtifactAnalysis(rows[0]!);
    },

    /**
     * Store a test plan and its steps.
     *
     * Steps are validated against the permitted action list before insertion,
     * and the database repeats the check in a column constraint. That
     * duplication is deliberate: the plan originates from a model reading
     * participant-authored text, so "the application validates it" is one
     * bypass away from arbitrary instructions reaching the browser. An action
     * outside the union cannot be stored even if this function were wrong
     * (ADR-007).
     *
     * Rejected steps are recorded rather than dropped. A plan that quietly lost
     * half its steps looks like a product that failed half its workflow.
     */
    async saveTestPlan(plan, steps) {
      const permitted = new Set<string>(TEST_ACTIONS);
      const accepted: typeof steps = [];
      const rejected = [...(plan.rejectedSteps ?? [])];

      for (const step of steps) {
        const action = (step.step as { action?: unknown })?.action;
        if (typeof action === 'string' && permitted.has(action)) {
          accepted.push(step);
        } else {
          rejected.push({
            index: step.stepIndex,
            reason: `Action "${String(action)}" is not in the permitted set.`,
            raw: JSON.stringify(step.step).slice(0, 500),
          });
        }
      }

      // A plan whose steps were all rejected is not "valid with zero steps".
      const validationStatus =
        rejected.length === 0 ? plan.validationStatus : accepted.length === 0 ? 'rejected' : 'partial';

      return db.transaction(async (tx) => {
        const { rows } = await tx.query(
          `insert into test_plans
             (job_id, generated_from, step_count, estimated_duration_ms,
              model_version, prompt_version, validation_status, rejected_steps, summary)
           values ($1, $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb, $9)
           on conflict (job_id) do update set
              generated_from = excluded.generated_from,
              step_count = excluded.step_count,
              estimated_duration_ms = excluded.estimated_duration_ms,
              model_version = excluded.model_version,
              prompt_version = excluded.prompt_version,
              validation_status = excluded.validation_status,
              rejected_steps = excluded.rejected_steps,
              summary = excluded.summary
           returning *`,
          [
            plan.jobId,
            json(plan.generatedFrom ?? {}),
            accepted.length,
            plan.estimatedDurationMs,
            plan.modelVersion,
            plan.promptVersion,
            validationStatus,
            json(rejected),
            plan.summary ?? null,
          ],
        );
        const saved = mapTestPlan(rows[0]!);

        // Replace rather than append: a regenerated plan for the same job is a
        // new plan, and leaving the old steps would interleave two of them.
        await tx.query('delete from test_plan_steps where test_plan_id = $1', [saved.id]);

        for (const step of accepted) {
          await tx.query(
            `insert into test_plan_steps
               (test_plan_id, step_index, action, step, is_cleanup, rationale)
             values ($1, $2, $3, $4::jsonb, $5, $6)`,
            [
              saved.id,
              step.stepIndex,
              (step.step as { action: string }).action,
              json(step.step),
              step.isCleanup,
              step.rationale ?? null,
            ],
          );
        }

        return saved;
      });
    },

    async getTestPlan(jobId) {
      const { rows } = await db.query('select * from test_plans where job_id = $1', [jobId]);
      if (!rows[0]) return null;
      const plan = mapTestPlan(rows[0]);

      const stepRows = await db.query(
        'select * from test_plan_steps where test_plan_id = $1 order by step_index',
        [plan.id],
      );
      return { ...plan, steps: stepRows.rows.map(mapTestPlanStep) };
    },

    /**
     * Store one browser run and its steps.
     *
     * Runs accumulate: desktop and mobile are separate runs of the same job,
     * and a retry after a crash is a third. Each is a distinct observation.
     *
     * A step that was never reached is stored as `skipped`, never as `failed`.
     * The distinction decides whether a team is marked down for a broken
     * feature or for a feature the run ran out of time to open.
     */
    /**
     * Record one browser run against the attempt that produced it.
     *
     * Upserted rather than appended. Two executions can legitimately happen for
     * the same attempt — a worker restarting mid-stage resumes its own live
     * lease and runs the browser again — and the second describes the product
     * better than the first, so it replaces it. A genuinely new attempt carries
     * a different number and lands beside the old one instead.
     *
     * The attempt is read from the job rather than passed in: a caller that
     * could choose its own could write into a previous attempt's slot.
     */
    async saveBrowserRun(run, steps) {
      return db.transaction(async (tx) => {
        const { rows: jobRows } = await tx.query<{ attempt_count: number }>(
          'select attempt_count from assessment_jobs where id = $1',
          [run.jobId],
        );
        const attempt = jobRows[0]?.attempt_count ?? 1;

        const { rows } = await tx.query(
          `insert into browser_test_runs
             (job_id, attempt, viewport, started_at, finished_at, duration_ms, status,
              browser_version, trace_path, console_error_count, network_failure_count,
              a11y_violation_count, a11y_summary, cleanup_status, timed_out)
           values ($1, $15, $2, $3, $4, $5, $6::run_status, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
           on conflict (job_id, attempt, viewport) do update set
             started_at = excluded.started_at,
             finished_at = excluded.finished_at,
             duration_ms = excluded.duration_ms,
             status = excluded.status,
             browser_version = excluded.browser_version,
             trace_path = excluded.trace_path,
             console_error_count = excluded.console_error_count,
             network_failure_count = excluded.network_failure_count,
             a11y_violation_count = excluded.a11y_violation_count,
             a11y_summary = excluded.a11y_summary,
             cleanup_status = excluded.cleanup_status,
             timed_out = excluded.timed_out
           returning *`,
          [
            run.jobId,
            run.viewport,
            run.startedAt,
            run.finishedAt,
            run.durationMs,
            run.status,
            run.browserVersion,
            run.tracePath,
            run.consoleErrorCount,
            run.networkFailureCount,
            run.a11yViolationCount,
            json(run.a11ySummary ?? {}),
            run.cleanupStatus,
            run.timedOut,
            attempt,
          ],
        );
        const saved = mapBrowserRun(rows[0]!);

        // The run row survived the upsert, so its steps are rewritten rather
        // than added to. Without this a restart would leave both executions'
        // steps hanging off one run.
        await tx.query('delete from browser_test_steps where run_id = $1', [saved.id]);

        for (const step of steps) {
          await tx.query(
            `insert into browser_test_steps
               (run_id, step_index, action, status, duration_ms,
                screenshot_path, assertion_detail, error_message)
             values ($1, $2, $3, $4::step_status, $5, $6, $7::jsonb, $8)`,
            [
              saved.id,
              step.stepIndex,
              step.action,
              step.status,
              step.durationMs,
              step.screenshotPath,
              json(step.assertionDetail ?? {}),
              step.errorMessage,
            ],
          );
        }

        return saved;
      });
    },

    /**
     * The current attempt's runs, which is what judging is entitled to see.
     *
     * Scoring and the evidence lookup both read this. Returning every attempt
     * would let a re-judged submission be marked partly on a run that no longer
     * describes the product. The admin submission view queries these tables
     * directly and still shows the full history.
     */
    async listBrowserRuns(jobId) {
      const { rows } = await db.query(
        `select r.* from browser_test_runs r
           join assessment_jobs j on j.id = r.job_id
          where r.job_id = $1 and r.attempt = j.attempt_count
          order by r.started_at`,
        [jobId],
      );
      if (rows.length === 0) return [];

      const runs = rows.map(mapBrowserRun);
      const stepRows = await db.query(
        `select * from browser_test_steps
          where run_id = any($1::uuid[]) order by run_id, step_index`,
        [runs.map((r) => r.id)],
      );

      const byRun = new Map<string, BrowserTestStep[]>();
      for (const raw of stepRows.rows) {
        const step = mapBrowserStep(raw);
        const list = byRun.get(step.runId) ?? [];
        list.push(step);
        byRun.set(step.runId, list);
      }

      return runs.map((run) => ({ ...run, steps: byRun.get(run.id) ?? [] }));
    },
  };
}

// --------------------------------------------------------------------------
// Row mapping
// --------------------------------------------------------------------------

function mapPreflight(row: Record<string, unknown>): PreflightCheck {
  return {
    ...mapRow<PreflightCheck>(row),
    attemptNumber: toNumber(row.attempt_number),
    detail: parseJson(row.detail, {}),
    checkedAt: toDate(row.checked_at) ?? new Date(),
  };
}

function mapArtifactAnalysis(row: Record<string, unknown>): ArtifactAnalysis {
  return {
    ...mapRow<ArtifactAnalysis>(row),
    deckPageCount: row.deck_page_count === null ? null : toNumber(row.deck_page_count),
    deckAnalysis: parseJson(row.deck_analysis, {}),
    writtenAnalysis: parseJson(row.written_analysis, {}),
    injectionFlags: parseJson(row.injection_flags, []),
    createdAt: toDate(row.created_at) ?? new Date(),
  };
}

function mapTestPlan(row: Record<string, unknown>): TestPlan {
  return {
    ...mapRow<TestPlan>(row),
    generatedFrom: parseJson(row.generated_from, {}),
    stepCount: toNumber(row.step_count),
    estimatedDurationMs: toNumber(row.estimated_duration_ms),
    rejectedSteps: parseJson(row.rejected_steps, []),
    createdAt: toDate(row.created_at) ?? new Date(),
  };
}

function mapTestPlanStep(row: Record<string, unknown>): TestPlanStep {
  return {
    ...mapRow<TestPlanStep>(row),
    stepIndex: toNumber(row.step_index),
    step: parseJson(row.step, {} as TestPlanStep['step']),
  };
}

function mapBrowserRun(row: Record<string, unknown>): BrowserTestRun {
  return {
    ...mapRow<BrowserTestRun>(row),
    startedAt: toDate(row.started_at) ?? new Date(),
    finishedAt: toDate(row.finished_at),
    durationMs: row.duration_ms === null ? null : toNumber(row.duration_ms),
    consoleErrorCount: toNumber(row.console_error_count),
    networkFailureCount: toNumber(row.network_failure_count),
    a11yViolationCount: toNumber(row.a11y_violation_count),
    a11ySummary: parseJson(row.a11y_summary, {}),
  };
}

function mapBrowserStep(row: Record<string, unknown>): BrowserTestStep {
  return {
    ...mapRow<BrowserTestStep>(row),
    stepIndex: toNumber(row.step_index),
    durationMs: toNumber(row.duration_ms),
    assertionDetail: parseJson(row.assertion_detail, {}),
  };
}

export { RowNotFoundError };
