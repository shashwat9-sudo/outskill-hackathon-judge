/**
 * What the system concluded, and who is allowed to change it.
 *
 * Evidence, scores, summaries, feedback, manual review and disqualification.
 * Three rules shape the SQL here:
 *
 *   **Nothing is destroyed.** An override keeps the model's original score in
 *   its own column (ADR-012); a reversal keeps the disqualification row and its
 *   reason. A record that can be rewritten cannot answer "why did this team not
 *   make the shortlist", which is the one question that will actually be asked.
 *
 *   **Missing evidence is a value.** `stance = 'missing'` is a first-class row.
 *   Storing only what was found would make "we could not open the deck"
 *   indistinguishable from "the deck was bad".
 *
 *   **Disqualification is narrow.** The reason code is constrained by the
 *   database to eleven permitted grounds (ADR-017). "Low score", "buggy" and
 *   "we suspect AI" are not representable, so no amount of prompt drift can
 *   introduce them.
 */

import type {
  AssessmentEvidence,
  AssessmentSummary,
  CategoryScore,
  ConsistencyReview,
  Disqualification,
  FeedbackReport,
  ManualReviewFlag,
} from '../../types';
import type { AssessmentStore } from '../../store';
import { RowNotFoundError, type SqlDatabase } from '../client';
import { json, mapRow, parseJson, toDate, toNumber } from '../rows';
import { getMaxPoints } from '../../../rubric/index';
import { isPermittedDisqualificationReason } from '../../../domain/disqualification';

export type JudgmentMethods = Pick<
  AssessmentStore,
  | 'saveEvidence'
  | 'listEvidence'
  | 'saveScores'
  | 'listScores'
  | 'overrideScore'
  | 'saveSummary'
  | 'getSummary'
  | 'saveConsistencyReview'
  | 'saveFeedbackReport'
  | 'getFeedbackReport'
  | 'raiseManualReview'
  | 'resolveManualReview'
  | 'supersedeSystemManualReview'
  | 'listManualReviewFlags'
  | 'proposeDisqualification'
  | 'confirmDisqualification'
  | 'reverseDisqualification'
  | 'listDisqualifications'
>;

export function buildJudgmentMethods(db: SqlDatabase): JudgmentMethods {
  return {
    /**
     * Record evidence for a job.
     *
     * Replaces the job's evidence in one transaction rather than appending,
     * because a re-scored job would otherwise carry both readings and every
     * downstream count would double. The delete and the insert are atomic: a
     * crash between them would leave a scored job with no evidence, which reads
     * as "scored on nothing".
     */
    async supersedeSystemManualReview(submissionId, note) {
      /*
       * `raised_by = 'system'` is the whole distinction.
       *
       * System flags are observations from one attempt and are recomputed by
       * the next. An admin flag is a decision, and a decision does not expire
       * because a machine ran again.
       */
      const { rowCount } = await db.query(
        `update manual_review_flags
            set status = 'resolved',
                resolved_by = 'system',
                resolved_at = now(),
                resolution_note = $2
          where submission_id = $1
            and status = 'open'
            and raised_by = 'system'`,
        [submissionId, note],
      );
      return rowCount ?? 0;
    },

    async saveEvidence(jobId, evidence) {
      await db.transaction(async (tx) => {
        await tx.query('delete from assessment_evidence where job_id = $1', [jobId]);
        for (const item of evidence) {
          await tx.query(
            `insert into assessment_evidence
               (job_id, category_key, evidence_type, stance, summary, source_ref, confidence)
             values ($1, $2, $3::evidence_source, $4::evidence_stance, $5, $6::jsonb, $7)`,
            [
              jobId,
              item.categoryKey,
              item.evidenceType,
              item.stance,
              item.summary,
              json(item.sourceRef ?? {}),
              clampConfidence(item.confidence),
            ],
          );
        }
      });
    },

    async listEvidence(jobId) {
      const { rows } = await db.query(
        'select * from assessment_evidence where job_id = $1 order by category_key, created_at',
        [jobId],
      );
      return rows.map(mapEvidence);
    },

    /**
     * Write the category scores.
     *
     * `max_points` comes from the rubric here rather than from the caller. The
     * caller is downstream of a model, and a model that returned `maxPoints: 40`
     * for a 25-point category would silently reweight the whole competition —
     * the database check only enforces `raw <= max`, not that `max` is right.
     *
     * An existing override is preserved. Re-running scoring must not quietly
     * discard a human's decision; that is the one write here that a person made
     * deliberately.
     */
    async saveScores(jobId, scores) {
      await db.transaction(async (tx) => {
        for (const score of scores) {
          const maxPoints = getMaxPoints(score.categoryKey);
          const raw = Math.min(Math.max(0, score.rawScore), maxPoints);

          await tx.query(
            `insert into category_scores
               (job_id, category_key, raw_score, max_points, weighted_score, confidence,
                rationale, supporting_evidence, contradictory_evidence, missing_evidence,
                model_version, prompt_version, rubric_version)
             values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
             on conflict (job_id, category_key) do update set
                raw_score = case when category_scores.is_overridden
                                 then category_scores.raw_score else excluded.raw_score end,
                weighted_score = case when category_scores.is_overridden
                                 then category_scores.weighted_score else excluded.weighted_score end,
                original_raw_score = case when category_scores.is_overridden
                                 then category_scores.original_raw_score else null end,
                max_points = excluded.max_points,
                confidence = excluded.confidence,
                rationale = excluded.rationale,
                supporting_evidence = excluded.supporting_evidence,
                contradictory_evidence = excluded.contradictory_evidence,
                missing_evidence = excluded.missing_evidence,
                model_version = excluded.model_version,
                prompt_version = excluded.prompt_version,
                rubric_version = excluded.rubric_version,
                updated_at = now()`,
            [
              jobId,
              score.categoryKey,
              raw,
              maxPoints,
              raw,
              clampConfidence(score.confidence),
              score.rationale ?? '',
              json(score.supportingEvidence ?? []),
              json(score.contradictoryEvidence ?? []),
              json(score.missingEvidence ?? []),
              score.modelVersion,
              score.promptVersion,
              score.rubricVersion,
            ],
          );
        }
      });
    },

    async listScores(jobId) {
      const { rows } = await db.query(
        'select * from category_scores where job_id = $1 order by category_key',
        [jobId],
      );
      return rows.map(mapScore);
    },

    /**
     * A human changes one score.
     *
     * `original_raw_score` is filled only on the first override, via `coalesce`
     * — a second override must still point at what the model said, not at the
     * first human's figure. Otherwise two corrections would erase the machine's
     * answer entirely and the audit trail would describe a conversation between
     * humans about a number nobody could still see.
     *
     * The reason is required by a database constraint, not merely by this code.
     */
    async overrideScore(input) {
      const reason = input.reason.trim();
      if (!reason) throw new Error('An override needs a reason.');

      const maxPoints = getMaxPoints(input.categoryKey as never);
      const raw = Math.min(Math.max(0, input.rawScore), maxPoints);

      const { rows } = await db.query(
        `update category_scores
            set original_raw_score = coalesce(original_raw_score, raw_score),
                raw_score = $3,
                weighted_score = $3,
                is_overridden = true,
                override_reason = $4,
                overridden_by = $5,
                overridden_at = now(),
                updated_at = now()
          where job_id = $1 and category_key = $2
        returning *`,
        [input.jobId, input.categoryKey, raw, reason, input.actor],
      );

      const row = rows[0];
      if (!row) throw new RowNotFoundError('category score', `${input.jobId}/${input.categoryKey}`);
      return mapScore(row);
    },

    /**
     * Store the summary.
     *
     * The total is recomputed from the stored category scores rather than
     * trusted from the caller. A summary whose total disagrees with its own
     * breakdown is the kind of defect that survives review, because both halves
     * look plausible in isolation — and it is the total that decides rank.
     */
    async saveSummary(summary) {
      return db.transaction(async (tx) => {
        const { rows: scoreRows } = await tx.query<Record<string, unknown>>(
          `select coalesce(sum(weighted_score), 0) as total,
                  coalesce(avg(confidence), 0) as mean_confidence,
                  coalesce(min(confidence), 0) as min_confidence,
                  count(*) as scored
             from category_scores where job_id = $1`,
          [summary.jobId],
        );
        const agg = scoreRows[0] ?? {};
        const scored = toNumber(agg.scored);

        // With nothing scored, the honest total is zero *and* the confidence is
        // zero — which is what marks it low-confidence for review rather than
        // presenting a zero-scoring product.
        const total = scored === 0 ? 0 : Math.min(100, toNumber(agg.total));
        const meanConfidence = scored === 0 ? 0 : clampConfidence(toNumber(agg.mean_confidence));
        const minConfidence = scored === 0 ? 0 : clampConfidence(toNumber(agg.min_confidence));

        const { rows } = await tx.query(
          `insert into assessment_summaries
             (job_id, total_score, mean_confidence, min_confidence, low_confidence,
              risks, strengths, weaknesses, internal_notes, bugs_found,
              model_version, prompt_version, completed_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11, $12, $13)
           on conflict (job_id) do update set
              total_score = excluded.total_score,
              mean_confidence = excluded.mean_confidence,
              min_confidence = excluded.min_confidence,
              low_confidence = excluded.low_confidence,
              risks = excluded.risks,
              strengths = excluded.strengths,
              weaknesses = excluded.weaknesses,
              internal_notes = excluded.internal_notes,
              bugs_found = excluded.bugs_found,
              model_version = excluded.model_version,
              prompt_version = excluded.prompt_version,
              completed_at = excluded.completed_at
           returning *`,
          [
            summary.jobId,
            total,
            meanConfidence,
            minConfidence,
            summary.lowConfidence,
            json(summary.risks ?? []),
            json(summary.strengths ?? []),
            json(summary.weaknesses ?? []),
            summary.internalNotes ?? null,
            json(summary.bugsFound ?? []),
            summary.modelVersion,
            summary.promptVersion,
            summary.completedAt ?? null,
          ],
        );
        return mapSummary(rows[0]!);
      });
    },

    async getSummary(jobId) {
      const { rows } = await db.query('select * from assessment_summaries where job_id = $1', [
        jobId,
      ]);
      return rows[0] ? mapSummary(rows[0]) : null;
    },

    /**
     * Record a second-pass review.
     *
     * Appended, because the point of a consistency review is the comparison
     * between passes. Overwriting would leave the adjusted score with no record
     * of what it was adjusted from.
     */
    async saveConsistencyReview(review) {
      const { rows } = await db.query(
        `insert into consistency_reviews
           (job_id, trigger_reason, pass_number, score_delta, adjusted, detail, reviewed_at)
         values ($1, $2::text[], $3, $4, $5, $6::jsonb, $7)
         returning *`,
        [
          review.jobId,
          review.triggerReason ?? [],
          review.passNumber,
          review.scoreDelta,
          review.adjusted,
          json(review.detail ?? {}),
          review.reviewedAt ?? new Date(),
        ],
      );
      return mapConsistencyReview(rows[0]!);
    },

    /**
     * Store the team's feedback report.
     *
     * `is_exposed_to_participant` is forced false on write. Whether teams ever
     * see this is a decision for Outskill to take deliberately, and a default
     * that could be flipped by a caller passing `true` is not a decision — it
     * is an accident waiting for one careless call site.
     */
    async saveFeedbackReport(report) {
      const { rows } = await db.query(
        `insert into feedback_reports
           (submission_id, product_summary, strengths, improvements, bugs,
            next_seven_day_plan, is_exposed_to_participant, model_version, prompt_version)
         values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, false, $7, $8)
         on conflict (submission_id) do update set
            product_summary = excluded.product_summary,
            strengths = excluded.strengths,
            improvements = excluded.improvements,
            bugs = excluded.bugs,
            next_seven_day_plan = excluded.next_seven_day_plan,
            model_version = excluded.model_version,
            prompt_version = excluded.prompt_version,
            generated_at = now()
         returning *`,
        [
          report.submissionId,
          report.productSummary ?? '',
          json(report.strengths ?? []),
          json(report.improvements ?? []),
          json(report.bugs ?? []),
          json(report.nextSevenDayPlan ?? []),
          report.modelVersion,
          report.promptVersion,
        ],
      );
      return mapFeedback(rows[0]!);
    },

    async getFeedbackReport(submissionId) {
      const { rows } = await db.query('select * from feedback_reports where submission_id = $1', [
        submissionId,
      ]);
      return rows[0] ? mapFeedback(rows[0]) : null;
    },

    /**
     * Flag something for a human.
     *
     * Manual review is a legitimate outcome, not a failed job. A submission
     * whose product could not be reached, or whose evidence contradicts itself,
     * has not been judged badly — it has not been judged, and saying so is the
     * correct result.
     *
     * One open flag per reason per submission: re-raising the same concern on a
     * retry should not produce five identical rows for a reviewer to work
     * through.
     */
    async raiseManualReview(flag) {
      const existing = await db.query(
        `select * from manual_review_flags
          where submission_id = $1 and reason_code = $2 and status = 'open'
          limit 1`,
        [flag.submissionId, flag.reasonCode],
      );
      if (existing.rows[0]) return mapManualReview(existing.rows[0]);

      const { rows } = await db.query(
        `insert into manual_review_flags
           (submission_id, reason_code, detail, raised_by, status,
            resolved_by, resolved_at, resolution_note)
         values ($1, $2, $3, $4::actor_type, $5::review_status, $6, $7, $8)
         returning *`,
        [
          flag.submissionId,
          flag.reasonCode,
          flag.detail ?? '',
          flag.raisedBy ?? 'system',
          flag.status ?? 'open',
          flag.resolvedBy ?? null,
          flag.resolvedAt ?? null,
          flag.resolutionNote ?? null,
        ],
      );
      return mapManualReview(rows[0]!);
    },

    async resolveManualReview(flagId, resolution) {
      const { rowCount } = await db.query(
        `update manual_review_flags
            set status = $2::review_status,
                resolved_by = $3,
                resolved_at = now(),
                resolution_note = $4
          where id = $1 and status = 'open'`,
        [flagId, resolution.status, resolution.actor, resolution.note],
      );
      if (rowCount === 0) throw new RowNotFoundError('open manual review flag', flagId);
    },

    async listManualReviewFlags(cohortId) {
      const { rows } = await db.query(
        `select f.*, t.group_number
           from manual_review_flags f
           join submissions s on s.id = f.submission_id
           join teams t on t.id = s.team_id
          where s.cohort_id = $1
          order by f.status = 'open' desc, f.created_at desc`,
        [cohortId],
      );
      return rows.map((row) => ({
        ...mapManualReview(row),
        groupNumber: toNumber(row.group_number),
      }));
    },

    /**
     * Propose a disqualification.
     *
     * The reason code is checked here and again by the database. Both layers
     * matter: this one produces a comprehensible error, and the constraint
     * means a code outside the eleven grounds cannot be stored even by a
     * caller that skipped this path (ADR-017).
     *
     * `proposed` is where a machine's involvement ends. Nothing here confirms.
     */
    async proposeDisqualification(input) {
      if (!isPermittedDisqualificationReason(input.reasonCode)) {
        throw new Error(
          `"${input.reasonCode}" is not one of the permitted disqualification grounds.`,
        );
      }

      // Re-proposing the same ground must not stack duplicate rows in front of
      // a reviewer who has already seen it.
      const existing = await db.query(
        `select * from disqualifications
          where submission_id = $1 and reason_code = $2 and status = 'proposed'
          limit 1`,
        [input.submissionId, input.reasonCode],
      );
      if (existing.rows[0]) return mapDisqualification(existing.rows[0]);

      const { rows } = await db.query(
        `insert into disqualifications
           (submission_id, reason_code, reason_detail, evidence, status, proposed_by)
         values ($1, $2, $3, $4::jsonb, 'proposed', $5::actor_type)
         returning *`,
        [
          input.submissionId,
          input.reasonCode,
          input.reasonDetail ?? '',
          json(input.evidence ?? {}),
          input.proposedBy ?? 'system',
        ],
      );
      return mapDisqualification(rows[0]!);
    },

    /** Only a human reaches this. There is no system call path to it (ADR-017). */
    async confirmDisqualification(id, actor) {
      const { rows } = await db.query(
        `update disqualifications
            set status = 'confirmed', confirmed_by = $2, updated_at = now()
          where id = $1 and status = 'proposed'
        returning *`,
        [id, actor],
      );
      const row = rows[0];
      if (!row) throw new RowNotFoundError('proposed disqualification', id);
      return mapDisqualification(row);
    },

    /**
     * Reverse a disqualification.
     *
     * The row survives with its original reason intact. Deleting it would erase
     * the fact that a team was disqualified and reinstated, which is precisely
     * the history someone will need if the decision is questioned.
     */
    async reverseDisqualification(id, actor, reason) {
      const trimmed = reason.trim();
      if (!trimmed) throw new Error('Reversing a disqualification needs a reason.');

      const { rows } = await db.query(
        `update disqualifications
            set status = 'reversed', reversed_by = $2, reversed_reason = $3, updated_at = now()
          where id = $1 and status in ('proposed', 'confirmed')
        returning *`,
        [id, actor, trimmed],
      );
      const row = rows[0];
      if (!row) throw new RowNotFoundError('disqualification', id);
      return mapDisqualification(row);
    },

    async listDisqualifications(cohortId) {
      const { rows } = await db.query(
        `select d.* from disqualifications d
           join submissions s on s.id = d.submission_id
          where s.cohort_id = $1
          order by d.created_at desc`,
        [cohortId],
      );
      return rows.map(mapDisqualification);
    },
  };
}

// --------------------------------------------------------------------------

/** Confidence is a probability. A value outside [0,1] would fail the column check. */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function mapEvidence(row: Record<string, unknown>): AssessmentEvidence {
  return {
    ...mapRow<AssessmentEvidence>(row),
    sourceRef: parseJson(row.source_ref, {}),
    confidence: toNumber(row.confidence),
    createdAt: toDate(row.created_at) ?? new Date(),
  };
}

function mapScore(row: Record<string, unknown>): CategoryScore {
  return {
    ...mapRow<CategoryScore>(row),
    rawScore: toNumber(row.raw_score),
    maxPoints: toNumber(row.max_points),
    weightedScore: toNumber(row.weighted_score),
    confidence: toNumber(row.confidence),
    supportingEvidence: parseJson(row.supporting_evidence, []),
    contradictoryEvidence: parseJson(row.contradictory_evidence, []),
    missingEvidence: parseJson(row.missing_evidence, []),
    originalRawScore: row.original_raw_score === null ? null : toNumber(row.original_raw_score),
    overriddenAt: toDate(row.overridden_at),
    createdAt: toDate(row.created_at) ?? new Date(),
    updatedAt: toDate(row.updated_at) ?? new Date(),
  };
}

function mapSummary(row: Record<string, unknown>): AssessmentSummary {
  return {
    ...mapRow<AssessmentSummary>(row),
    totalScore: toNumber(row.total_score),
    meanConfidence: toNumber(row.mean_confidence),
    minConfidence: toNumber(row.min_confidence),
    risks: parseJson(row.risks, []),
    strengths: parseJson(row.strengths, []),
    weaknesses: parseJson(row.weaknesses, []),
    bugsFound: parseJson(row.bugs_found, []),
    completedAt: toDate(row.completed_at),
  };
}

function mapConsistencyReview(row: Record<string, unknown>): ConsistencyReview {
  return {
    ...mapRow<ConsistencyReview>(row),
    triggerReason: (row.trigger_reason as ConsistencyReview['triggerReason']) ?? [],
    passNumber: toNumber(row.pass_number),
    scoreDelta: toNumber(row.score_delta),
    detail: parseJson(row.detail, {}),
    reviewedAt: toDate(row.reviewed_at) ?? new Date(),
  };
}

function mapFeedback(row: Record<string, unknown>): FeedbackReport {
  return {
    ...mapRow<FeedbackReport>(row),
    strengths: parseJson(row.strengths, []),
    improvements: parseJson(row.improvements, []),
    bugs: parseJson(row.bugs, []),
    nextSevenDayPlan: parseJson(row.next_seven_day_plan, []),
    generatedAt: toDate(row.generated_at) ?? new Date(),
  };
}

function mapManualReview(row: Record<string, unknown>): ManualReviewFlag {
  return {
    ...mapRow<ManualReviewFlag>(row),
    resolvedAt: toDate(row.resolved_at),
    createdAt: toDate(row.created_at) ?? new Date(),
  };
}

function mapDisqualification(row: Record<string, unknown>): Disqualification {
  return {
    ...mapRow<Disqualification>(row),
    evidence: parseJson(row.evidence, {}),
    createdAt: toDate(row.created_at) ?? new Date(),
    updatedAt: toDate(row.updated_at) ?? new Date(),
  };
}
