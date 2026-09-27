/**
 * Ranking, the private shortlist, and the final four.
 *
 * The output of this file is never shown to a participant. There is no
 * participant route that reads these tables and no method on `ParticipantStore`
 * that could reach them (ADR-010) — a team learning it was ranked 11th would
 * turn an internal working order into a public verdict Outskill never issued.
 *
 * Two properties matter more than anything else here:
 *
 *   **A snapshot is immutable.** Ranking is generated, stored, and then read.
 *   It is not recomputed on view. Two people looking at "the Top 10" on the
 *   same evening must see the same ten, and a list that silently reorders
 *   because a score changed between page loads is not a decision record.
 *
 *   **The final four are chosen by people.** `setFinalSelection` is reachable
 *   only from an admin action; no worker, stage, or model response has a call
 *   path to it (ADR-018). The system ranks. It does not declare winners.
 */

import type {
  FeedbackStatus,
  FinalSelection,
  RankingEntry,
  RankingSnapshot,
} from '../../types';
import type { RankedListItem, RankingStore } from '../../store';
import { RowNotFoundError, type SqlClient, type SqlDatabase } from '../client';
import { json, mapRow, parseJson, toDate, toNumber } from '../rows';
import { isEligibleForRanking } from '../../../domain/disqualification';
import {
  DEFAULT_FINAL_SELECTION_TARGET,
  rankSubmissions,
  validateFinalSelection,
  type RankableSubmission,
} from '../../../domain/ranking';
import { RUBRIC_VERSION, RUBRIC_CATEGORIES, type RubricCategoryKey } from '../../../rubric/index';
import type { RankedResultRow } from '../../../domain/results-export';
import type {
  AuditBrowserRun,
  AuditManualReviewFlag,
  AuditPreflightCheck,
  SubmissionAuditRow,
} from '../../../domain/submission-audit';
import { mapFeedback } from './assessment-judgment';

export function buildRankingStore(db: SqlDatabase): RankingStore {
  return {
    /**
     * Generate a ranking snapshot.
     *
     * Eligibility is decided explicitly and per submission rather than inside
     * the sort, so "why is this team not in the list" has an answer that names
     * a rule instead of requiring someone to re-derive the ordering.
     *
     * A submission missing any category score is excluded rather than ranked on
     * a partial total. Summing seven of eight categories produces a number that
     * looks like a score and is really a penalty for the system's own
     * incomplete work.
     */
    async generateSnapshot(cohortId, notes) {
      return db.transaction(async (tx) => {
        const cohort = await tx.query<{ shortlist_target: unknown }>(
          'select shortlist_target from cohorts where id = $1',
          [cohortId],
        );
        if (!cohort.rows[0]) throw new RowNotFoundError('cohort', cohortId);
        const shortlistTarget = toNumber(cohort.rows[0].shortlist_target, 10);

        const candidates = await collectRankable(tx, cohortId);
        const ranked = rankSubmissions(candidates, { shortlistTarget });

        // Exactly one current snapshot per cohort — the partial unique index
        // would reject a second, so the old one is stood down first.
        await tx.query(
          'update ranking_snapshots set is_current = false where cohort_id = $1 and is_current',
          [cohortId],
        );

        const { rows } = await tx.query(
          `insert into ranking_snapshots
             (cohort_id, rubric_version, eligible_count, shortlist_target, is_current, notes)
           values ($1, $2, $3, $4, true, $5)
           returning *`,
          [cohortId, RUBRIC_VERSION, ranked.length, shortlistTarget, notes ?? null],
        );
        const snapshot = mapSnapshot(rows[0]!);

        for (const entry of ranked) {
          await tx.query(
            `insert into ranking_entries
               (snapshot_id, submission_id, rank, total_score, tiebreak_vector,
                in_shortlist, mean_confidence)
             values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [
              snapshot.id,
              entry.submissionId,
              entry.rank,
              entry.totalScore,
              json(entry.tiebreakVector),
              entry.inShortlist,
              entry.meanConfidence,
            ],
          );
        }

        return snapshot;
      });
    },

    /**
     * Read the current snapshot.
     *
     * Returns the stored ordering, not a fresh computation. `lowConfidence` and
     * `hasOpenManualReview` travel with each row so the shortlist can be read
     * with its caveats attached — a rank whose evidence was thin should not
     * look identical to one that was thoroughly established.
     */
    async getCurrentSnapshot(cohortId) {
      const { rows } = await db.query(
        'select * from ranking_snapshots where cohort_id = $1 and is_current limit 1',
        [cohortId],
      );
      if (!rows[0]) return null;
      const snapshot = mapSnapshot(rows[0]);

      const entryRows = await db.query<Record<string, unknown>>(
        `select e.*,
                t.group_number,
                s.product_name,
                i.title as idea_title,
                coalesce(sum.low_confidence, false) as low_confidence,
                exists (
                  select 1 from manual_review_flags f
                   where f.submission_id = e.submission_id and f.status = 'open'
                ) as has_open_manual_review
           from ranking_entries e
           join submissions s on s.id = e.submission_id
           join teams t on t.id = s.team_id
           left join cohort_ideas i on i.id = s.idea_id
           left join assessment_jobs j on j.submission_id = e.submission_id
           left join assessment_summaries sum on sum.job_id = j.id
          where e.snapshot_id = $1
          order by e.rank`,
        [snapshot.id],
      );

      const entries: RankedListItem[] = entryRows.rows.map((row) => ({
        entry: mapEntry(row),
        submissionId: String(row.submission_id),
        groupNumber: toNumber(row.group_number),
        productName: (row.product_name as string | null) ?? null,
        ideaTitle: (row.idea_title as string | null) ?? null,
        lowConfidence: Boolean(row.low_confidence),
        hasOpenManualReview: Boolean(row.has_open_manual_review),
      }));

      return { ...snapshot, entries };
    },

    async listSnapshots(cohortId) {
      const { rows } = await db.query(
        'select * from ranking_snapshots where cohort_id = $1 order by generated_at desc',
        [cohortId],
      );
      return rows.map(mapSnapshot);
    },

    async listFinalSelections(cohortId) {
      const { rows } = await db.query<Record<string, unknown>>(
        `select f.*, t.group_number, s.product_name
           from final_selections f
           join submissions s on s.id = f.submission_id
           join teams t on t.id = s.team_id
          where f.cohort_id = $1
          order by f.position`,
        [cohortId],
      );
      return rows.map((row) => ({
        ...mapFinalSelection(row),
        groupNumber: toNumber(row.group_number),
        productName: (row.product_name as string | null) ?? null,
      }));
    },

    /**
     * Record the final four.
     *
     * Finalists must come from the current ranking snapshot. That is the
     * eligibility rule, not merely "belongs to this cohort": a submission that
     * was disqualified, or whose assessment never completed, is absent from the
     * snapshot and therefore cannot be seated — which is the whole reason the
     * snapshot is generated before anyone chooses.
     *
     * Replaced wholesale inside one transaction rather than patched. A partial
     * update could leave three finalists from one decision and one from an
     * earlier one, with nothing in the rows to show it had happened.
     *
     * `actor` is always a human. No worker, stage or model response has a call
     * path to this method (ADR-018).
     */
    async setFinalSelection(cohortId, selections, actor) {
      return db.transaction(async (tx) => {
        // How many winners this cohort records is the cohort's own fact
        // (0014), read inside the transaction so the count validated is the
        // count that holds when the rows are written.
        const { rows: cohortRows } = await tx.query<{ final_selection_target: unknown }>(
          'select final_selection_target from cohorts where id = $1',
          [cohortId],
        );
        if (!cohortRows[0]) throw new RowNotFoundError('cohort', cohortId);
        const target = toNumber(cohortRows[0].final_selection_target, DEFAULT_FINAL_SELECTION_TARGET);

        const { rows: snapshotRows } = await tx.query<{ id: string }>(
          'select id from ranking_snapshots where cohort_id = $1 and is_current limit 1',
          [cohortId],
        );
        const snapshotId = snapshotRows[0]?.id;
        if (!snapshotId) {
          throw new Error(
            'There is no current ranking for this cohort, so there is nothing to select from. Generate a ranking first.',
          );
        }

        const { rows: eligibleRows } = await tx.query<{ submission_id: string }>(
          'select submission_id from ranking_entries where snapshot_id = $1',
          [snapshotId],
        );
        const eligible = new Set(eligibleRows.map((r) => r.submission_id));

        const validation = validateFinalSelection(
          selections.map((s) => ({ submissionId: s.submissionId, position: s.position })),
          eligible,
          target,
        );
        if (!validation.valid) {
          throw new Error(`Final selection rejected: ${validation.problems.join(' ')}`);
        }

        await tx.query('delete from final_selections where cohort_id = $1', [cohortId]);

        const saved: FinalSelection[] = [];
        for (const selection of selections) {
          const { rows } = await tx.query(
            `insert into final_selections
               (cohort_id, submission_id, position, selected_by, selection_reason)
             values ($1, $2, $3, $4, $5)
             returning *`,
            [
              cohortId,
              selection.submissionId,
              selection.position,
              actor,
              selection.reason ?? '',
            ],
          );
          saved.push(mapFinalSelection(rows[0]!));
        }
        return saved;
      });
    },

    async clearFinalSelection(cohortId) {
      await db.query('delete from final_selections where cohort_id = $1', [cohortId]);
    },

    /**
     * The current snapshot, with everything the results export reads.
     *
     * Two statements: one row per ranked entry with its joins, then the
     * category scores for every job in one `= any($1)` fetch and a regroup in
     * memory — the same shape `collectRankable` uses, for the same reason.
     *
     * The stored rank, total and shortlist flag are returned as stored: an
     * export must describe the snapshot the decision was made against, not a
     * recomputation. Category scores come from `category_scores`, whose
     * `raw_score` already reflects a human override (ADR-012), so the export
     * shows the effective score the ranking page shows.
     *
     * Feedback is a `left join`: an entry without a report is still a row,
     * carrying the job's feedback status so the file says why it is missing.
     */
    async listRankedResults(cohortId) {
      const { rows } = await db.query<Record<string, unknown>>(
        `select e.submission_id, e.rank, e.total_score, e.in_shortlist, e.mean_confidence,
                c.id as cohort_id, c.name as cohort_name, c.code as cohort_code,
                s.product_name, s.product_url, s.loom_url, s.deck_url,
                s.status::text as submission_status,
                t.group_number,
                i.title as idea_title, i.slug as idea_slug,
                j.id as job_id, j.stage::text as stage,
                j.feedback_status, j.feedback_error, j.feedback_attempts,
                coalesce(sum.low_confidence, false) as low_confidence,
                f.id as feedback_id, f.submission_id as f_submission_id,
                f.product_summary, f.strengths, f.improvements, f.bugs,
                f.next_seven_day_plan, f.is_exposed_to_participant, f.generated_at,
                f.model_version, f.prompt_version,
                fs.position as final_position, fs.selection_reason,
                (
                  select string_agg(m.reason_code, '|' order by m.created_at)
                    from manual_review_flags m
                   where m.submission_id = e.submission_id and m.status = 'open'
                ) as open_flag_codes,
                (
                  select d.status::text from disqualifications d
                   where d.submission_id = e.submission_id
                   order by d.created_at desc limit 1
                ) as dq_status,
                (
                  select d.reason_code::text from disqualifications d
                   where d.submission_id = e.submission_id
                   order by d.created_at desc limit 1
                ) as dq_reason_code,
                (
                  select d.reason_detail from disqualifications d
                   where d.submission_id = e.submission_id
                   order by d.created_at desc limit 1
                ) as dq_reason_detail,
                exists (
                  select 1 from submission_artifacts a
                   where a.submission_id = e.submission_id and a.kind = 'deck_pdf'
                ) as has_uploaded_deck
           from ranking_snapshots snap
           join ranking_entries e on e.snapshot_id = snap.id
           join cohorts c on c.id = snap.cohort_id
           join submissions s on s.id = e.submission_id
           join teams t on t.id = s.team_id
           left join cohort_ideas i on i.id = s.idea_id
           left join assessment_jobs j on j.submission_id = e.submission_id
           left join assessment_summaries sum on sum.job_id = j.id
           left join feedback_reports f on f.submission_id = e.submission_id
           left join final_selections fs
                  on fs.cohort_id = snap.cohort_id and fs.submission_id = e.submission_id
          where snap.cohort_id = $1 and snap.is_current
          order by e.rank`,
        [cohortId],
      );
      if (rows.length === 0) return [];

      const jobIds = rows.map((r) => r.job_id).filter((id): id is string => typeof id === 'string');
      const scoreRows =
        jobIds.length === 0
          ? { rows: [] as Record<string, unknown>[] }
          : await db.query<Record<string, unknown>>(
              `select job_id, category_key, raw_score, max_points, confidence, is_overridden
                 from category_scores where job_id = any($1::uuid[])`,
              [jobIds],
            );
      const scoresByJob = new Map<string, RankedResultRow['categoryScores']>();
      for (const row of scoreRows.rows) {
        const jobId = String(row.job_id);
        const scores = scoresByJob.get(jobId) ?? {};
        scores[String(row.category_key) as RubricCategoryKey] = {
          rawScore: toNumber(row.raw_score),
          maxPoints: toNumber(row.max_points),
          confidence: toNumber(row.confidence),
          isOverridden: Boolean(row.is_overridden),
        };
        scoresByJob.set(jobId, scores);
      }

      return rows.map((row): RankedResultRow => {
        const jobId = typeof row.job_id === 'string' ? row.job_id : null;
        const dqStatus = (row.dq_status as 'proposed' | 'confirmed' | 'reversed' | null) ?? null;
        return {
          cohortId: String(row.cohort_id),
          cohortName: String(row.cohort_name),
          cohortCode: String(row.cohort_code),
          submissionId: String(row.submission_id),
          groupNumber: toNumber(row.group_number),
          productName: (row.product_name as string | null) ?? null,
          ideaTitle: (row.idea_title as string | null) ?? null,
          ideaSlug: (row.idea_slug as string | null) ?? null,
          rank: toNumber(row.rank),
          totalScore: toNumber(row.total_score),
          inShortlist: Boolean(row.in_shortlist),
          meanConfidence: toNumber(row.mean_confidence),
          lowConfidence: Boolean(row.low_confidence),
          finalPosition: row.final_position === null || row.final_position === undefined
            ? null
            : toNumber(row.final_position),
          finalSelectionReason: (row.selection_reason as string | null) ?? null,
          assessmentStage: (row.stage as string | null) ?? null,
          submissionStatus: String(row.submission_status),
          openManualReviewReasons: row.open_flag_codes ? String(row.open_flag_codes).split('|') : [],
          disqualification:
            dqStatus && row.dq_reason_code
              ? {
                  status: dqStatus,
                  reasonCode: String(row.dq_reason_code),
                  reasonDetail: (row.dq_reason_detail as string | null) ?? '',
                }
              : null,
          productUrl: (row.product_url as string | null) ?? null,
          loomUrl: (row.loom_url as string | null) ?? null,
          deckUrl: (row.deck_url as string | null) ?? null,
          hasUploadedDeck: Boolean(row.has_uploaded_deck),
          categoryScores: jobId ? (scoresByJob.get(jobId) ?? {}) : {},
          feedbackStatus: ((row.feedback_status as string | null) ?? 'pending') as FeedbackStatus,
          feedbackError: (row.feedback_error as string | null) ?? null,
          feedbackAttempts: toNumber(row.feedback_attempts, 0),
          feedback: row.feedback_id
            ? mapFeedback({
                id: row.feedback_id,
                submission_id: row.f_submission_id,
                product_summary: row.product_summary,
                strengths: row.strengths,
                improvements: row.improvements,
                bugs: row.bugs,
                next_seven_day_plan: row.next_seven_day_plan,
                is_exposed_to_participant: row.is_exposed_to_participant,
                generated_at: row.generated_at,
                model_version: row.model_version,
                prompt_version: row.prompt_version,
              })
            : null,
        };
      });
    },

    /**
     * Every submission of the cohort, for the all-submissions audit.
     *
     * The base statement starts from `submissions` and left-joins everything
     * else, so a product with no job, no scores or no feedback is still a row.
     * The per-job stage records (preflight, artifact analysis, test plan,
     * browser runs, evidence, scores) and the per-submission flags come back
     * in one `= any($1)` fetch each and are regrouped in memory — the same
     * shape as `collectRankable`, for the same reason.
     *
     * Nothing here reads `submission_credentials`, an evidence path, a trace
     * path or a prompt; the row type has nowhere to put them.
     */
    async listSubmissionAudit(cohortId) {
      const { rows: baseRows } = await db.query<Record<string, unknown>>(
        `select c.id as cohort_id, c.name as cohort_name, c.code as cohort_code,
                c.assessment_config,
                s.id as submission_id, s.status::text as submission_status,
                s.product_name, s.product_url, s.loom_url, s.deck_url, s.login_required,
                s.created_at as submission_created_at,
                t.group_number,
                i.title as idea_title, i.slug as idea_slug,
                j.id as job_id, j.stage::text as stage, j.attempt_count, j.max_attempts,
                j.last_error, j.started_at, j.completed_at, j.updated_at as job_updated_at,
                j.feedback_status, j.feedback_error, j.feedback_attempts,
                sm.total_score as summary_total, sm.mean_confidence as summary_mean,
                sm.min_confidence as summary_min, sm.low_confidence, sm.risks,
                snap.generated_at as ranking_generated_at,
                e.rank, e.total_score as entry_total, e.in_shortlist,
                e.mean_confidence as entry_mean,
                fs.position as final_position, fs.selection_reason,
                f.id as feedback_id, f.submission_id as f_submission_id,
                f.product_summary, f.strengths, f.improvements, f.bugs,
                f.next_seven_day_plan, f.is_exposed_to_participant, f.generated_at,
                f.model_version, f.prompt_version,
                (
                  select d.status::text from disqualifications d
                   where d.submission_id = s.id
                   order by d.created_at desc limit 1
                ) as dq_status,
                (
                  select d.reason_code::text from disqualifications d
                   where d.submission_id = s.id
                   order by d.created_at desc limit 1
                ) as dq_reason_code,
                (
                  select d.reason_detail from disqualifications d
                   where d.submission_id = s.id
                   order by d.created_at desc limit 1
                ) as dq_reason_detail
           from submissions s
           join cohorts c on c.id = s.cohort_id
           left join teams t on t.id = s.team_id
           left join cohort_ideas i on i.id = s.idea_id
           left join assessment_jobs j on j.submission_id = s.id
           left join assessment_summaries sm on sm.job_id = j.id
           left join ranking_snapshots snap on snap.cohort_id = s.cohort_id and snap.is_current
           left join ranking_entries e on e.snapshot_id = snap.id and e.submission_id = s.id
           left join final_selections fs
                  on fs.cohort_id = s.cohort_id and fs.submission_id = s.id
           left join feedback_reports f on f.submission_id = s.id
          where s.cohort_id = $1
          order by t.group_number, s.created_at`,
        [cohortId],
      );
      if (baseRows.length === 0) return [];

      // Exactly one row per submission, whatever the joins did.
      const seen = new Set<string>();
      const rows = baseRows.filter((row) => {
        const id = String(row.submission_id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const submissionIds = rows.map((r) => String(r.submission_id));
      const jobIds = rows.map((r) => r.job_id).filter((id): id is string => typeof id === 'string');

      const byJob = async <T,>(sql: string): Promise<Map<string, T[]>> => {
        const map = new Map<string, T[]>();
        if (jobIds.length === 0) return map;
        const { rows: found } = await db.query<Record<string, unknown>>(sql, [jobIds]);
        for (const row of found) {
          const key = String(row.job_id);
          const list = map.get(key) ?? [];
          list.push(row as T);
          map.set(key, list);
        }
        return map;
      };

      const [scoreRows, preflightRows, artifactRows, planRows, runRows, evidenceRows] = await Promise.all([
        byJob<Record<string, unknown>>(
          `select job_id, category_key, raw_score, max_points, confidence, is_overridden
             from category_scores where job_id = any($1::uuid[])`,
        ),
        byJob<Record<string, unknown>>(
          `select job_id, check_key, status::text as status, attempt_number,
                  failure_class::text as failure_class, detail
             from preflight_checks where job_id = any($1::uuid[])
            order by attempt_number, checked_at`,
        ),
        byJob<Record<string, unknown>>(
          `select job_id, deck_page_count, deck_text_extracted, video_analysis_limited,
                  video_limitation_reason, injection_flags
             from artifact_analyses where job_id = any($1::uuid[])
            order by created_at desc`,
        ),
        byJob<Record<string, unknown>>(
          `select job_id, step_count, validation_status::text as validation_status, rejected_steps
             from test_plans where job_id = any($1::uuid[])
            order by created_at desc`,
        ),
        byJob<Record<string, unknown>>(
          `select r.job_id, r.attempt, r.viewport::text as viewport, r.status::text as status,
                  r.timed_out, r.duration_ms,
                  (select count(*) from browser_test_steps x where x.run_id = r.id) as steps_total,
                  (select count(*) from browser_test_steps x
                    where x.run_id = r.id and x.status = 'passed') as steps_passed,
                  (select count(*) from browser_test_steps x
                    where x.run_id = r.id and x.status = 'failed') as steps_failed,
                  (select count(*) from browser_test_steps x
                    where x.run_id = r.id and x.status = 'error') as steps_errored,
                  exists (
                    select 1 from browser_test_steps x
                     where x.run_id = r.id and x.action = 'navigate' and x.status = 'passed'
                  ) as navigation_passed,
                  (
                    select x.step_index from browser_test_steps x
                     where x.run_id = r.id and x.status in ('failed', 'error')
                     order by x.step_index limit 1
                  ) as first_failure_index,
                  (
                    select x.action from browser_test_steps x
                     where x.run_id = r.id and x.status in ('failed', 'error')
                     order by x.step_index limit 1
                  ) as first_failure_action,
                  (
                    select x.error_message from browser_test_steps x
                     where x.run_id = r.id and x.status in ('failed', 'error')
                     order by x.step_index limit 1
                  ) as first_failure_error
             from browser_test_runs r where r.job_id = any($1::uuid[])
            order by r.attempt, r.started_at`,
        ),
        byJob<Record<string, unknown>>(
          `select job_id, count(*) as evidence_count
             from assessment_evidence where job_id = any($1::uuid[]) group by job_id`,
        ),
      ]);

      const { rows: flagRows } = await db.query<Record<string, unknown>>(
        `select submission_id, reason_code, detail, raised_by::text as raised_by, status::text as status,
                resolved_at, resolution_note, created_at
           from manual_review_flags where submission_id = any($1::uuid[])
          order by created_at`,
        [submissionIds],
      );
      const flagsBySubmission = new Map<string, AuditManualReviewFlag[]>();
      for (const row of flagRows) {
        const key = String(row.submission_id);
        const list = flagsBySubmission.get(key) ?? [];
        list.push({
          reasonCode: String(row.reason_code),
          detail: String(row.detail ?? ''),
          status: String(row.status) as AuditManualReviewFlag['status'],
          raisedBy: String(row.raised_by),
          createdAt: toDate(row.created_at) ?? new Date(0),
          resolvedAt: toDate(row.resolved_at),
          resolutionNote: (row.resolution_note as string | null) ?? null,
        });
        flagsBySubmission.set(key, list);
      }

      return rows.map((row): SubmissionAuditRow => {
        const jobId = typeof row.job_id === 'string' ? row.job_id : null;
        const config = parseJson<{ lowConfidenceThreshold?: unknown }>(row.assessment_config, {});
        const threshold =
          typeof config.lowConfidenceThreshold === 'number' ? config.lowConfidenceThreshold : null;

        const categoryScores: SubmissionAuditRow['categoryScores'] = {};
        for (const score of jobId ? (scoreRows.get(jobId) ?? []) : []) {
          categoryScores[String(score.category_key) as RubricCategoryKey] = {
            rawScore: toNumber(score.raw_score),
            maxPoints: toNumber(score.max_points),
            confidence: toNumber(score.confidence),
            isOverridden: Boolean(score.is_overridden),
          };
        }

        let preflight: SubmissionAuditRow['preflight'] = null;
        const checks = jobId ? (preflightRows.get(jobId) ?? []) : [];
        if (checks.length > 0) {
          const attempt = Math.max(...checks.map((c) => toNumber(c.attempt_number)));
          preflight = {
            attempt,
            checks: checks
              .filter((c) => toNumber(c.attempt_number) === attempt)
              .map((c): AuditPreflightCheck => {
                const detail = parseJson<{ message?: unknown }>(c.detail, {});
                return {
                  checkKey: String(c.check_key),
                  status: String(c.status) as AuditPreflightCheck['status'],
                  failureClass: String(c.failure_class) as AuditPreflightCheck['failureClass'],
                  message: typeof detail.message === 'string' ? detail.message : null,
                };
              }),
          };
        }

        const artifact = jobId ? artifactRows.get(jobId)?.[0] : undefined;
        const plan = jobId ? planRows.get(jobId)?.[0] : undefined;
        const dqStatus = (row.dq_status as 'proposed' | 'confirmed' | 'reversed' | null) ?? null;

        return {
          cohortId: String(row.cohort_id),
          cohortName: String(row.cohort_name),
          cohortCode: String(row.cohort_code),
          submissionId: String(row.submission_id),
          groupNumber: toNumber(row.group_number),
          productName: (row.product_name as string | null) ?? null,
          ideaTitle: (row.idea_title as string | null) ?? null,
          ideaSlug: (row.idea_slug as string | null) ?? null,
          submissionStatus: String(row.submission_status),
          loginRequired: Boolean(row.login_required),
          productUrl: (row.product_url as string | null) ?? null,
          loomUrl: (row.loom_url as string | null) ?? null,
          deckUrl: (row.deck_url as string | null) ?? null,
          lowConfidenceThreshold: threshold,
          job: jobId
            ? {
                id: jobId,
                stage: String(row.stage),
                attemptCount: toNumber(row.attempt_count),
                maxAttempts: toNumber(row.max_attempts),
                lastError: (row.last_error as string | null) ?? null,
                startedAt: toDate(row.started_at),
                completedAt: toDate(row.completed_at),
                updatedAt: toDate(row.job_updated_at),
              }
            : null,
          preflight,
          artifactAnalysis: artifact
            ? {
                deckPageCount:
                  artifact.deck_page_count === null || artifact.deck_page_count === undefined
                    ? null
                    : toNumber(artifact.deck_page_count),
                deckTextExtracted: Boolean(artifact.deck_text_extracted),
                videoAnalysisLimited: Boolean(artifact.video_analysis_limited),
                videoLimitationReason: (artifact.video_limitation_reason as string | null) ?? null,
                injectionFlagCount: parseJson<unknown[]>(artifact.injection_flags, []).length,
              }
            : null,
          testPlan: plan
            ? {
                stepCount: toNumber(plan.step_count),
                validationStatus: String(plan.validation_status),
                rejectedStepCount: parseJson<unknown[]>(plan.rejected_steps, []).length,
              }
            : null,
          browserRuns: (jobId ? (runRows.get(jobId) ?? []) : []).map(
            (r): AuditBrowserRun => ({
              attempt: toNumber(r.attempt),
              viewport: String(r.viewport),
              status: String(r.status) as AuditBrowserRun['status'],
              timedOut: Boolean(r.timed_out),
              durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : toNumber(r.duration_ms),
              stepsTotal: toNumber(r.steps_total),
              stepsPassed: toNumber(r.steps_passed),
              stepsFailed: toNumber(r.steps_failed),
              stepsErrored: toNumber(r.steps_errored),
              navigationPassed: Boolean(r.navigation_passed),
              firstFailure:
                r.first_failure_index === null || r.first_failure_index === undefined
                  ? null
                  : {
                      stepIndex: toNumber(r.first_failure_index),
                      action: String(r.first_failure_action ?? ''),
                      errorMessage: (r.first_failure_error as string | null) ?? null,
                    },
            }),
          ),
          evidenceCount: jobId ? toNumber(evidenceRows.get(jobId)?.[0]?.evidence_count) : 0,
          categoryScores,
          summary:
            row.summary_total === null || row.summary_total === undefined
              ? null
              : {
                  totalScore: toNumber(row.summary_total),
                  meanConfidence: toNumber(row.summary_mean),
                  minConfidence: toNumber(row.summary_min),
                  lowConfidence: Boolean(row.low_confidence),
                  riskCount: parseJson<unknown[]>(row.risks, []).length,
                },
          manualReviewFlags: flagsBySubmission.get(String(row.submission_id)) ?? [],
          disqualification:
            dqStatus && row.dq_reason_code
              ? {
                  status: dqStatus,
                  reasonCode: String(row.dq_reason_code),
                  reasonDetail: (row.dq_reason_detail as string | null) ?? '',
                }
              : null,
          ranking:
            row.rank === null || row.rank === undefined
              ? null
              : {
                  rank: toNumber(row.rank),
                  totalScore: toNumber(row.entry_total),
                  inShortlist: Boolean(row.in_shortlist),
                  meanConfidence: toNumber(row.entry_mean),
                },
          rankingGeneratedAt: toDate(row.ranking_generated_at),
          finalPosition:
            row.final_position === null || row.final_position === undefined ? null : toNumber(row.final_position),
          finalSelectionReason: (row.selection_reason as string | null) ?? null,
          feedbackStatus: ((row.feedback_status as string | null) ?? 'pending') as FeedbackStatus,
          feedbackError: (row.feedback_error as string | null) ?? null,
          feedbackAttempts: toNumber(row.feedback_attempts, 0),
          feedback: row.feedback_id
            ? mapFeedback({
                id: row.feedback_id,
                submission_id: row.f_submission_id,
                product_summary: row.product_summary,
                strengths: row.strengths,
                improvements: row.improvements,
                bugs: row.bugs,
                next_seven_day_plan: row.next_seven_day_plan,
                is_exposed_to_participant: row.is_exposed_to_participant,
                generated_at: row.generated_at,
                model_version: row.model_version,
                prompt_version: row.prompt_version,
              })
            : null,
        };
      });
    },
  };
}

// --------------------------------------------------------------------------

/**
 * Gather what can be ranked.
 *
 * One statement per relation rather than a join producing a row per score: a
 * 500-submission cohort with eight categories each would otherwise return
 * 4,000 rows to be regrouped in memory.
 */
async function collectRankable(tx: SqlClient, cohortId: string): Promise<RankableSubmission[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `select s.id as submission_id,
            s.status,
            j.id as job_id,
            exists (
              select 1 from disqualifications d
               where d.submission_id = s.id and d.status = 'confirmed'
            ) as disqualified,
            (
              select count(*) from manual_review_flags f
               where f.submission_id = s.id and f.status = 'open'
            ) as open_flags
       from submissions s
       left join assessment_jobs j on j.submission_id = s.id
      where s.cohort_id = $1`,
    [cohortId],
  );
  if (rows.length === 0) return [];

  const jobIds = rows.map((r) => r.job_id).filter((id): id is string => typeof id === 'string');
  const scoreRows =
    jobIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await tx.query<Record<string, unknown>>(
          `select job_id, category_key, weighted_score, confidence
             from category_scores where job_id = any($1::uuid[])`,
          [jobIds],
        );

  const byJob = new Map<string, { categoryKey: string; weightedScore: number; confidence: number }[]>();
  for (const row of scoreRows.rows) {
    const jobId = String(row.job_id);
    const list = byJob.get(jobId) ?? [];
    list.push({
      categoryKey: String(row.category_key),
      weightedScore: toNumber(row.weighted_score),
      confidence: toNumber(row.confidence),
    });
    byJob.set(jobId, list);
  }

  const rankable: RankableSubmission[] = [];
  for (const row of rows) {
    const jobId = typeof row.job_id === 'string' ? row.job_id : null;
    const scores = jobId ? (byJob.get(jobId) ?? []) : [];

    // Every category must be present. A partial total is not a lower score, it
    // is an unfinished assessment, and ranking it would penalise a team for the
    // system's own gap.
    const hasCompleteScores = scores.length === RUBRIC_CATEGORIES.length;

    if (
      !isEligibleForRanking({
        submissionStatus: String(row.status),
        hasConfirmedDisqualification: Boolean(row.disqualified),
        hasCompleteScores,
      })
    ) {
      continue;
    }

    const meanConfidence =
      scores.reduce((sum, s) => sum + s.confidence, 0) / (scores.length || 1);

    rankable.push({
      submissionId: String(row.submission_id),
      scores: scores.map((s) => ({
        categoryKey: s.categoryKey as RankableSubmission['scores'][number]['categoryKey'],
        weightedScore: s.weightedScore,
      })),
      unresolvedRiskCount: toNumber(row.open_flags),
      meanConfidence,
    });
  }

  return rankable;
}

function mapSnapshot(row: Record<string, unknown>): RankingSnapshot {
  return {
    ...mapRow<RankingSnapshot>(row),
    eligibleCount: toNumber(row.eligible_count),
    shortlistTarget: toNumber(row.shortlist_target),
    generatedAt: toDate(row.generated_at) ?? new Date(),
  };
}

function mapEntry(row: Record<string, unknown>): RankingEntry {
  return {
    id: String(row.id),
    snapshotId: String(row.snapshot_id),
    submissionId: String(row.submission_id),
    rank: toNumber(row.rank),
    totalScore: toNumber(row.total_score),
    tiebreakVector: parseJson(row.tiebreak_vector, {}),
    inShortlist: Boolean(row.in_shortlist),
    meanConfidence: toNumber(row.mean_confidence),
  };
}

function mapFinalSelection(row: Record<string, unknown>): FinalSelection {
  return {
    ...mapRow<FinalSelection>(row),
    position: toNumber(row.position),
    selectedAt: toDate(row.selected_at) ?? new Date(),
  };
}
